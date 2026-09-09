"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Check, Trash2, Plus, Search, Nfc } from "lucide-react";
import AppIcon, { IconPicker } from "@/components/AppIcon";
import TaskFieldsEditor from "@/components/TaskFieldsEditor";
import LinkInventoryItemSheet from "@/components/LinkInventoryItemSheet";
import InstructionsEditorPanel, { type InstructionStepView } from "@/components/task-panels/InstructionsEditorPanel";
import RequiresPhotoTogglePanel from "@/components/task-panels/RequiresPhotoTogglePanel";
import LinkedInventoryPanel from "@/components/task-panels/LinkedInventoryPanel";
import CreatedTaskPanels, { type CreatedTaskInfo } from "@/components/task-panels/CreatedTaskPanels";
import { useTaskDefinitionPanel, type DefinitionInstructionStep } from "@/lib/client/use-task-definition-panel";
import { useInventoryLinks } from "@/lib/client/use-inventory-links";
import type { FormFieldDef } from "@/models/TaskDefinition";

export interface CatalogDefinition {
  _id: string;
  name: string;
  icon: string;
  formFields: FormFieldDef[];
  projectedMinutes: number;
  nfcTagUid: string | null;
  instructionSteps: DefinitionInstructionStep[];
  requiresPhoto: boolean;
  placements: Array<{ taskId: string; taskListId: string; taskListName: string }>;
}

interface Props {
  definitions: CatalogDefinition[] | null;
  onSave: (id: string, name: string, icon: string, projectedMinutes: number, formFields: FormFieldDef[]) => Promise<void>;
  onDelete: (id: string) => Promise<{ ok: boolean; error?: string }>;
  // Returns the newly-created definition's id (plus its starting NFC/
  // instructions/photo state, always empty here since it's brand new) on
  // success, or null on failure — see NewCatalogTaskForm below and
  // docs/features/unified-task-create-edit.md.
  onCreate: (name: string, icon: string, projectedMinutes: number, formFields: FormFieldDef[]) => Promise<CreatedTaskInfo | null>;
}

function usageLabel(definition: CatalogDefinition) {
  if (definition.placements.length === 0) return "Not placed in any list";
  const names = Array.from(new Set(definition.placements.map((p) => p.taskListName)));
  return `Used in ${names.join(", ")}`;
}

