"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ListChecks, BarChart3, Users, Package, Nfc, X } from "lucide-react";
import AppIcon from "@/components/AppIcon";
import { TASK_LOG_CHANGED_EVENT } from "@/lib/task-log-events";
import { scanNfcTag } from "@/lib/native/nfc-scan";
import { useNetworkStatus } from "@/components/NetworkStatusProvider";
import { resolveOfflineNfcUid } from "@/lib/offline-nfc-resolver";

// Two tabs per side around the center FAB — see docs/features/team-invites.md
// on why this grew from the previous Tasks | FAB | Analytics shape (renamed
// to Reports, see docs/features/reports.md). The 4th slot (right, after
// Reports) used to be an inert placeholder reserved for a future tab — now
// Inventory, see docs/features/inventory.md.
const LEFT_TABS = [
  { href: "/tasks", label: "Tasks", Icon: ListChecks },
  { href: "/team",  label: "Team",  Icon: Users },
];
const RIGHT_TABS = [
  { href: "/reports",   label: "Reports",   Icon: BarChart3 },
  { href: "/inventory", label: "Par Sheet", Icon: Package },
];

interface ActiveTimer {
  taskId: string;
  date: string;
  startedAt: string;
  pausedSeconds?: number;
  taskName: string;
  taskIcon: string;
  taskType: string;
  projectedMinutes: number;
}

const ACTIVE_TIMER_POLL_MS = 30000;

