"use client";

import { useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Package, Nfc, X } from "lucide-react";
import { scanNfcTag } from "@/lib/native/nfc-scan";
import { claimNfcTag } from "@/lib/client/claim-nfc-tag";

interface ItemType {
  _id: string;
  name: string;
  unit: string | null;
  parLevel: number | null;
  nfcTagUid: string | null;
  nfcRequiredToLog: boolean;
  entryMode: "text" | "stepper";
  groupId: string | null;
  currentCount: number | null;
}

interface Group {
  _id: string;
  name: string;
}

export interface UpdatedItemType {
  _id: string;
  name: string;
  unit: string | null;
  parLevel: number | null;
  nfcTagUid: string | null;
  nfcRequiredToLog: boolean;
  entryMode: "text" | "stepper";
  groupId: string | null;
}

interface Props {
  itemType: ItemType;
  groups: Group[];
  // "Save Changes" — persists name/unit/parLevel/group/nfcRequiredToLog and
  // closes the sheet, same as ManageTaskDetailSheet's edit-then-close flow.
  onSaved: (updated: UpdatedItemType) => void;
  // Tag bind/unbind — syncs the parent list's row (so its "Synced"/"Required"
  // meta stays current) WITHOUT closing the sheet, since scanning a tag and
  // then flipping nfcRequiredToLog in the same visit is the common path.
  onTagChanged: (updated: UpdatedItemType) => void;
  onArchived: () => void;
  onClose: () => void;
}

