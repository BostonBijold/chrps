"use client";

import type { InventoryLink } from "@/lib/client/use-inventory-links";

// Linked Inventory panel — see docs/features/inventory.md's "Task ↔
// Inventory Linking". Shared between TaskListEditView.tsx's SortableRow
// (Task Lists tab) and ManageTaskDetailSheet.tsx (Task Catalog tab), backed
// by lib/client/use-inventory-links.ts's useInventoryLinks hook — see
// docs/features/unified-task-edit-surface.md. `onAdd` just opens the
// caller's own LinkInventoryItemSheet picker (kept as the caller's concern
// since it needs its own excludeItemTypeIds/open state).
export default function LinkedInventoryPanel({
  links,
  busyId,
  error,
  onAdd,
  onToggleRequired,
  onRemove,
}: {
  links: InventoryLink[] | null;
  busyId: string | null;
  error: string | null;
  onAdd: () => void;
  onToggleRequired: (itemTypeId: string, required: boolean) => void;
  onRemove: (itemTypeId: string) => void;
}) {
  return (
    <div className="pt-3 border-t border-border">
      <p className="font-mono text-[10px] uppercase tracking-widest text-dim mb-1.5">Linked Inventory</p>
      {links === null ? (
        <p className="font-mono text-[11px] text-dim">Loading…</p>
      ) : links.length === 0 ? (
        <p className="font-mono text-[11px] text-dim">Nothing linked yet.</p>
      ) : (
        <div className="space-y-1.5">
          {links.map((link) => (
            <div key={link.itemTypeId} className="flex items-center gap-2">
              <span className="font-mono text-[11px] text-text flex-1 truncate">{link.name}</span>
              <button
                type="button"
                onClick={() => onToggleRequired(link.itemTypeId, !link.required)}
                disabled={busyId === link.itemTypeId}
                className={`font-mono text-[10px] uppercase tracking-widest px-2 py-1 rounded-pill disabled:opacity-40 ${
                  link.required ? "bg-olive/15 text-olive" : "bg-card-hover text-muted"
                }`}
              >
                {link.required ? "Required" : "Optional"}
              </button>
              <button
                type="button"
                onClick={() => onRemove(link.itemTypeId)}
                disabled={busyId === link.itemTypeId}
                className="font-mono text-[11px] text-burgundy-light px-2 py-1 disabled:opacity-40"
              >
                Unlink
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={onAdd}
        className="mt-2 font-mono text-[11px] text-olive border border-olive/30 bg-olive/10 px-3 py-1.5 rounded-pill"
      >
        + Add Item
      </button>
      {error && <p className="font-mono text-[11px] text-burgundy-light mt-1.5">{error}</p>}
    </div>
  );
}