function fmtClock(totalSeconds: number) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export default function BottomNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { isOnline } = useNetworkStatus();
  const [activeTimer, setActiveTimer] = useState<ActiveTimer | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  // ── Active-timer awareness ──────────────────────────────────────────────────
  // Checked on load, on every route change, immediately whenever a TaskLog
  // mutation happens anywhere in the app (see lib/task-log-events), and on
  // a background poll as a safety net — so the FAB reflects reality without
  // requiring a manual refresh.
  const fetchActiveTimer = useCallback(async () => {
    try {
      const res = await fetch("/api/task-logs/active");
      if (!res.ok) return;
      const data = await res.json();
      setActiveTimer(data.active ? data : null);
    } catch { /* keep previous state; next poll/event will retry */ }
  }, []);

  useEffect(() => {
    fetchActiveTimer();
  }, [pathname, fetchActiveTimer]);

  useEffect(() => {
    const onChanged = () => fetchActiveTimer();
    // Resync immediately on returning to the foreground instead of waiting up
    // to ACTIVE_TIMER_POLL_MS for the next poll — mirrors the pattern used
    // for the live clock below and for TasksView's date-resync.
    const onVisible = () => { if (document.visibilityState === "visible") fetchActiveTimer(); };
    window.addEventListener(TASK_LOG_CHANGED_EVENT, onChanged);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    // Skip the network call while backgrounded — the visibility listener
    // above already covers resyncing the moment it matters again.
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") fetchActiveTimer();
    }, ACTIVE_TIMER_POLL_MS);
    return () => {
      window.removeEventListener(TASK_LOG_CHANGED_EVENT, onChanged);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      clearInterval(poll);
    };
  }, [fetchActiveTimer]);

  // Live clock for the resume pill — wall-clock based like the timer screens
  // themselves, not tick-counting, so it self-corrects after being backgrounded.
  useEffect(() => {
    if (!activeTimer) return;
    const tick = () => setNowTick(Date.now());
    tick();
    const interval = setInterval(tick, 1000);
    const onVisible = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [activeTimer]);

  const handleResumeTimer = () => {
    if (!activeTimer) return;
    const url = `/tasks?resumeTimer=1&date=${activeTimer.date}`;
    if (pathname === "/tasks") {
      router.replace(url);
    } else {
      router.push(url);
    }
  };

  // ── FAB "scan to open" (inert state only — see docs/features/nfc.md's
  // "In-app scan-to-complete binding") ────────────────────────────────────
  // Reads a physical tag's UID, resolves it to whichever task it's bound to
  // (GET /api/tasks/by-nfc-uid), and opens that task the same way the other
  // FAB-driven navigations do (autoStartNext/autoAddTask/autoResumeTimer —
  // see TasksView.tsx's "Handle URL params passed from FAB navigation"
  // effect). This only opens the task — completing it still requires its
  // own Scan NFC step inside TaskFormScreen, same tag, scanned again.
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const scanMessageTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Disambiguation picker — only shown when a scanned uid resolves to more
  // than one active target across TaskDefinition and InventoryItemType (see
  // docs/features/nfc.md's "Multi-target binding"). Holds the uid/localDate
  // from the scan that's already happened so picking an option never
  // triggers a second scan — the same uid is what verifies whichever target
  // gets chosen.
  const [disambiguateOptions, setDisambiguateOptions] = useState<
    Array<{ targetType: "task" | "inventory"; targetId: string; name: string }> | null
  >(null);
  const [disambiguateContext, setDisambiguateContext] = useState<{ uid: string; localDate: string } | null>(null);
  const [disambiguateBusy, setDisambiguateBusy] = useState(false);

  const flashScanMessage = (message: string) => {
    setScanMessage(message);
    if (scanMessageTimeout.current) clearTimeout(scanMessageTimeout.current);
    scanMessageTimeout.current = setTimeout(() => setScanMessage(null), 3000);
  };

  useEffect(() => {
    return () => {
      if (scanMessageTimeout.current) clearTimeout(scanMessageTimeout.current);
    };
  }, []);

  // Navigates based on GET /api/tasks/by-nfc-uid's response, once it's
  // resolved down to a single target — shared by the direct single-match
  // path and the post-disambiguation pick. `"inventory"` opens the item's
  // log-count screen directly, pre-verified — no claimed/already-logged
  // concept applies to an append-only inventory count, unlike a task's
  // three-way split (see docs/features/inventory.md). Task-level claiming
  // (see docs/features/task-lists.md's "Per-task claiming") means a
  // shift-window task and an anytime task now resolve identically — both
  // just "open" the task directly, claiming a pending one exactly like
  // tapping Start Task on its row would.
  const navigateFromResolution = (
    data:
      | { mode: "already-logged"; taskId: string; state: "done" | "missed" | "rest" }
      | { mode: "claimed"; taskId: string; taskListId: string; claimedByName: string }
      | { mode: "open"; taskId: string; taskListId: string }
      | { mode: "inventory"; itemTypeId: string },
    uid: string,
    localDate: string
  ) => {
    if (data.mode === "already-logged") {
      // A tag is permanently tied to exactly one task — rescanning it is
      // never a way to reopen or "continue" that task, only a status
      // check. No navigation, same transient pill other scan outcomes use.
      const message =
        data.state === "done"
          ? "Already completed for today."
          : data.state === "missed"
            ? "Already marked missed for today."
            : "Already marked as rest for today.";
      flashScanMessage(message);
      return;
    }
    if (data.mode === "claimed") {
      // Never bump someone else's active claim — no navigation, just the
      // same transient pill "no task linked"/"scan failed" already uses.
      flashScanMessage(`In progress by ${data.claimedByName} — try again once they finish.`);
      return;
    }

    const url =
      data.mode === "inventory"
        ? `/inventory/${data.itemTypeId}?verifiedNfcUid=${encodeURIComponent(uid)}`
        : `/tasks?openTaskId=${data.taskId}&verifiedNfcUid=${encodeURIComponent(uid)}&date=${localDate}`;
    // Only /tasks needs router.replace's same-route-new-params behavior (see
    // the "Why this effect's dependency array matters" note in
    // docs/features/nfc.md) — an inventory item detail page is a plain
    // fresh mount per item, so push is correct there same as any other
    // non-/tasks destination.
    if (pathname === "/tasks") {
      router.replace(url);
    } else {
      router.push(url);
    }
  };

  const handleScanToOpen = async () => {
    if (scanning) return;
    setScanning(true);
    setScanMessage(null);
    const result = await scanNfcTag();
    if (result.status !== "ok") {
      setScanning(false);
      flashScanMessage(result.status === "unsupported" ? "Open the app on your phone to scan a tag." : result.message);
      return;
    }
    try {
      // Local date, not UTC — matches TasksView's own timezone-correction
      // effect so it doesn't immediately overwrite this with a plain
      // /tasks?date=... redirect before openTaskId gets consumed. Also fed
      // to by-nfc-uid below (along with local minutes-since-midnight) so it
      // can pick the most relevant placement when the same saved task is
      // bound to this tag in more than one list — see
      // lib/task-definitions.ts's resolveMostRelevantPlacement.
      const localDate = new Date().toLocaleDateString("en-CA");
      const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();

      if (!isOnline) {
        // Offline equivalent of the GET below — see
        // docs/features/offline.md's "Offline NFC resolution". Only covers
        // an already-linked tag whose definition was present in the last
        // successful pull sync, and only opens the resolved task directly
        // (no attempt to replicate the online already-logged/session/locked
        // response split below). Multi-target disambiguation isn't
        // replicated offline either — see lib/offline-nfc-resolver.ts.
        const resolved = await resolveOfflineNfcUid(result.uid, localDate, nowMinutes);
        if (!resolved) {
          flashScanMessage("Can't verify this tag while offline.");
          return;
        }
        const url = `/tasks?openTaskId=${resolved.taskId}&verifiedNfcUid=${encodeURIComponent(result.uid)}&date=${localDate}`;
        if (pathname === "/tasks") {
          router.replace(url);
        } else {
          router.push(url);
        }
        return;
      }

      const res = await fetch(
        `/api/tasks/by-nfc-uid?uid=${encodeURIComponent(result.uid)}&date=${localDate}&nowMinutes=${nowMinutes}`
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        flashScanMessage(body.error || "No task is linked to this tag.");
        return;
      }
      const data = (await res.json()) as
        | { mode: "already-logged"; taskId: string; state: "done" | "missed" | "rest" }
        | { mode: "claimed"; taskId: string; taskListId: string; claimedByName: string }
        | { mode: "open"; taskId: string; taskListId: string }
        | { mode: "inventory"; itemTypeId: string }
        | { mode: "disambiguate"; options: Array<{ targetType: "task" | "inventory"; targetId: string; name: string }> };

      if (data.mode === "disambiguate") {
        // This tag identifies more than one target — hand off to the picker
        // instead of navigating. The scan is already done; picking an
        // option below re-resolves with the same uid, no second scan.
        setDisambiguateContext({ uid: result.uid, localDate });
        setDisambiguateOptions(data.options);
        return;
      }

      navigateFromResolution(data, result.uid, localDate);
    } catch {
      flashScanMessage("Something went wrong — try again.");
    } finally {
      setScanning(false);
    }
  };

  const handlePickDisambiguateOption = async (option: { targetType: "task" | "inventory"; targetId: string }) => {
    if (!disambiguateContext || disambiguateBusy) return;
    setDisambiguateBusy(true);
    try {
      const { uid, localDate } = disambiguateContext;
      const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
      const res = await fetch(
        `/api/tasks/by-nfc-uid?uid=${encodeURIComponent(uid)}&date=${localDate}&nowMinutes=${nowMinutes}&targetType=${option.targetType}&targetId=${option.targetId}`
      );
      setDisambiguateOptions(null);
      setDisambiguateContext(null);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        flashScanMessage(body.error || "No task is linked to this tag.");
        return;
      }
      const data = (await res.json()) as
        | { mode: "already-logged"; taskId: string; state: "done" | "missed" | "rest" }
        | { mode: "claimed"; taskId: string; taskListId: string; claimedByName: string }
        | { mode: "open"; taskId: string; taskListId: string }
        | { mode: "inventory"; itemTypeId: string };
      navigateFromResolution(data, uid, localDate);
    } catch {
      setDisambiguateOptions(null);
      setDisambiguateContext(null);
      flashScanMessage("Something went wrong — try again.");
    } finally {
      setDisambiguateBusy(false);
    }
  };

  const elapsedSeconds = activeTimer
    ? (activeTimer.pausedSeconds ?? 0) + Math.floor((nowTick - new Date(activeTimer.startedAt).getTime()) / 1000)
    : 0;
  const isCountdown = !!activeTimer && activeTimer.taskType !== "stopwatch" && activeTimer.projectedMinutes > 0;
  const targetSeconds = isCountdown ? activeTimer!.projectedMinutes * 60 : 0;
  const isOverTarget = isCountdown && elapsedSeconds >= targetSeconds;
  const clockText = activeTimer
    ? isCountdown
      ? isOverTarget
        ? `+${fmtClock(elapsedSeconds - targetSeconds)}`
        : fmtClock(targetSeconds - elapsedSeconds)
      : fmtClock(elapsedSeconds)
    : "";

  return (
    <>
      {/* Nav bar */}
      <nav
        className="fixed bottom-0 left-0 right-0 z-40 bg-card border-t border-border"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="mx-auto max-w-mobile relative">
          {/* Active-timer resume pill — anchored to the FAB's own position
              (not the raw viewport) so it sits right against it regardless
              of safe-area insets, instead of floating at a fixed offset. */}
          {activeTimer && (
            <button
              onClick={handleResumeTimer}
              aria-label={`Resume ${activeTimer.taskName}`}
              className="absolute bottom-[94px] left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 bg-card border border-amber/40 text-text font-mono text-[11px] pl-2.5 pr-3 py-1.5 rounded-pill shadow-lg max-w-[240px] active:opacity-90 transition-opacity"
            >
              <AppIcon name={activeTimer.taskIcon} size={13} className="text-amber flex-shrink-0" />
              <span className="truncate">{activeTimer.taskName}</span>
              <span className={`flex-shrink-0 ${isOverTarget ? "text-burgundy-light" : "text-amber"}`}>
                {clockText}
              </span>
            </button>
          )}

          {/* Scan status pill — same anchor spot as the resume pill above,
              only ever shown when there's no active timer (the two never
              overlap: resuming a running task takes priority over scanning). */}
          {!activeTimer && scanMessage && (
            <div className="absolute bottom-[94px] left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 bg-card border border-olive/40 text-text font-mono text-[11px] px-3 py-1.5 rounded-pill shadow-lg max-w-[240px] text-center">
              {scanMessage}
            </div>
          )}

          {/* FAB — resumes the active timer when one exists; otherwise scans
              a tag and opens whichever task it's bound to. */}
          <button
            onClick={activeTimer ? handleResumeTimer : handleScanToOpen}
            disabled={!activeTimer && scanning}
            aria-label={activeTimer ? `Resume ${activeTimer.taskName}` : "Scan NFC tag to open its task"}
            className={`absolute left-1/2 -translate-x-1/2 -top-6 z-10 w-14 h-14 rounded-full border-4 border-bg shadow-lg flex items-center justify-center transition-all duration-200 disabled:opacity-70 ${
              activeTimer ? "bg-amber" : "bg-olive"
            }`}
          >
            {activeTimer ? (
              <AppIcon name={activeTimer.taskIcon} size={26} className="text-bg relative" />
            ) : (
              <Nfc size={26} strokeWidth={1.75} className={`text-bg relative ${scanning ? "animate-pulse" : ""}`} />
            )}
          </button>

          {/* Tabs */}
          <div>
            <div className="flex items-stretch h-16">
              {LEFT_TABS.map(({ href, label, Icon }) => {
                const active = pathname === href || pathname.startsWith(href + "/");
                return (
                  <Link
                    key={href}
                    href={href}
                    className={`flex-1 flex flex-col items-center justify-center gap-1 transition-colors min-h-[44px] ${
                      active ? "text-olive" : "text-dim hover:text-muted"
                    }`}
                  >
                    <Icon size={20} strokeWidth={active ? 2 : 1.5} />
                    <span className="font-mono text-[9px] uppercase tracking-widest leading-none">
                      {label}
                    </span>
                  </Link>
                );
              })}

              {/* FAB spacer */}
              <div className="w-20 flex-shrink-0" />

              {RIGHT_TABS.map(({ href, label, Icon }) => {
                const active = pathname === href || pathname.startsWith(href + "/");
                return (
                  <Link
                    key={href}
                    href={href}
                    className={`flex-1 flex flex-col items-center justify-center gap-1 transition-colors min-h-[44px] ${
                      active ? "text-olive" : "text-dim hover:text-muted"
                    }`}
                  >
                    <Icon size={20} strokeWidth={active ? 2 : 1.5} />
                    <span className="font-mono text-[9px] uppercase tracking-widest leading-none">
                      {label}
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      </nav>

      {/* Disambiguation picker — a scanned tag resolved to more than one
          active target (see docs/features/nfc.md's "Multi-target binding").
          Tapping an option re-resolves with the same already-scanned uid,
          so it opens pre-verified — no second scan. */}
      {disambiguateOptions && (
        <>
          <div
            className="fixed inset-0 bg-black/60 z-40"
            onClick={() => { setDisambiguateOptions(null); setDisambiguateContext(null); }}
          />
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
            <div className="w-full sm:max-w-mobile sm:mx-5 bg-card rounded-t-2xl sm:rounded-2xl overflow-hidden flex flex-col">
              <div className="flex items-center gap-3 px-5 pt-5 pb-4 border-b border-border flex-shrink-0">
                <div className="flex-1 min-w-0">
                  <h2 className="font-heading text-base text-text">This tag is bound to more than one thing</h2>
                  <p className="font-body text-xs text-muted mt-1">Which one do you mean?</p>
                </div>
                <button
                  onClick={() => { setDisambiguateOptions(null); setDisambiguateContext(null); }}
                  className="w-8 h-8 flex items-center justify-center text-dim flex-shrink-0"
                  aria-label="Close"
                >
                  <X size={18} />
                </button>
              </div>
              <div className="p-3 space-y-1">
                {disambiguateOptions.map((option) => (
                  <button
                    key={`${option.targetType}-${option.targetId}`}
                    onClick={() => handlePickDisambiguateOption(option)}
                    disabled={disambiguateBusy}
                    className="w-full text-left px-3 py-3.5 rounded-card font-body text-sm text-text hover:bg-card-hover transition-colors min-h-[44px] disabled:opacity-40"
                  >
                    {option.name}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
