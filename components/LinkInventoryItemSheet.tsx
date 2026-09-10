"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";

interface ItemType {
  _id: string;
  name: string;
  unit: string | null;
}

interface Props {
  excludeItemTypeIds: string[];
  busy: boolean;
  onPick: (itemTypeId: string) => void;
  onClose: () => void;
}

// Picker over the company's active InventoryItemTypes, for
// TaskListEditView.tsx's "Linked Inventory" panel — see
// docs/features/inventory.md's "Task ↔ Inventory Linking". Same modal
// pattern as TeamMemberActionSheet.tsx. Already-linked item types are
// excluded rather than shown disabled, since picking
// one to update `required` happens via the panel's own toggle, not here.
export default function LinkInventoryItemSheet({ excludeItemTypeIds, busy, onPick, onClose }: Props) {
  const [itemTypes, setItemTypes] = useState<ItemType[] | null>(null);

  useEffect(() => {
    fetch("/api/inventory-item-types")
      .then((r) => (r.ok ? r.json() : []))
      .then(setItemTypes)
      .catch(() => setItemTypes([]));
  }, []);

  const available = (itemTypes ?? []).filter((it) => !excludeItemTypeIds.includes(it._id));

  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-40" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
        <div className="w-full sm:max-w-mobile sm:mx-5 bg-card rounded-t-2xl sm:rounded-2xl overflow-hidden flex flex-col max-h-[80vh]">
          <div className="flex items-center gap-3 px-5 pt-5 pb-4 border-b border-border flex-shrink-0">
            <div className="flex-1 min-w-0">
              <h2 className="font-heading text-base text-text truncate">Link Inventory Item</h2>
            </div>
            <button onClick={onClose} className="w-8 h-8 flex items-center justify-center text-dim flex-shrink-0" aria-label="Close">
              <X size={18} />
            </button>
          </div>

          <div className="overflow-y-auto">
            {itemTypes === null && (
              <p className="text-dim font-mono text-xs text-center py-8">Loading…</p>
            )}
            {itemTypes !== null && available.length === 0 && (
              <p className="text-dim font-body text-sm text-center py-8 px-5">
                {itemTypes.length === 0
                  ? "No item types yet — add one from the Inventory tab first."
                  : "Every item type is already linked to this task."}
              </p>
            )}
            <div className="p-3 space-y-1">
              {available.map((it) => (
                <button
                  key={it._id}
                  type="button"
                  disabled={busy}
                  onClick={() => onPick(it._id)}
                  className="w-full flex items-center justify-between gap-3 text-left px-3 py-3.5 rounded-card font-body text-sm text-text hover:bg-card-hover transition-colors min-h-[44px] disabled:opacity-40"
                >
                  <span className="truncate">{it.name}</span>
                  {it.unit && <span className="font-mono text-[10px] text-dim flex-shrink-0">{it.unit}</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