function CatalogRow({
  definition,
  isEditing,
  onToggleEdit,
  onSave,
  onDelete,
  deleting,
  blockedMessage,
}: {
  definition: CatalogDefinition;
  isEditing: boolean;
  onToggleEdit: () => void;
  onSave: (name: string, icon: string, projectedMinutes: number, formFields: FormFieldDef[]) => Promise<void>;
  onDelete: () => void;
  deleting: boolean;
  blockedMessage: string | null;
}) {
  const [editName, setEditName] = useState(definition.name);
  const [editIcon, setEditIcon] = useState(definition.icon);
  const [editMins, setEditMins] = useState(String(definition.projectedMinutes));
  const [editFields, setEditFields] = useState<FormFieldDef[]>(definition.formFields);
  const [saving, setSaving] = useState(false);

  // Instructions, Require Photo, Linked Inventory — definitionId-scoped,
  // shared with mobile's CatalogRow/SortableRow and console's own
  // SortableTaskRow, see lib/client/use-task-definition-panel.ts and
  // docs/features/unified-task-create-edit.md's console edit-parity
  // backfill. NFC stays status-only below (no scanner in a browser).
  const panel = useTaskDefinitionPanel(definition._id, {
    nfcTagUid: definition.nfcTagUid,
    instructionSteps: definition.instructionSteps,
    requiresPhoto: definition.requiresPhoto,
  });
  const inventory = useInventoryLinks(definition._id, isEditing);
  const [showLinkPicker, setShowLinkPicker] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    const mins = parseInt(editMins) || definition.projectedMinutes;
    await onSave(editName.trim() || definition.name, editIcon || definition.icon, mins, editFields);
    setSaving(false);
  };

  const unplaced = definition.placements.length === 0;

  return (
    <div className="bg-card">
      <div className="flex items-center gap-3 px-4 py-3 min-h-[52px]">
        <div className="w-6 flex items-center justify-center flex-shrink-0">
          <AppIcon name={definition.icon} size={16} className="text-muted" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-body text-sm text-text truncate">{definition.name}</p>
          <p className="font-mono text-[10px] text-dim truncate mt-0.5">{usageLabel(definition)}</p>
        </div>
        {definition.nfcTagUid && (
          <span className="flex-shrink-0 flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-olive bg-olive/10 px-2 py-0.5 rounded-pill">
            <Nfc size={10} /> Linked
          </span>
        )}
        <span className="font-mono text-dim text-xs flex-shrink-0">{definition.projectedMinutes}m</span>
        <button
          onClick={onToggleEdit}
          className="flex-shrink-0 w-7 h-7 flex items-center justify-center text-dim hover:text-muted transition-colors"
          aria-label={isEditing ? "Collapse" : "Edit"}
        >
          {isEditing ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
        <button
          onClick={onDelete}
          disabled={deleting || !unplaced}
          title={unplaced ? "Delete from catalog" : "Remove from every list first"}
          className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-full bg-burgundy/10 hover:bg-burgundy/20 text-burgundy-light transition-colors disabled:opacity-30 disabled:hover:bg-burgundy/10"
        >
          <Trash2 size={13} />
        </button>
      </div>

      {blockedMessage && (
        <p className="px-4 pb-2 font-mono text-[10px] text-burgundy-light">{blockedMessage}</p>
      )}

      {isEditing && (
        <div className="px-4 pb-4 pt-1 border-t border-border space-y-3">
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="font-mono text-[10px] uppercase tracking-widest text-dim block mb-1.5">Name</label>
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="w-full bg-bg border border-border rounded-card px-3 py-2 font-body text-sm text-text outline-none focus:border-olive"
              />
            </div>
            <div className="flex-shrink-0 w-20">
              <label className="font-mono text-[10px] uppercase tracking-widest text-dim block mb-1.5">Est. min</label>
              <input
                type="number"
                value={editMins}
                onChange={(e) => setEditMins(e.target.value)}
                min={1}
                className="w-full bg-bg border border-border rounded-card px-3 py-2 font-mono text-sm text-text outline-none focus:border-olive"
              />
            </div>
          </div>

          <div>
            <label className="font-mono text-[10px] uppercase tracking-widest text-dim block mb-2">Icon</label>
            <IconPicker selected={editIcon} onSelect={setEditIcon} />
          </div>

          <TaskFieldsEditor fields={editFields} onChange={setEditFields} />

          <button
            onClick={handleSave}
            disabled={saving || editFields.length === 0}
            className="flex items-center gap-1.5 bg-olive/15 border border-olive/30 text-olive font-mono text-xs px-4 py-2 rounded-pill disabled:opacity-50"
          >
            <Check size={12} />
            {saving ? "Saving…" : "Save changes"}
          </button>

          <div className="pt-2 border-t border-border">
            <p className="font-mono text-[10px] uppercase tracking-widest text-dim mb-1.5">Scan-to-Complete Tag</p>
            <p className="font-mono text-[11px] text-dim">
              {definition.nfcTagUid ? `Linked · ${definition.nfcTagUid}` : "Not linked — link NFC on mobile device."}
            </p>
          </div>

          <InstructionsEditorPanel
            instructions={{
              steps: panel.instructionSteps.map((s): InstructionStepView => ({
                key: s._id,
                description: s.description,
                imageUrl: s.imageUrl,
              })),
              maxSteps: 3,
              busy: panel.stepsBusy,
              error: panel.stepsError,
              capturing: panel.capturing,
              captureError: panel.captureError,
              onTakePhoto: panel.handleTakePhoto,
              onAddStep: panel.handleAddStep,
              onDeleteStep: panel.handleDeleteStep,
            }}
          />

          <RequiresPhotoTogglePanel
            toggle={{
              value: panel.requiresPhoto,
              busy: panel.requiresPhotoBusy,
              onChange: panel.handleToggleRequiresPhoto,
            }}
          />

          <LinkedInventoryPanel
            links={inventory.links}
            busyId={inventory.busyId}
            error={inventory.error}
            onAdd={() => setShowLinkPicker(true)}
            onToggleRequired={inventory.toggleRequired}
            onRemove={inventory.removeLink}
          />
        </div>
      )}

      {showLinkPicker && (
        <LinkInventoryItemSheet
          excludeItemTypeIds={(inventory.links ?? []).map((l) => l.itemTypeId)}
          busy={inventory.busyId !== null}
          onPick={async (itemTypeId) => {
            const ok = await inventory.addLink(itemTypeId);
            if (ok) setShowLinkPicker(false);
          }}
          onClose={() => setShowLinkPicker(false)}
        />
      )}
    </div>
  );
}

