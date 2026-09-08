"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Capacitor } from "@capacitor/core";
import { ChevronLeft, Minus, Nfc, Pencil, Plus, TriangleAlert } from "lucide-react";
import Header from "@/components/Header";
import ManageInventoryDetailSheet from "@/components/ManageInventoryDetailSheet";
import { scanNfcTag } from "@/lib/native/nfc-scan";
import { playNotificationSound, type NotificationSound } from "@/lib/notification-sound";
import { formatRelativeTime } from "@/lib/format-relative-time";

interface ItemType {
  _id: string;
  name: string;
  unit: string | null;
  parLevel: number | null;
  nfcTagUid: string | null;
  nfcRequiredToLog: boolean;
  entryMode: "text" | "stepper";
  groupId: string | null;
}

interface Group {
  _id: string;
  name: string;
}

interface LogEntry {
  _id: string;
  count: number;
  loggedAt: string;
  loggedByName: string;
  verifiedNfcUid: string | null;
}

interface Props {
  userName: string;
  skipAuth: boolean;
  isManager: boolean;
  notificationSound: NotificationSound;
  preVerifiedNfcUid: string | null;
  itemType: ItemType;
}

// Item detail/log screen — see docs/features/inventory.md. Logging a count
// NEVER requires the bound tag (unlike a TaskDefinition's Scan NFC step) —
// "Save" always works with just the typed number; a bound tag is a
// shortcut/verification layer on top, not a gate. `preVerifiedNfcUid`
// (from the FAB's "scan to open" shortcut) pre-satisfies that verification
// the same way TaskFormScreen.tsx's own preVerifiedNfcUid does, one save's
// worth — this page is a fresh mount per scan, so there's no multi-use
// concern to guard against the way TasksView.tsx's shared preVerified state
// has to.
export default function InventoryItemDetailView({
  userName,
  skipAuth,
  isManager,
  notificationSound,
  preVerifiedNfcUid,
  itemType,
}: Props) {
  const router = useRouter();

  // Single mutable copy of this item's editable fields — the edit sheet
  // (ManageInventoryDetailSheet, opened via the header's Edit button below)
  // updates this directly on save, so the log-count controls above it
  // (Save/Save via NFC gating, the count display's unit/par) reflect a
  // binding or nfcRequiredToLog change immediately, no page reload needed.
  const [item, setItem] = useState<ItemType>(itemType);

  const [logs, setLogs] = useState<LogEntry[] | null>(null);

  const fetchLogs = () => {
    fetch(`/api/inventory-logs?itemTypeId=${item._id}&limit=20`)
      .then((r) => r.json())
      .then(setLogs)
      .catch(() => setLogs([]));
  };

  useEffect(() => {
    fetchLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item._id]);

  const currentCount = logs && logs.length > 0 ? logs[0].count : null;
  // Below par: latest logged count <= parLevel — see
  // docs/features/inventory.md's "Par-level alerting".
  const belowPar = item.parLevel !== null && currentCount !== null && currentCount <= item.parLevel;

  // ── Log a new count ───────────────────────────────────────────────────
  const [countInput, setCountInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // The +/- stepper starts from the last logged count (0 if never logged)
  // rather than an empty field — there's nothing to type, so it needs a
  // sensible starting point the first time logs actually load. Only runs
  // once per item, same one-shot-init pattern as ManageInventoryView.tsx's
  // expandedDefaultSet — a later re-log shouldn't snap the field back.
  const stepperInitialized = useRef(false);
  useEffect(() => {
    if (item.entryMode !== "stepper" || stepperInitialized.current || logs === null) return;
    stepperInitialized.current = true;
    setCountInput(String(currentCount ?? 0));
  }, [item.entryMode, logs, currentCount]);

  const adjustStepper = (delta: number) => {
    if (saveError) setSaveError(null);
    setCountInput((prev) => {
      const base = prev.trim() === "" || !Number.isFinite(Number(prev)) ? 0 : Number(prev);
      return String(Math.max(0, base + delta));
    });
  };

  const alreadyVerified = !!preVerifiedNfcUid && !!item.nfcTagUid && preVerifiedNfcUid === item.nfcTagUid;

  const submitLog = async (verifiedNfcUid: string | null) => {
    const count = Number(countInput);
    if (countInput.trim() === "" || !Number.isFinite(count)) {
      setSaveError("Enter a count first");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/inventory-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemTypeId: item._id, count, verifiedNfcUid }),
      });
      if (res.status === 409) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "This item requires an NFC scan to log a count.");
      }
      if (!res.ok) throw new Error("Failed to save");
      if (verifiedNfcUid) playNotificationSound(notificationSound);
      setCountInput("");
      fetchLogs();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save — try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => {
    // Pre-verified from the FAB scan on the way in — save with that uid
    // directly, no second scan (mirrors TaskFormScreen.tsx's alreadyVerified).
    if (alreadyVerified) {
      submitLog(preVerifiedNfcUid);
      return;
    }
    submitLog(null);
  };

  const handleSaveViaNfc = async () => {
    setSaveError(null);
    if (!Capacitor.isNativePlatform()) {
      setSaveError("Open the app on your phone to scan the linked tag.");
      return;
    }
    setScanning(true);
    const result = await scanNfcTag();
    setScanning(false);
    if (result.status === "unsupported") {
      setSaveError("Open the app on your phone to scan the linked tag.");
      return;
    }
    if (result.status === "cancelled") {
      setSaveError(result.message);
      return;
    }
    if (result.uid !== item.nfcTagUid) {
      // When nfcRequiredToLog is false this is never a hard gate — the
      // manual Save button still works, this just means the scan didn't
      // verify anything (see models/InventoryLog.ts). When true, Save
      // itself is hidden, so a wrong scan here really does block logging.
      setSaveError(
        item.nfcRequiredToLog
          ? "That's not this item's linked tag — scan the correct one."
          : "That's not this item's linked tag — saved counts still work without scanning."
      );
      return;
    }
    submitLog(result.uid);
  };

  // ── Manager: edit item type + bind/unbind tag + archive ────────────────
  // All of it now lives in one reused sheet (ManageInventoryDetailSheet —
  // the same editor components/ManageInventoryView.tsx's "Manage Inventory"
  // hub uses), opened from the header's Edit button below instead of a
  // hard-to-find collapsible section at the bottom of the page.
  const [showEditSheet, setShowEditSheet] = useState(false);
  const [groups, setGroups] = useState<Group[]>([]);
  useEffect(() => {
    fetch("/api/inventory-groups")
      .then((r) => (r.ok ? r.json() : []))
      .then(setGroups)
      .catch(() => setGroups([]));
  }, []);

  return (
    <div className="min-h-dvh bg-bg">
      <div className="mx-auto max-w-mobile px-4 pb-28">
        <Header userName={userName} skipAuth={skipAuth} />

        <div className="mt-4 mb-5 flex items-center gap-2">
          <Link href="/inventory" className="flex items-center gap-1 text-muted font-body text-sm min-h-[44px]" aria-label="Back">
            <ChevronLeft size={16} />
          </Link>
          <h1 className="font-heading text-xl text-text truncate flex-1 min-w-0">{item.name}</h1>
          {/* Edit entry point — right where a manager already expects one,
              directly under the header's own profile icon (same column),
              instead of a hard-to-find collapsible section at the bottom of
              the page. Opens ManageInventoryDetailSheet.tsx. */}
          {isManager && (
            <button
              type="button"
              onClick={() => setShowEditSheet(true)}
              aria-label="Edit item type"
              title="Edit item type"
              className="flex-shrink-0 w-9 h-9 flex items-center justify-center text-dim hover:text-olive transition-colors min-h-[44px]"
            >
              <Pencil size={17} strokeWidth={1.75} />
            </button>
          )}
        </div>

        {/* ── Current count ──────────────────────────────────────────────── */}
        <div
          className={`rounded-card border p-5 text-center transition-colors ${
            belowPar ? "bg-burgundy/10 border-burgundy/40" : "bg-card border-border"
          }`}
        >
          <p className={`font-mono text-4xl flex items-center justify-center gap-2 ${belowPar ? "text-burgundy-light" : "text-text"}`}>
            {belowPar && <TriangleAlert size={22} strokeWidth={2} />}
            {/* Below par (or any item with a par level set) shows as a
                current/par fraction — "3/5 rolls" — so it's immediately
                obvious how far off target the count is, not just that it's
                low. See docs/features/inventory.md's "Par-level alerting". */}
            {currentCount !== null ? currentCount : "—"}
            {item.parLevel !== null && <span className="text-dim">/{item.parLevel}</span>}
            {item.unit && <span className="text-lg text-dim ml-1.5">{item.unit}</span>}
          </p>
          <p className="font-mono text-[10px] text-dim uppercase tracking-widest mt-2">
            {logs && logs.length > 0
              ? `Logged ${formatRelativeTime(logs[0].loggedAt)} by ${logs[0].loggedByName}`
              : "Not yet logged"}
          </p>
          {belowPar && (
            <p className="font-mono text-[11px] text-burgundy-light font-medium mt-1.5">
              At or below par — restock soon
            </p>
          )}
        </div>

        {/* ── Log a new count ────────────────────────────────────────────── */}
        <div className="mt-4 space-y-2.5">
          <label className="font-mono text-[10px] text-dim uppercase tracking-widest block">
            Log new count
          </label>
          {item.entryMode === "stepper" ? (
            <div className="flex items-center justify-between gap-3 bg-bg border border-border rounded-card px-3 py-2">
              <button
                type="button"
                onClick={() => adjustStepper(-1)}
                aria-label="Decrease count"
                className="w-11 h-11 flex-shrink-0 flex items-center justify-center rounded-card bg-card border border-border text-text active:bg-card-hover transition-colors"
              >
                <Minus size={18} strokeWidth={2} />
              </button>
              <span className="font-mono text-2xl text-text tabular-nums">
                {countInput.trim() === "" ? "0" : countInput}
                {item.unit && <span className="text-sm text-dim ml-1.5">{item.unit}</span>}
              </span>
              <button
                type="button"
                onClick={() => adjustStepper(1)}
                aria-label="Increase count"
                className="w-11 h-11 flex-shrink-0 flex items-center justify-center rounded-card bg-card border border-border text-text active:bg-card-hover transition-colors"
              >
                <Plus size={18} strokeWidth={2} />
              </button>
            </div>
          ) : (
            <input
              type="number"
              inputMode="decimal"
              value={countInput}
              onChange={(e) => { setCountInput(e.target.value); if (saveError) setSaveError(null); }}
              placeholder={item.unit ? `Count, in ${item.unit}` : "Current count"}
              className="w-full bg-bg border border-border rounded-card px-3 py-3 font-mono text-lg text-text placeholder:text-dim outline-none focus:border-border-light"
            />
          )}

          {alreadyVerified && (
            <p className="font-mono text-[11px] text-olive">Tag verified — Save to log this count</p>
          )}

          <div className="flex gap-2">
            {/* Plain Save (no scan) is hidden — not disabled — once this item
                opts into nfcRequiredToLog, unless a scan already verified it
                on the way in (alreadyVerified). See docs/features/inventory.md's
                "NFC enforcement". */}
            {(!item.nfcRequiredToLog || alreadyVerified) && (
              <button
                onClick={handleSave}
                disabled={saving || scanning}
                className="flex-1 bg-olive text-text font-body font-medium py-3.5 rounded-card min-h-[48px] disabled:opacity-40 transition-opacity"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            )}
            {item.nfcTagUid && !alreadyVerified && (
              <button
                onClick={handleSaveViaNfc}
                disabled={saving || scanning}
                className="flex-1 flex items-center justify-center gap-2 border border-olive/30 bg-olive/10 text-olive font-body font-medium py-3.5 rounded-card min-h-[48px] disabled:opacity-40 transition-opacity"
              >
                <Nfc size={16} strokeWidth={1.75} />
                {scanning ? "Hold near tag…" : "Save via NFC"}
              </button>
            )}
          </div>

          {item.nfcRequiredToLog && !item.nfcTagUid && (
            <p className="font-mono text-[11px] text-burgundy-light">
              This item requires an NFC scan to log a count, but no tag is bound yet — ask a manager to bind one (tap Edit above).
            </p>
          )}

          {saveError && (
            <p className="font-mono text-xs text-burgundy-light">{saveError}</p>
          )}
        </div>

        {/* ── Recent history ─────────────────────────────────────────────── */}
        <p className="font-mono text-[10px] text-dim uppercase tracking-widest mb-3 mt-8">
          Recent History
        </p>
        {logs === null && (
          <p className="text-dim font-mono text-xs text-center py-6">Loading…</p>
        )}
        {logs !== null && logs.length === 0 && (
          <p className="text-dim font-mono text-xs text-center py-6">No counts logged yet.</p>
        )}
        <div className="space-y-1.5">
          {logs?.map((log) => (
            <div key={log._id} className="flex items-center justify-between bg-card rounded-card border border-border px-4 py-3">
              <div>
                <p className="font-mono text-sm text-text">
                  {log.count}{item.unit && <span className="text-dim ml-1">{item.unit}</span>}
                </p>
                <p className="font-mono text-[10px] text-dim mt-0.5">
                  {log.loggedByName} · {formatRelativeTime(log.loggedAt)}
                </p>
              </div>
              {log.verifiedNfcUid && (
                <Nfc size={13} className="text-olive flex-shrink-0" strokeWidth={1.75} />
              )}
            </div>
          ))}
        </div>
      </div>

      {showEditSheet && (
        <ManageInventoryDetailSheet
          itemType={{ ...item, currentCount }}
          groups={groups}
          onSaved={(updated) => {
            setItem(updated);
            setShowEditSheet(false);
            // This page's data comes from the server component in
            // app/(app)/inventory/[itemTypeId]/page.tsx — without this, the
            // Router Cache can keep serving that earlier render (entryMode
            // and every other edited field) if the user navigates away and
            // back, even though the PATCH above already persisted. Same
            // fix LocationSwitcher.tsx uses after its own PATCH.
            router.refresh();
          }}
          onTagChanged={setItem}
          onArchived={() => router.push("/inventory")}
          onClose={() => setShowEditSheet(false)}
        />
      )}
    </div>
  );
}