// Full item-type editor for components/ManageInventoryView.tsx's "Manage
// Inventory" hub — name/unit/parLevel/group, NFC tag sync (bind/unbind),
// and the nfcRequiredToLog toggle, all in one place a manager can return to
// any time, rather than only reachable through the log-count detail screen
// (components/InventoryItemDetailView.tsx, which still has its own copy of
// this same editing panel for in-context convenience). Same bottom-sheet
// shape as ManageTaskDetailSheet.tsx.
export default function ManageInventoryDetailSheet({ itemType, groups, onSaved, onTagChanged, onArchived, onClose }: Props) {
  const [name, setName] = useState(itemType.name);
  const [unit, setUnit] = useState(itemType.unit ?? "");
  const [parLevel, setParLevel] = useState(itemType.parLevel !== null ? String(itemType.parLevel) : "");
  const [groupId, setGroupId] = useState<string | null>(itemType.groupId);
  const [nfcRequiredToLog, setNfcRequiredToLog] = useState(itemType.nfcRequiredToLog);
  const [entryMode, setEntryMode] = useState<"text" | "stepper">(itemType.entryMode);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [nfcTagUid, setNfcTagUid] = useState<string | null>(itemType.nfcTagUid);
  const [bindBusy, setBindBusy] = useState(false);
  const [bindError, setBindError] = useState<string | null>(null);
  const [alsoBoundTo, setAlsoBoundTo] = useState<Array<{ name: string; locationName: string | null }>>([]);
  // Set when a bind attempt comes back 409 { reason: "unclaimed" } — see
  // docs/features/nfc.md's "Claiming". Mirrors
  // lib/client/use-task-definition-panel.ts's identical pattern.
  const [unclaimedUid, setUnclaimedUid] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);

  const [archiving, setArchiving] = useState(false);
  const [confirmingArchive, setConfirmingArchive] = useState(false);

  const dirty =
    name.trim() !== itemType.name ||
    (unit.trim() || null) !== itemType.unit ||
    (parLevel.trim() ? Number(parLevel) : null) !== itemType.parLevel ||
    groupId !== itemType.groupId ||
    nfcRequiredToLog !== itemType.nfcRequiredToLog ||
    entryMode !== itemType.entryMode;

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/inventory-item-types/${itemType._id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          unit: unit.trim() || null,
          parLevel: parLevel.trim() ? Number(parLevel) : null,
          groupId,
          nfcRequiredToLog,
          entryMode,
        }),
      });
      if (!res.ok) throw new Error("Failed to save");
      const updated = await res.json();
      onSaved(updated);
    } catch {
      setSaveError("Failed to save — try again.");
    } finally {
      setSaving(false);
    }
  };

  async function bindUid(uid: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/inventory-item-types/${itemType._id}/nfc-tag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setUnclaimedUid(body.reason === "unclaimed" ? uid : null);
        setBindError(body.error || "Failed to bind tag");
        return false;
      }
      const body = await res.json();
      setNfcTagUid(uid);
      setAlsoBoundTo(body.alsoBoundTo ?? []);
      setUnclaimedUid(null);
      onTagChanged({ ...itemType, name, unit: unit.trim() || null, parLevel: parLevel.trim() ? Number(parLevel) : null, groupId, nfcRequiredToLog, entryMode, nfcTagUid: uid });
      return true;
    } catch (err) {
      setUnclaimedUid(null);
      setBindError(err instanceof Error ? err.message : "Failed to bind tag");
      return false;
    }
  }

  async function handleScanToLink() {
    setBindError(null);
    setUnclaimedUid(null);
    if (!Capacitor.isNativePlatform()) {
      setBindError("Open the app on your phone to scan a tag.");
      return;
    }
    setBindBusy(true);
    const result = await scanNfcTag();
    if (result.status !== "ok") {
      setBindBusy(false);
      setBindError(result.status === "unsupported" ? "NFC isn't available on this device." : result.message);
      return;
    }
    await bindUid(result.uid);
    setBindBusy(false);
  }

  // Claims unclaimedUid for this manager's own location, then retries the
  // same bind — see docs/features/nfc.md's "Claiming".
  async function handleClaimAndLink() {
    if (!unclaimedUid) return;
    setClaiming(true);
    setBindError(null);
    const claimResult = await claimNfcTag(unclaimedUid);
    if (!claimResult.ok) {
      setBindError(claimResult.error);
      setClaiming(false);
      return;
    }
    await bindUid(unclaimedUid);
    setClaiming(false);
  }

  async function handleUnbindTag() {
    setBindBusy(true);
    setBindError(null);
    try {
      const res = await fetch(`/api/inventory-item-types/${itemType._id}/nfc-tag`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to unbind tag");
      setNfcTagUid(null);
      setAlsoBoundTo([]);
      onTagChanged({ ...itemType, name, unit: unit.trim() || null, parLevel: parLevel.trim() ? Number(parLevel) : null, groupId, nfcRequiredToLog, entryMode, nfcTagUid: null });
    } catch (err) {
      setBindError(err instanceof Error ? err.message : "Failed to unbind tag");
    } finally {
      setBindBusy(false);
    }
  }

  const handleArchive = async () => {
    if (!confirmingArchive) {
      setConfirmingArchive(true);
      return;
    }
    setArchiving(true);
    await fetch(`/api/inventory-item-types/${itemType._id}`, { method: "DELETE" });
    onArchived();
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-40" onClick={onClose} />

      <div className="fixed bottom-0 left-0 right-0 z-50 max-w-mobile mx-auto">
        <div className="bg-card rounded-t-modal max-h-[85vh] flex flex-col">
          <div className="flex justify-center pt-3 pb-1 flex-shrink-0">
            <div className="w-10 h-1 rounded-full bg-border-light" />
          </div>

          <div className="flex items-center justify-between px-4 pb-3 flex-shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 flex items-center justify-center flex-shrink-0">
                <Package size={18} className="text-muted" strokeWidth={1.75} />
              </div>
              <div className="min-w-0">
                <h2 className="font-heading text-lg text-text truncate">{itemType.name}</h2>
                <p className="font-mono text-[10px] text-dim mt-0.5">
                  {itemType.currentCount !== null ? `${itemType.currentCount}${itemType.unit ? ` ${itemType.unit}` : ""}` : "Not yet logged"}
                </p>
              </div>
            </div>
            <button onClick={onClose} className="text-dim min-h-[44px] min-w-[44px] flex items-center justify-end flex-shrink-0" aria-label="Close">
              <X size={18} />
            </button>
          </div>

          <div className="px-4 pb-8 overflow-y-auto space-y-4">
            <div className="space-y-1.5">
              <label className="font-mono text-[10px] text-dim uppercase tracking-widest">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full bg-bg border border-border rounded-card px-3 py-2.5 font-body text-sm text-text outline-none focus:border-border-light"
              />
            </div>

            <div className="flex gap-3">
              <div className="flex-1 space-y-1.5">
                <label className="font-mono text-[10px] text-dim uppercase tracking-widest">Unit</label>
                <input
                  type="text"
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                  placeholder="e.g. rolls"
                  className="w-full bg-bg border border-border rounded-card px-3 py-2.5 font-body text-sm text-text placeholder:text-dim outline-none focus:border-border-light"
                />
              </div>
              <div className="flex-1 space-y-1.5">
                <label className="font-mono text-[10px] text-dim uppercase tracking-widest">Par Level</label>
                <input
                  type="number"
                  inputMode="decimal"
                  value={parLevel}
                  onChange={(e) => setParLevel(e.target.value)}
                  placeholder="Optional"
                  className="w-full bg-bg border border-border rounded-card px-3 py-2.5 font-mono text-sm text-text placeholder:text-dim outline-none focus:border-border-light"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="font-mono text-[10px] text-dim uppercase tracking-widest">Group</label>
              <select
                value={groupId ?? ""}
                onChange={(e) => setGroupId(e.target.value || null)}
                className="w-full bg-bg border border-border rounded-card px-3 py-2.5 font-body text-sm text-text outline-none focus:border-border-light"
              >
                <option value="">Ungrouped</option>
                {groups.map((g) => (
                  <option key={g._id} value={g._id}>{g.name}</option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="font-mono text-[10px] text-dim uppercase tracking-widest">Log Entry UI</label>
              <div className="flex bg-bg border border-border rounded-card p-1 gap-1">
                <button
                  type="button"
                  onClick={() => setEntryMode("text")}
                  className={`flex-1 py-2 rounded-[8px] font-body text-sm transition-colors min-h-[36px] ${
                    entryMode === "text" ? "bg-olive text-text" : "text-dim"
                  }`}
                >
                  Text / Number
                </button>
                <button
                  type="button"
                  onClick={() => setEntryMode("stepper")}
                  className={`flex-1 py-2 rounded-[8px] font-body text-sm transition-colors min-h-[36px] ${
                    entryMode === "stepper" ? "bg-olive text-text" : "text-dim"
                  }`}
                >
                  +/- Buttons
                </button>
              </div>
              <p className="font-mono text-[10px] text-dim">
                How employees enter a new count on this item&apos;s log screen.
              </p>
            </div>

            {saveError && <p className="font-mono text-xs text-burgundy-light">{saveError}</p>}

            <button
              onClick={handleSave}
              disabled={!name.trim() || saving || !dirty}
              className="w-full bg-olive text-text font-body font-medium py-3 rounded-card min-h-[44px] disabled:opacity-40 transition-opacity"
            >
              {saving ? "Saving…" : "Save Changes"}
            </button>

            {/* NFC tag sync — bind/unbind this item's physical storage-
                location tag. See docs/features/nfc.md's "Multi-target
                binding" and docs/features/inventory.md's "NFC enforcement". */}
            <div className="pt-3 border-t border-border">
              <p className="font-mono text-[10px] uppercase tracking-widest text-dim mb-1.5 flex items-center gap-1.5">
                <Nfc size={11} strokeWidth={1.75} />
                Location Tag
              </p>
              {nfcTagUid ? (
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-olive flex-1 truncate">
                    Bound · {nfcTagUid}
                  </span>
                  <button
                    type="button"
                    onClick={handleUnbindTag}
                    disabled={bindBusy}
                    className="font-mono text-[11px] text-burgundy-light px-2 py-1 disabled:opacity-40"
                  >
                    Unbind
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={handleScanToLink}
                  disabled={bindBusy}
                  className="font-mono text-[11px] text-olive border border-olive/30 bg-olive/10 px-3 py-1.5 rounded-pill disabled:opacity-40"
                >
                  {bindBusy ? "Hold near tag…" : "Scan to Sync Tag"}
                </button>
              )}
              {bindError && (
                <p className="font-mono text-[11px] text-burgundy-light mt-1.5">{bindError}</p>
              )}
              {unclaimedUid && (
                <button
                  type="button"
                  onClick={handleClaimAndLink}
                  disabled={claiming}
                  className="font-mono text-[11px] text-olive border border-olive/30 bg-olive/10 px-3 py-1.5 rounded-pill disabled:opacity-40 mt-1.5"
                >
                  {claiming ? "Claiming…" : "Claim this tag for your location"}
                </button>
              )}
              {alsoBoundTo.length > 0 && (
                <p className="font-mono text-[11px] text-dim mt-1.5">
                  Also bound to:{" "}
                  {alsoBoundTo
                    .map((b) => (b.locationName ? `${b.name} (${b.locationName})` : b.name))
                    .join(", ")}
                </p>
              )}

              <label className="flex items-center gap-2 mt-3 pt-3 border-t border-border cursor-pointer">
                <input
                  type="checkbox"
                  checked={nfcRequiredToLog}
                  onChange={(e) => setNfcRequiredToLog(e.target.checked)}
                  className="w-4 h-4"
                />
                <span className="font-body text-[12px] text-text">Require NFC scan to log a count</span>
              </label>
              {nfcRequiredToLog && !nfcTagUid && (
                <p className="font-mono text-[11px] text-dim mt-1">
                  No tag bound yet — no one can log a count until one is.
                </p>
              )}
            </div>

            <div className="pt-3 border-t border-border flex items-center justify-end">
              <button
                onClick={handleArchive}
                disabled={archiving}
                className="font-mono text-[10px] text-burgundy-light uppercase tracking-widest disabled:opacity-50"
              >
                {archiving ? "Archiving…" : confirmingArchive ? "Confirm Archive" : "Archive Item Type"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
