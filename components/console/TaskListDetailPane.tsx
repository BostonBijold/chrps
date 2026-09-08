"use client";

import { useState } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, X, ChevronDown, ChevronUp, Check, Nfc } from "lucide-react";
import AppIcon, { IconPicker } from "@/components/AppIcon";
import AddTaskSheet from "@/components/AddTaskSheet";
import TaskFieldsEditor from "@/components/TaskFieldsEditor";
import type { TaskType, FormFieldDef } from "@/models/TaskDefinition";

export interface ConsoleTask {
  _id: string;
  definitionId: string;
  name: string;
  icon: string;
  taskType: TaskType;
  formFields: FormFieldDef[];
  projectedMinutes: number;
  nfcTagUid: string | null;
  scheduledDays: number[];
  successThreshold: number;
  order: number;
}

interface Props {
  taskList: { _id: string; name: string } | null;
  tasks: ConsoleTask[] | null;
  onReorder: (orderedIds: string[]) => Promise<void>;
  onSaveTask: (
    id: string,
    name: string,
    icon: string,
    projectedMinutes: number,
    formFields: FormFieldDef[],
    scheduledDays: number[],
    successThreshold: number
  ) => Promise<void>;
  onRemoveTask: (id: string) => Promise<void>;
  onAddTask: (
    templateId: string | null,
    name: string,
    icon: string,
    projectedMinutes: number,
    taskType: "form",
    scheduledDays: number[],
    successThreshold: number,
    formFields: FormFieldDef[]
  ) => Promise<void>;
  onAddExisting: (definitionId: string) => Promise<void>;
  onAddClone: (definitionId: string) => Promise<void>;
}

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

