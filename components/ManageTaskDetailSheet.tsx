"use client";

import { useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import AppIcon from "@/components/AppIcon";
import NfcBindingPanel, { type TagBinding } from "@/components/task-panels/NfcBindingPanel";
import InstructionsEditorPanel, {
  type InstructionsPanel,
  type InstructionStepView,
} from "@/components/task-panels/InstructionsEditorPanel";
import RequiresPhotoTogglePanel, { type RequiresPhotoToggle } from "@/components/task-panels/RequiresPhotoTogglePanel";
import LinkedInventoryPanel from "@/components/task-panels/LinkedInventoryPanel";
import CoreFieldsEditor from "@/components/task-panels/CoreFieldsEditor";
import type { InventoryLink } from "@/lib/client/use-inventory-links";
import type { FormFieldDef } from "@/models/TaskDefinition";

export type { InstructionStepView };

interface UsedInEntry {
  taskListId: string;
  taskListName: string;
}

// Editable name/icon/form fields/estimated-time block — see
// components/task-panels/CoreFieldsEditor.tsx and
// docs/features/unified-task-edit-surface.md. Only present for a Company
// Task Catalog row (CatalogRow already has this from a Task Lists
// placement row, so a Standalone Tasks sheet doesn't get this prop).
interface CoreEditPanel {
  name: string;
  icon: string;
  formFields: FormFieldDef[];
  projectedMinutes: number;
  onSave: (name: string, icon: string, formFields: FormFieldDef[], projectedMinutes: number) => Promise<void>;
  saving: boolean;
}

interface InventoryLinksPanel {
  links: InventoryLink[] | null;
  busyId: string | null;
  error: string | null;
  onAdd: () => void;
  onToggleRequired: (itemTypeId: string, required: boolean) => void;
  onRemove: (itemTypeId: string) => void;
}

interface Props {
  icon: string;
  name: string;
  meta: string;
  usedIn?: UsedInEntry[];
  coreEdit?: CoreEditPanel;
  tagBinding?: TagBinding;
  instructions?: InstructionsPanel;
  requiresPhotoToggle?: RequiresPhotoToggle;
  inventoryLinks?: InventoryLinksPanel;
  editHref?: string;
  editLabel?: string;
  onDelete: () => void;
  deleteLabel: string;
  deleting: boolean;
  blockedMessage?: string | null;
  onClose: () => void;
}

// Shared detail-on-tap sheet for Manage Tasks' compact rows (Standalone
// Tasks and Company Task Catalog) — reuses AddTaskSheet's bottom-sheet
// presentation so a manager sees the same "used in"/tag-binding/edit/delete
// detail that used to render inline on every card, but only when they
// actually tap in for it. `usedIn`/`tagBinding` are omitted for a
// Standalone Tasks row, which has neither concept at the placement level.
// Every panel below (NFC/Instructions/Require Photo/Linked Inventory) is a
// shared component also rendered inline by TaskListEditView.tsx's
// SortableRow — see docs/features/unified-task-edit-surface.md.
export default function ManageTaskDetailSheet({
  icon,
  name,
  meta,
  usedIn,
  coreEdit,
  tagBinding,
  instructions,
  requiresPhotoToggle,
  inventoryLinks,
  editHref,
  editLabel,
  onDelete,
  deleteLabel,
  deleting,
  blockedMessage,
  onClose,
}: Props) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-40" onClick={onClose} />

      <div className="fixed bottom-0 left-0 right-0 z-50 max-w-mobile mx-auto">
        <div className="bg-card rounded-t-modal max-h-[80vh] flex flex-col">
          <div className="flex justify-center pt-3 pb-1 flex-shrink-0">
            <div className="w-10 h-1 rounded-full bg-border-light" />
          </div>

          <div className="flex items-center justify-between px-4 pb-3 flex-shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 flex items-center justify-center flex-shrink-0">
                <AppIcon name={icon} size={18} className="text-muted" />
              </div>
              <div className="min-w-0">
                <h2 className="font-heading text-lg text-text truncate">{name}</h2>
                <p className="font-mono text-[10px] text-dim mt-0.5">{meta}</p>
              </div>
            </div>
            <button onClick={onClose} className="text-dim min-h-[44px] min-w-[44px] flex items-center justify-end flex-shrink-0">
              <X size={18} />
            </button>
          </div>

          <div className="px-4 pb-8 overflow-y-auto space-y-4">
            {coreEdit && (
              <CoreFieldsEditor
                name={coreEdit.name}
                icon={coreEdit.icon}
                formFields={coreEdit.formFields}
                projectedMinutes={coreEdit.projectedMinutes}
                onSave={coreEdit.onSave}
                saving={coreEdit.saving}
              />
            )}

            {usedIn && (
              <div>
                <p className="font-mono text-[10px] uppercase tracking-widest text-dim mb-1.5">
                  Used In
                </p>
                {usedIn.length > 0 ? (
                  <p className="font-body text-sm text-text">
                    {usedIn.map((p) => p.taskListName).join(", ")}
                  </p>
                ) : (
                  <p className="font-mono text-xs text-dim">Not placed in any list</p>
                )}
              </div>
            )}

            {tagBinding && <NfcBindingPanel tagBinding={tagBinding} />}

            {instructions && <InstructionsEditorPanel instructions={instructions} />}

            {requiresPhotoToggle && <RequiresPhotoTogglePanel toggle={requiresPhotoToggle} />}

            {inventoryLinks && (
              <LinkedInventoryPanel
                links={inventoryLinks.links}
                busyId={inventoryLinks.busyId}
                error={inventoryLinks.error}
                onAdd={inventoryLinks.onAdd}
                onToggleRequired={inventoryLinks.onToggleRequired}
                onRemove={inventoryLinks.onRemove}
              />
            )}

            <div className="pt-3 border-t border-border flex items-center justify-between gap-2">
              {editHref ? (
                <Link href={editHref} className="font-mono text-[10px] text-olive uppercase tracking-widest">
                  {editLabel}
                </Link>
              ) : (
                <span />
              )}
              <button
                onClick={() => (confirmingDelete ? onDelete() : setConfirmingDelete(true))}
                disabled={deleting}
                className="font-mono text-[10px] text-burgundy-light uppercase tracking-widest disabled:opacity-50"
              >
                {deleting ? `${deleteLabel === "Delete" ? "Deleting" : "Removing"}…` : confirmingDelete ? `Confirm ${deleteLabel}` : deleteLabel}
              </button>
            </div>

            {blockedMessage && (
              <p className="font-mono text-[10px] text-burgundy-light">{blockedMessage}</p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