// Two-phase create (see docs/features/unified-task-create-edit.md): once
// the core fields (name/icon/fields/minutes) are saved, `created` holds the
// new definition's id and this same card switches to CreatedTaskPanels —
// the shared NFC(status-only)/Instructions/Require Photo/Linked Inventory
// panels, scoped to that id — instead of closing straight back to the "+
// New catalog task" button. Closing at any point after that leaves a
// valid, saved catalog entry.
function NewCatalogTaskForm({ onCreate, onClose }: { onCreate: Props["onCreate"]; onClose: () => void }) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("list-checks");
  const [mins, setMins] = useState("5");
  const [fields, setFields] = useState<FormFieldDef[]>([]);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<CreatedTaskInfo | null>(null);

  const handleCreate = async () => {
    if (!name.trim() || fields.length === 0) return;
    setSaving(true);
    const result = await onCreate(name.trim(), icon, parseInt(mins) || 5, fields);
    setSaving(false);
    if (result) setCreated(result);
  };

  if (created) {
    return (
      <div className="rounded-card border border-border bg-card p-4 mb-4">
        <CreatedTaskPanels
          name={name.trim()}
          icon={icon}
          definitionId={created.definitionId}
          nfcTagUid={created.nfcTagUid}
          instructionSteps={created.instructionSteps}
          requiresPhoto={created.requiresPhoto}
          allowNfcScan={false}
          onDone={onClose}
        />
      </div>
    );
  }

  return (
    <div className="rounded-card border border-border bg-card p-4 space-y-3 mb-4">
      <p className="font-mono text-[10px] uppercase tracking-widest text-dim">New catalog task</p>
      <p className="font-mono text-[11px] text-dim">
        Saved to the company catalog only — place it into a task list whenever you&rsquo;re ready.
      </p>
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="font-mono text-[10px] uppercase tracking-widest text-dim block mb-1.5">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Walk-in Fridge Temp"
            autoFocus
            className="w-full bg-bg border border-border rounded-card px-3 py-2 font-body text-sm text-text placeholder:text-dim outline-none focus:border-olive"
          />
        </div>
        <div className="flex-shrink-0 w-20">
          <label className="font-mono text-[10px] uppercase tracking-widest text-dim block mb-1.5">Est. min</label>
          <input
            type="number"
            value={mins}
            onChange={(e) => setMins(e.target.value)}
            min={1}
            className="w-full bg-bg border border-border rounded-card px-3 py-2 font-mono text-sm text-text outline-none focus:border-olive"
          />
        </div>
      </div>

      <div>
        <label className="font-mono text-[10px] uppercase tracking-widest text-dim block mb-2">Icon</label>
        <IconPicker selected={icon} onSelect={setIcon} />
      </div>

      <TaskFieldsEditor fields={fields} onChange={setFields} />

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={handleCreate}
          disabled={saving || !name.trim() || fields.length === 0}
          className="flex items-center gap-1.5 bg-olive/15 border border-olive/30 text-olive font-mono text-xs px-4 py-2 rounded-pill disabled:opacity-50"
        >
          <Check size={12} />
          {saving ? "Creating…" : "Create"}
        </button>
        <button onClick={onClose} className="font-mono text-[10px] uppercase tracking-widest text-dim px-2">
          Cancel
        </button>
      </div>
    </div>
  );
}

