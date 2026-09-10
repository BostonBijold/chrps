"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, Nfc, Search } from "lucide-react";
import Header from "@/components/Header";
import { formatRelativeTime } from "@/lib/format-relative-time";
import ManageChrpDetailSheet, { type ChrpTag } from "@/components/ManageChrpDetailSheet";

interface Props {
  userName: string;
  skipAuth: boolean;
}

// Manager-only "Manage Ch'rps" screen — every physical NFC tag ("Ch'rp",
// this app's product name for one) claimed for this location: what it's
// labeled, what it's bound to, when it was claimed, and when it was last
// actually scanned. A third "Manage" entry point alongside
// components/ManageTasksView.tsx and components/ManageInventoryView.tsx —
// see docs/features/nfc.md's "Manage Ch'rps". Unlike those two, this
// screen has nothing to CREATE (a Ch'rp is claimed by binding it to a task
// or item elsewhere — see docs/features/nfc.md's "Claiming" — not from
// here), so there's no "+ Add" affordance, just the list itself.
export default function ManageNfcTagsView({ userName, skipAuth }: Props) {
  const router = useRouter();
  const [tags, setTags] = useState<ChrpTag[] | null>(null);
  const [openUid, setOpenUid] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetch("/api/nfc-tags")
      .then((r) => (r.ok ? r.json() : []))
      .then(setTags)
      .catch(() => setTags([]));
  }, []);

  const q = search.trim().toLowerCase();

  const { active, retired } = useMemo(() => {
    const filtered = (tags ?? []).filter(
      (t) => q === "" || (t.label ?? "").toLowerCase().includes(q) || t.uid.includes(q)
    );
    return {
      active: filtered.filter((t) => t.status === "claimed"),
      retired: filtered.filter((t) => t.status === "retired"),
    };
  }, [tags, q]);

  const openTag = openUid ? (tags ?? []).find((t) => t.uid === openUid) ?? null : null;

  function handleSaved(updated: ChrpTag) {
    setTags((prev) => (prev ?? []).map((t) => (t.uid === updated.uid ? updated : t)));
  }

  function Row({ tag }: { tag: ChrpTag }) {
    return (
      <button
        type="button"
        onClick={() => setOpenUid(tag.uid)}
        className="w-full flex items-center gap-3 bg-card rounded-card border border-border p-3 text-left hover:bg-card-hover transition-colors min-h-[44px]"
      >
        <div className="w-8 flex items-center justify-center flex-shrink-0">
          <Nfc size={17} className={tag.status === "retired" ? "text-tobacco" : "text-olive"} strokeWidth={1.75} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-body text-sm text-text truncate">{tag.label || tag.uid}</p>
          <p className="font-mono text-[10px] text-dim truncate mt-0.5">
            {tag.boundTo.length === 0
              ? "Not bound to anything"
              : `Bound to ${tag.boundTo.map((b) => b.name).join(", ")}`}
            {" · "}
            {tag.lastUsedAt ? `Last used ${formatRelativeTime(tag.lastUsedAt)}` : "Never used"}
          </p>
        </div>
        {tag.status === "retired" && (
          <span className="flex-shrink-0 font-mono text-[9px] uppercase tracking-widest text-tobacco bg-tobacco/10 px-2 py-1 rounded-pill">
            Retired
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="min-h-dvh bg-bg">
      <div className="mx-auto max-w-mobile px-4 pb-28">
        <Header userName={userName} skipAuth={skipAuth} />

        <div className="mt-4 mb-5 flex items-center gap-2">
          <button
            type="button"
            onClick={() => router.back()}
            className="flex items-center gap-1 text-muted font-body text-sm min-h-[44px]"
            aria-label="Back"
          >
            <ChevronLeft size={16} />
          </button>
          <h1 className="font-heading text-xl text-text">Manage Ch&apos;rps</h1>
        </div>

        <div className="mb-5 flex items-center gap-2 bg-card border border-border rounded-card px-3 py-2">
          <Search size={14} className="text-dim flex-shrink-0" />
          <input
            type="text"
            placeholder="Search by label or UID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 bg-transparent font-body text-sm text-text placeholder:text-dim outline-none"
          />
        </div>

        {tags === null && <p className="text-dim font-mono text-xs text-center py-8">Loading…</p>}

        {tags !== null && tags.length === 0 && (
          <p className="text-dim font-mono text-xs text-center py-8">
            No Ch&apos;rps claimed for this location yet — bind a tag to a task or inventory item
            (&ldquo;Scan to Link&rdquo;) to claim one.
          </p>
        )}

        {tags !== null && tags.length > 0 && active.length === 0 && retired.length === 0 && (
          <p className="text-dim font-mono text-xs text-center py-8">
            No Ch&apos;rps match &ldquo;{search}&rdquo;
          </p>
        )}

        {active.length > 0 && (
          <div className="mb-6">
            <p className="font-mono text-[10px] text-dim uppercase tracking-widest mb-2">
              Active ({active.length})
            </p>
            <div className="space-y-2">
              {active.map((t) => (
                <Row key={t.uid} tag={t} />
              ))}
            </div>
          </div>
        )}

        {retired.length > 0 && (
          <div>
            <p className="font-mono text-[10px] text-dim uppercase tracking-widest mb-2">
              Retired ({retired.length})
            </p>
            <div className="space-y-2">
              {retired.map((t) => (
                <Row key={t.uid} tag={t} />
              ))}
            </div>
          </div>
        )}
      </div>

      {openTag && (
        <ManageChrpDetailSheet tag={openTag} onSaved={handleSaved} onClose={() => setOpenUid(null)} />
      )}
    </div>
  );
}