function SortableTaskRow({
  task,
  isEditing,
  onToggleEdit,
  onSave,
  onRemove,
}: {
  task: ConsoleTask;
  isEditing: boolean;
  onToggleEdit: () => void;
  onSave: (
    name: string,
    icon: string,
    projectedMinutes: number,
    formFields: FormFieldDef[],
    scheduledDays: number[],
    successThreshold: number
  ) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task._id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.45 : 1,
    zIndex: isDragging ? 20 : undefined,
  };

  const [editName, setEditName] = useState(task.name);
  const [editIcon, setEditIcon] = useState(task.icon);
  const [editMins, setEditMins] = useState(String(task.projectedMinutes));
  const [editFields, setEditFields] = useState<FormFieldDef[]>(task.formFields);
  const [editScheduledDays, setEditScheduledDays] = useState<number[]>(task.scheduledDays);
  const [editThreshold, setEditThreshold] = useState(task.successThreshold);
  const [saving, setSaving] = useState(false);

  const toggleEditDay = (day: number) => {
    setEditScheduledDays((prev) => {
      const next = prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort();
      setEditThreshold((t) => Math.min(t, Math.max(next.length, 1)));
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    const mins = parseInt(editMins) || task.projectedMinutes;
    await onSave(editName.trim() || task.name, editIcon || task.icon, mins, editFields, editScheduledDays, editThreshold);
    setSaving(false);
  };

  return (
    <div ref={setNodeRef} style={style} className="bg-card">
      <div className="flex items-center gap-3 px-4 py-3 min-h-[52px]">
        <button {...listeners} {...attributes} className="text-dim cursor-grab active:cursor-grabbing flex-shrink-0 p-1 touch-none" aria-label="Drag to reorder">
          <GripVertical size={15} />
        </button>
        <div className="w-6 flex items-center justify-center flex-shrink-0">
          <AppIcon name={task.icon} size={16} className="text-muted" />
        </div>
        <span className="flex-1 font-body text-sm text-text truncate">{task.name}</span>
        {task.nfcTagUid ? (
          <span className="flex-shrink-0 flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-olive bg-olive/10 px-2 py-0.5 rounded-pill">
            <Nfc size={10} /> Linked
          </span>
        ) : (
          <span className="flex-shrink-0 font-mono text-[10px] text-dim" title="Bind an NFC tag from the phone app">
            Not linked
          </span>
        )}
        <span className="font-mono text-dim text-xs flex-shrink-0">{task.projectedMinutes}m</span>
        <button
          onClick={onToggleEdit}
          className="flex-shrink-0 w-7 h-7 flex items-center justify-center text-dim hover:text-muted transition-colors"
          aria-label={isEditing ? "Collapse" : "Edit"}
        >
          {isEditing ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
        <button
          onClick={onRemove}
          className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-full bg-burgundy/10 hover:bg-burgundy/20 text-burgundy-light transition-colors"
          aria-label="Remove"
        >
          <X size={13} />
        </button>
      </div>

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

          <div>
            <label className="font-mono text-[10px] uppercase tracking-widest text-dim block mb-1.5">Days expected</label>
            <div className="flex gap-1.5">
              {DAY_LABELS.map((label, day) => (
                <button
                  key={day}
                  type="button"
                  onClick={() => toggleEditDay(day)}
                  className={`w-8 h-8 rounded-full font-mono text-xs transition-colors ${
                    editScheduledDays.includes(day) ? "bg-olive text-text" : "bg-bg border border-border text-dim"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="font-mono text-[10px] uppercase tracking-widest text-dim block mb-1.5">
              Counts as a win when done
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={editThreshold}
                onChange={(e) => setEditThreshold(Math.max(1, Math.min(parseInt(e.target.value) || 1, editScheduledDays.length)))}
                min={1}
                max={Math.max(editScheduledDays.length, 1)}
                className="w-16 bg-bg border border-border rounded-card px-3 py-2 font-mono text-sm text-text outline-none focus:border-olive"
              />
              <span className="font-mono text-xs text-dim">
                of {editScheduledDays.length} scheduled day{editScheduledDays.length === 1 ? "" : "s"} this week
              </span>
            </div>
          </div>

          <button
            onClick={handleSave}
            disabled={saving || editFields.length === 0}
            className="flex items-center gap-1.5 bg-olive/15 border border-olive/30 text-olive font-mono text-xs px-4 py-2 rounded-pill disabled:opacity-50"
          >
            <Check size={12} />
            {saving ? "Saving…" : "Save changes"}
          </button>

          {/* NFC status only, no scan action here — binding a tag requires
              physically tapping a phone. See
              docs/features/console-task-management.md's "NFC status, not
              NFC action". */}
          <div className="pt-2 border-t border-border">
            <p className="font-mono text-[10px] uppercase tracking-widest text-dim mb-1.5">Scan-to-Complete Tag</p>
            <p className="font-mono text-[11px] text-dim">
              {task.nfcTagUid ? `Linked · ${task.nfcTagUid}` : "Not linked — link NFC on mobile device."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// Right pane of /console/tasks — the selected list's tasks, in order, each
// editable inline. Task type is not editable here (nothing in the mobile
// UI lets that change after creation either), and NFC binding is
// status-only (see the row component above) — see
// docs/features/console-task-management.md's "Layout — two panes".
export default function TaskListDetailPane({ taskList, tasks, onReorder, onSaveTask, onRemoveTask, onAddTask, onAddExisting, onAddClone }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAddSheet, setShowAddSheet] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = async (event: DragEndEvent) => {
    if (!tasks) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = tasks.findIndex((t) => t._id === active.id);
    const newIndex = tasks.findIndex((t) => t._id === over.id);
    const reordered = arrayMove(tasks, oldIndex, newIndex);
    await onReorder(reordered.map((t) => t._id));
  };

  if (!taskList) {
    return (
      <div className="flex-1 min-w-0 pl-6 flex items-center justify-center">
        <p className="text-dim font-mono text-xs">Select a task list to manage its tasks.</p>
      </div>
    );
  }

  const totalMins = (tasks ?? []).reduce((s, t) => s + t.projectedMinutes, 0);

  return (
    <div className="flex-1 min-w-0 pl-6">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="font-heading text-lg text-text">{taskList.name}</h2>
        <p className="font-mono text-[10px] text-dim">
          {(tasks ?? []).length} task{(tasks ?? []).length === 1 ? "" : "s"} · {totalMins}m
        </p>
      </div>

      {tasks === null ? (
        <p className="text-dim font-mono text-xs py-8">Loading…</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={tasks.map((t) => t._id)} strategy={verticalListSortingStrategy}>
            <div className="rounded-card overflow-hidden divide-y divide-border border border-border">
              {tasks.map((task) => (
                <SortableTaskRow
                  key={task._id}
                  task={task}
                  isEditing={editingId === task._id}
                  onToggleEdit={() => setEditingId((prev) => (prev === task._id ? null : task._id))}
                  onSave={(name, icon, mins, fields, days, threshold) => {
                    setEditingId(null);
                    return onSaveTask(task._id, name, icon, mins, fields, days, threshold);
                  }}
                  onRemove={() => onRemoveTask(task._id)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {tasks !== null && tasks.length === 0 && (
        <div className="text-center py-8">
          <p className="text-dim font-mono text-xs">No tasks yet. Add one below.</p>
        </div>
      )}

      <button
        onClick={() => setShowAddSheet(true)}
        className="mt-4 w-full flex items-center justify-center gap-2 border border-dashed border-border-light text-dim font-body text-sm py-3.5 rounded-card hover:border-olive/40 hover:text-olive transition-colors"
      >
        + Add task to {taskList.name}
      </button>

      {showAddSheet && (
        <AddTaskSheet
          taskListId={taskList._id}
          taskListName={taskList.name}
          onAdd={async (...args) => {
            await onAddTask(...args);
            setShowAddSheet(false);
          }}
          onAddExisting={async (definitionId) => {
            await onAddExisting(definitionId);
            setShowAddSheet(false);
          }}
          onAddClone={async (definitionId) => {
            await onAddClone(definitionId);
            setShowAddSheet(false);
          }}
          onClose={() => setShowAddSheet(false)}
        />
      )}
    </div>
  );
}
