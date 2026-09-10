"use client";

import { useState } from "react";
import { X, Nfc, Package, ClipboardCheck, Archive, RotateCcw } from "lucide-react";
import { formatRelativeTime } from "@/lib/format-relative-time";

export interface ChrpTag {
  uid: string;
  status: "claimed" | "retired";
  label: string | null;
  claimedAt: string | null;
  claimedByName: string | null;
  lastUsedAt: string | null;
  lastUsedByName: string | null;
  boundTo: Array<{ type: "task" | "inventory"; name: string }>;
}

interface Props {
  tag: ChrpTag;
  onSaved: (updated: ChrpTag) => void;
  onClose: () => void;
}

// Detail sheet for one claimed Ch'rp (this app's product name for a
// physical NFC tag — see components/ManageNfcTagsView.tsx) — label
// editing and Retire/Reactivate, same bottom-sheet shape as
// ManageInventoryDetailSheet.tsx/ManageTaskDetailSheet.tsx. See
// docs/features/nfc.md's "Manage Ch'rps".
export default function ManageChrpDetailSheet({ tag, onSaved, onClose }: Props) {
  const [label, setLabel] = useState(tag.label ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingRetire, setConfirmingRetire] = useState(false);

  const dirty = label.trim() !== (tag.label ?? "");

  async function patch(body: Record<string, unknown>): Promise<boolean> {
    setError(null);
    try {
      const res = await fetch(`/api/nfc-tags/${tag.uid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to save");
      const updated = await res.json();
      onSaved({ ...tag, label: updated.label ?? null, status: updated.status });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
      return false;
    }
  }

  async function handleSaveLabel() {
    setSaving(true);
    await patch({ label: label.trim() || null });
    setSaving(false);
  }

  async function handleToggleStatus() {
    setSaving(true);
    const next = tag.status === "retired" ? "claimed" : "retired";
    await patch({ status: next });
    setSaving(false);
    setConfirmingRetire(false);
  }

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
                <Nfc size={18} className="text-olive" strokeWidth={1.75} />
              </div>
              <div className="min-w-0">
                <h2 className="font-heading text-lg text-text truncate">{tag.label || "Unlabeled Ch'rp"}</h2>
                <p className="font-mono text-[10px] text-dim mt-0.5 truncate">{tag.uid}</p>
              </div>
            </div>
            <button onClick={onClose} className="text-dim min-h-[44px] min-w-[44px] flex items-center justify-end flex-shrink-0" aria-label="Close">
              <X size={18} />
            </button>
          </div>

          <div className="px-4 pb-8 overflow-y-auto space-y-4">
            {tag.status === "retired" && (
              <div className="bg-tobacco/10 border border-tobacco/30 rounded-card px-3 py-2">
                <p className="font-mono text-[11px] text-tobacco">
                  Retired — this tag can no longer complete tasks or log inventory until reactivated.
                </p>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="font-mono text-[10px] text-dim uppercase tracking-widest">Label</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. Walk-in Freezer"
                  maxLength={60}
                  className="flex-1 bg-bg border border-border rounded-card px-3 py-2.5 font-body text-sm text-text outline-none focus:border-border-light"
                />
                <button
                  type="button"
                  onClick={handleSaveLabel}
                  disabled={!dirty || saving}
                  className="flex-shrink-0 bg-olive/15 border border-olive/30 text-olive font-mono text-xs px-3 py-2.5 rounded-pill disabled:opacity-40"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
              <p className="font-mono text-[11px] text-dim">
                Optional — a friendly name shown here and in the tag list instead of the raw UID.
              </p>
            </div>

            <div className="space-y-1.5">
              <p className="font-mono text-[10px] text-dim uppercase tracking-widest">Bound To</p>
              {tag.boundTo.length === 0 ? (
                <p className="font-body text-[13px] text-dim">Not bound to any task or inventory item yet.</p>
              ) : (
                <div className="space-y-1.5">
                  {tag.boundTo.map((b, i) => (
                    <div key={`${b.type}-${b.name}-${i}`} className="flex items-center gap-2 bg-bg rounded-card border border-border px-3 py-2">
                      {b.type === "task" ? (
                        <ClipboardCheck size={13} className="text-muted flex-shrink-0" strokeWidth={1.75} />
                      ) : (
                        <Package size={13} className="text-muted flex-shrink-0" strokeWidth={1.75} />
                      )}
                      <span className="font-body text-[13px] text-text truncate">{b.name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="font-mono text-[11px] text-dim space-y-1">
              <p>
                Claimed {tag.claimedAt ? formatRelativeTime(tag.claimedAt) : "—"}
                {tag.claimedByName ? ` by ${tag.claimedByName}` : ""}
              </p>
              <p>
                Last used {tag.lastUsedAt ? formatRelativeTime(tag.lastUsedAt) : "Never"}
                {tag.lastUsedByName ? ` by ${tag.lastUsedByName}` : ""}
              </p>
            </div>

            {error && <p className="font-mono text-[11px] text-burgundy-light">{error}</p>}

            {confirmingRetire ? (
              <div className="bg-burgundy/10 border border-burgundy/30 rounded-card p-3">
                <p className="font-body text-[13px] text-text mb-3">
                  Retire this Ch&apos;rp? It&apos;ll stop working for scan-to-complete tasks and required
                  inventory logs until someone reactivates it here.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleToggleStatus}
                    disabled={saving}
                    className="flex-1 bg-burgundy/20 border border-burgundy/40 text-burgundy-light font-mono text-xs py-2 rounded-pill disabled:opacity-50"
                  >
                    {saving ? "Retiring…" : "Retire"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingRetire(false)}
                    className="flex-1 bg-bg border border-border text-muted font-mono text-xs py-2 rounded-pill"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => (tag.status === "retired" ? handleToggleStatus() : setConfirmingRetire(true))}
                disabled={saving}
                className={`w-full flex items-center justify-center gap-2 font-mono text-xs py-2.5 rounded-pill border disabled:opacity-50 ${
                  tag.status === "retired"
                    ? "bg-olive/15 border-olive/30 text-olive"
                    : "bg-bg border-border text-muted hover:border-burgundy/40 hover:text-burgundy-light"
                }`}
              >
                {tag.status === "retired" ? (
                  <>
                    <RotateCcw size={13} /> {saving ? "Reactivating…" : "Reactivate"}
                  </>
                ) : (
                  <>
                    <Archive size={13} /> Retire this Ch&apos;rp
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
