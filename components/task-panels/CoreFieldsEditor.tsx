"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { IconPicker } from "@/components/AppIcon";
import TaskFieldsEditor from "@/components/TaskFieldsEditor";
import type { FormFieldDef } from "@/models/TaskDefinition";

// Name / icon / form fields / estimated-time editor — previously only
// reachable from a Task Lists placement row (TaskListEditView.tsx's
// SortableRow, which keeps its own inline version since it also has a
// schedule/threshold section that has no catalog equivalent). This is the
// Task Catalog side's net-new equivalent (ManageTaskDetailSheet.tsx), same
// AppIcon/IconPicker/TaskFieldsEditor building blocks, saving straight to
// the TaskDefinition's own defaults (PATCH /api/task-definitions/[id])
// rather than a placement override — see
// docs/features/unified-task-edit-surface.md.
export default function CoreFieldsEditor({
  name,
  icon,
  formFields,
  projectedMinutes,
  onSave,
  saving,
}: {
  name: string;
  icon: string;
  formFields: FormFieldDef[];
  projectedMinutes: number;
  onSave: (name: string, icon: string, formFields: FormFieldDef[], projectedMinutes: number) => Promise<void>;
  saving: boolean;
}) {
  const [editName, setEditName] = useState(name);
  const [editIcon, setEditIcon] = useState(icon);
  const [editMins, setEditMins] = useState(String(projectedMinutes));
  const [editFields, setEditFields] = useState<FormFieldDef[]>(formFields);

  const handleSave = async () => {
    const mins = parseInt(editMins) || projectedMinutes;
    await onSave(editName.trim() || name, editIcon || icon, editFields, mins);
  };

  return (
    <div className="space-y-3">
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
    </div>
  );
}
