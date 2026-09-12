"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { ChevronDown } from "lucide-react";
import { playNotificationSound, type NotificationSound } from "@/lib/notification-sound";

interface Location {
  _id: string;
  name: string;
}

interface LocationContext {
  isOwner: boolean;
  // The page's own switcher/query value — already resolved server-side per
  // each page's own rules (pickActiveLocationId's result for Tasks/Reports/
  // Inventory; the raw sessionUser.activeLocationId, null = "All
  // Locations," for Team). Used as the <select>'s value when the switcher
  // renders, and as the first choice when resolving the static-text name.
  // See docs/features/locations.md's "Location switcher".
  activeLocationId: string | null;
  // This signed-in user's own primary location (User.locationId) — always
  // null for the switcher itself (owner/allowAll concerns only), but the
  // fallback used to resolve a display name for the static-text branch,
  // since Team passes activeLocationId=null for every non-owner while
  // Tasks/Reports/Inventory already fold this value into activeLocationId
  // via pickActiveLocationId.
  locationId: string | null;
  // Team-only: offers "All Locations" as a selectable entry, which PATCHes
  // activeLocationId back to null (today's default, unfiltered roster) —
  // not a separate sentinel value. See docs/features/locations.md's
  // "Location switcher".
  allowAll?: boolean;
  // Called after a successful location switch, in addition to (not instead
  // of) the router.refresh() below — needed by any page whose data comes
  // from a client-side fetch-on-mount rather than server-rendered props
  // (Team's fetchTeam, Inventory's fetchAll). Tasks' data comes from server
  // props, so it passes nothing here.
  onLocationChanged?: () => void;
}

interface Props {
  userName: string;
  skipAuth?: boolean;
  // Location-switcher merge (see docs/features/header-location-switcher.md)
  // — the header's title area shows "which location" instead of the old
  // "Ch'rps" wordmark, replacing the standalone <LocationSwitcher> row that
  // used to render directly beneath this component. Opt-in, passed only by
  // the 4 bottom-nav pages (Tasks, Team, Reports, Inventory), plus Manage
  // Tasks, Manage Ch'rps, and Task List edit (all three location-scoped the
  // same way) — every other Header call site (Profile, Manage Inventory,
  // Inventory item detail, Company Settings) omits it and keeps the plain
  // "Ch'rps" wordmark unchanged, with no extra /api/locations fetch.
  location?: LocationContext;
}

export default function Header({ userName, skipAuth, location }: Props) {
  const router = useRouter();

  // Header is mounted on every page, so it fetches the company's chirp
  // preference itself rather than needing it threaded down through every
  // page's server component — same GET any device uses to know which file
  // to play on an NFC save (see lib/notification-sound.ts, docs/features/nfc.md).
  const [notificationSound, setNotificationSound] = useState<NotificationSound>("standard");
  useEffect(() => {
    fetch("/api/company/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { notificationSound?: NotificationSound } | null) => {
        if (data?.notificationSound) setNotificationSound(data.notificationSound);
      })
      .catch(() => {});
  }, []);

  // Fetched for every role, not just owners, on any page that opts into
  // `location` — a manager/employee needs it too now, to resolve their own
  // location's display NAME for the static-text branch below (previously
  // LocationSwitcher only ever fetched this for an owner, since it
  // rendered nothing otherwise). Skipped entirely on a page that doesn't
  // pass `location` — no reason to hit /api/locations there.
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [saving, setSaving] = useState(false);
  const hasLocation = !!location;
  useEffect(() => {
    // Depend on the boolean, not the `location` object itself — a fresh
    // object literal lands on every parent re-render, which would refetch
    // on every render if this effect depended on `location` directly.
    if (!hasLocation) return;
    fetch("/api/locations")
      .then((r) => (r.ok ? r.json() : []))
      .then(setLocations)
      .catch(() => setLocations([]));
  }, [hasLocation]);

  // Only an owner at a 2+-location company gets an interactive picker —
  // everyone else (manager/employee, or an owner at a single-location
  // company) has nothing to switch to, so the title area is static text.
  const showSwitcher = !!location?.isOwner && !!locations && locations.length >= 2;
  const displayName = location
    ? locations?.find((l) => l._id === (location.activeLocationId ?? location.locationId))?.name ?? null
    : null;

  const handleChange = async (value: string) => {
    if (!location) return;
    const nextLocationId = value === "__all__" ? null : value;
    if (nextLocationId === location.activeLocationId || saving) return;
    setSaving(true);
    try {
      await fetch("/api/session/active-location", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locationId: nextLocationId }),
      });
      router.refresh();
      location.onLocationChanged?.();
    } finally {
      setSaving(false);
    }
  };

  return (
    <header className="fixed top-0 left-0 right-0 z-30 bg-bg border-b border-border" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <div className="mx-auto max-w-mobile px-4 h-16 grid grid-cols-[44px_1fr_auto] items-center">

        {/* Logo — tap to hear the company's chirp */}
        <div className="flex items-center justify-start">
          <button
            type="button"
            onClick={() => playNotificationSound(notificationSound)}
            aria-label="Play chirp"
            className="rounded-full"
          >
            <Image
              src="/logo.jpeg"
              alt="Ch'rps"
              width={38}
              height={38}
              priority
              className="rounded-full object-cover"
            />
          </button>
        </div>

        {/* Title — which location this screen is showing, in place of the
            old "Ch'rps" wordmark (the logo mark above is the only brand
            identifier now); interactive only for an owner at a
            2+-location company. */}
        <div className="text-center min-w-0">
          {showSwitcher ? (
            <div className="relative inline-flex items-center justify-center max-w-full">
              <select
                value={location!.activeLocationId ?? "__all__"}
                onChange={(e) => handleChange(e.target.value)}
                disabled={saving}
                aria-label="Switch location"
                className="appearance-none bg-transparent font-brand font-extrabold text-xl tracking-wide text-olive leading-tight text-center pr-5 pl-1 outline-none disabled:opacity-60 max-w-full truncate"
              >
                {location!.allowAll && <option value="__all__">All Locations</option>}
                {locations!.map((loc) => (
                  <option key={loc._id} value={loc._id}>
                    {loc.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} strokeWidth={2.5} className="text-olive absolute right-0 pointer-events-none" />
            </div>
          ) : (
            <h1 className="font-brand font-extrabold text-xl tracking-wide text-olive leading-tight truncate px-1">
              {displayName ?? "Ch'rps"}
            </h1>
          )}
        </div>

        {/* User avatar */}
        <div className="flex items-center justify-end gap-1">
          {skipAuth ? (
            <div
              className="w-8 h-8 rounded-full border border-dashed border-border-light flex items-center justify-center bg-card"
              title="Dev mode"
            >
              <span className="text-dim text-xs font-mono">D</span>
            </div>
          ) : (
            <Link
              href="/profile"
              className="relative w-8 h-8 rounded-full overflow-hidden border border-border-light flex items-center justify-center bg-card hover:border-muted transition-colors"
              title="Profile"
            >
              <span className="text-muted text-xs font-mono">{userName[0]?.toUpperCase()}</span>
            </Link>
          )}
        </div>

      </div>
    </header>
  );
}