// Full-width pane for /console/tasks's "Task Catalog" view — every saved
// TaskDefinition the company has, independent of which (if any) task lists
// currently place it. Fills the gap TaskListDetailPane can't: editing or
// deleting a definition that isn't (or isn't yet) placed in any list at
// all, and creating a brand-new catalog entry with no placement in the same
// request — see docs/features/console-task-management.md's "Task Catalog
// pane". Mirrors mobile's ManageTasksView.tsx "Company Task Catalog"
// section in spirit (same usage-label convention, same delete-blocked-
// while-placed rule) but adds the inline name/icon/fields/minutes editor
// mobile's own catalog rows still lack for an unplaced definition.
export default function TaskCatalogPane({ definitions, onSave, onDelete, onCreate }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ id: string; message: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");

  const q = search.trim().toLowerCase();
  const filtered = (definitions ?? []).filter((d) => q === "" || d.name.toLowerCase().includes(q));

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    setBlocked(null);
    const result = await onDelete(id);
    if (!result.ok) setBlocked({ id, message: result.error ?? "Couldn't delete this task." });
    setDeletingId(null);
  };

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="font-heading text-lg text-text">Task Catalog</h2>
        <p className="font-mono text-[10px] text-dim">
          {definitions === null ? "" : `${definitions.length} task${definitions.length === 1 ? "" : "s"}`}
        </p>
      </div>
      <p className="font-body text-sm text-muted mb-4">
        Every saved task, whether or not it&rsquo;s currently placed in a task list. Edit or delete one here
        without touching any list.
      </p>

      <div className="mb-3 flex items-center gap-2 bg-card border border-border rounded-card px-3 py-2">
        <Search size={14} className="text-dim flex-shrink-0" />
        <input
          type="text"
          placeholder="Search the catalog..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 bg-transparent font-body text-sm text-text placeholder:text-dim outline-none"
        />
      </div>

      {creating ? (
        // The form now manages its own two-phase transition (see
        // NewCatalogTaskForm's own comment) — onCreate is passed straight
        // through, and `creating` only resets via onClose (its Done button
        // once phase 2 is finished, or Cancel before ever creating).
        <NewCatalogTaskForm onCreate={onCreate} onClose={() => setCreating(false)} />
      ) : (
        <button
          onClick={() => setCreating(true)}
          className="mb-4 w-full flex items-center justify-center gap-2 border border-dashed border-border-light text-dim font-body text-sm py-3.5 rounded-card hover:border-olive/40 hover:text-olive transition-colors"
        >
          <Plus size={14} /> New catalog task
        </button>
      )}

      {definitions === null ? (
        <p className="text-dim font-mono text-xs py-8">Loading…</p>
      ) : definitions.length === 0 ? (
        <p className="text-dim font-mono text-xs text-center py-8">No saved tasks yet.</p>
      ) : filtered.length === 0 ? (
        <p className="text-dim font-mono text-xs text-center py-8">No catalog tasks match &ldquo;{search}&rdquo;</p>
      ) : (
        <div className="rounded-card overflow-hidden divide-y divide-border border border-border">
          {filtered.map((d) => (
            <CatalogRow
              key={d._id}
              definition={d}
              isEditing={editingId === d._id}
              onToggleEdit={() => setEditingId((prev) => (prev === d._id ? null : d._id))}
              onSave={async (name, icon, mins, fields) => {
                setEditingId(null);
                await onSave(d._id, name, icon, mins, fields);
              }}
              onDelete={() => handleDelete(d._id)}
              deleting={deletingId === d._id}
              blockedMessage={blocked?.id === d._id ? blocked.message : null}
            />
          ))}
        </div>
      )}
    </div>
  );
}
