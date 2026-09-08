"use client";

import { useState } from "react";
import { Plus, Pencil, Trash2, Check, X } from "lucide-react";
import type { JobTagOption } from "@/components/console/JobTagsPanel";

export interface ConsoleTaskList {
  _id: string;
  name: string;
  startTime: string | null;
  scheduledDays: number[];
  notifyTags: string[];
  taskCount: number;
}

interface Props {
  taskLists: ConsoleTaskList[] | null;
  jobTags: JobTagOption[] | null;
  selectedListId: string | null;
  onSelect: (id: string) => void;
  onCreate: (name: string, startTime: string | null, scheduledDays: number[], notifyTags: string[]) => Promise<void>;
  onUpdate: (
    id: string,
    patch: { name?: string; startTime?: string | null; scheduledDays?: number[]; notifyTags?: string[] }
  ) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

// Multi-select chip picker for TaskList.notifyTags — narrows a shift-window
// list's start-time reminder to teammates carrying at least one of the
// selected job tags; empty = notify everyone (today's behavior). See
// docs/features/notification-job-tag-targeting.md. A tag with userCount 0
// gets a visible "0" so a manager can see up front a list would notify
// nobody, without cross-referencing the Team page.
function NotifyTagsPicker({
  jobTags,
  selected,
  onToggle,
}: {
  jobTags: JobTagOption[] | null;
  selected: string[];
  onToggle: (name: string) => void;
}) {
  if (!jobTags || jobTags.length === 0) return null;
  const zeroMatchSelected = selected.some((name) => (jobTags.find((t) => t.name === name)?.userCount ?? 0) === 0);
  return (
    <div>
      <label className="font-mono text-[10px] uppercase tracking-widest text-dim block mb-1.5">
        Notifies {selected.length === 0 ? "· everyone (default)" : ""}
      </label>
      <div className="flex flex-wrap gap-1.5">
        {jobTags.map((tag) => {
          const isSelected = selected.includes(tag.name);
          return (
            <button
              key={tag._id}
              type="button"
              onClick={() => onToggle(tag.name)}
              className={`font-mono text-[10px] px-2.5 py-1 rounded-pill border transition-colors ${
                isSelected ? "bg-olive text-text border-olive" : "bg-bg border-border text-dim"
              }`}
            >
              {tag.name} · {tag.userCount ?? 0}
            </button>
          );
        })}
      </div>
      {zeroMatchSelected && (
        <p className="font-mono text-[10px] text-burgundy-light mt-1.5">
          No teammate currently holds a selected tag — this list would notify nobody.
        </p>
      )}
    </div>
  );
}

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"]; // Sun..Sat, matches mobile's own convention
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function DayToggle({ days, onToggle }: { days: number[]; onToggle: (day: number) => void }) {
  return (
    <div className="flex gap-1">
      {DAY_LABELS.map((label, day) => (
        <button
          key={day}
          type="button"
          onClick={() => onToggle(day)}
          className={`w-6 h-6 rounded-full font-mono text-[10px] transition-colors ${
            days.includes(day) ? "bg-olive text-text" : "bg-bg border border-border text-dim"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function fmtStart(startTime: string | null) {
  return startTime ?? "Anytime";
}

// Left pane of /console/tasks — every task list, in the same order
// GET /api/task-lists already returns (startTime then order). See
// docs/features/console-task-management.md's "Layout — two panes". Inline
// rename/reschedule/soft-delete per row, replacing the separate navigation
// mobile's dedicated TaskListEditView.tsx page requires — a desktop-layout
// difference only, not a capability change.
export default function TaskListsPane({ taskLists, jobTags, selectedListId, onSelect, onCreate, onUpdate, onDelete }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editStartTime, setEditStartTime] = useState("");
  const [editDays, setEditDays] = useState<number[]>(ALL_DAYS);
  const [editTags, setEditTags] = useState<string[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newStartTime, setNewStartTime] = useState("");
  const [newDays, setNewDays] = useState<number[]>(ALL_DAYS);
  const [newTags, setNewTags] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const startEdit = (list: ConsoleTaskList) => {
    setEditingId(list._id);
    setEditName(list.name);
    setEditStartTime(list.startTime ?? "");
    setEditDays(list.scheduledDays);
    setEditTags(list.notifyTags ?? []);
  };

  const toggleEditDay = (day: number) => {
    setEditDays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort()));
  };

  const toggleNewDay = (day: number) => {
    setNewDays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort()));
  };

  const toggleEditTag = (name: string) => {
    setEditTags((prev) => (prev.includes(name) ? prev.filter((t) => t !== name) : [...prev, name]));
  };

  const toggleNewTag = (name: string) => {
    setNewTags((prev) => (prev.includes(name) ? prev.filter((t) => t !== name) : [...prev, name]));
  };

  const handleSaveEdit = async (id: string) => {
    setBusyId(id);
    await onUpdate(id, {
      name: editName.trim() || undefined,
      startTime: editStartTime || null,
      scheduledDays: editDays,
      notifyTags: editTags,
    });
    setBusyId(null);
    setEditingId(null);
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setSaving(true);
    await onCreate(newName.trim(), newStartTime || null, newDays, newTags);
    setSaving(false);
    setCreating(false);
    setNewName("");
    setNewStartTime("");
    setNewDays(ALL_DAYS);
    setNewTags([]);
  };

  return (
    <div className="w-72 flex-shrink-0 border-r border-border pr-4">
      <h2 className="font-mono text-[10px] text-dim uppercase tracking-widest mb-3">Task Lists</h2>

      {taskLists === null ? (
        <p className="text-dim font-mono text-xs py-4">Loading…</p>
      ) : taskLists.length === 0 ? (
        <p className="text-dim font-mono text-xs py-4">No task lists yet.</p>
      ) : (
        <div className="space-y-1">
          {taskLists.map((list) => {
            const isEditing = editingId === list._id;
            const isSelected = selectedListId === list._id;
            return (
              <div
                key={list._id}
                className={`rounded-card border transition-colors ${
                  isSelected ? "border-olive bg-olive/5" : "border-border bg-card hover:bg-card-hover"
                }`}
              >
                {isEditing ? (
                  <div className="p-3 space-y-2">
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="w-full bg-bg border border-border rounded px-2 py-1.5 font-body text-sm text-text outline-none focus:border-olive"
                    />
                    <div className="flex items-center gap-2">
                      <input
                        type="time"
                        value={editStartTime}
                        onChange={(e) => setEditStartTime(e.target.value)}
                        className="flex-1 bg-bg border border-border rounded px-2 py-1.5 font-mono text-xs text-text outline-none focus:border-olive"
                      />
                    </div>
                    <DayToggle days={editDays} onToggle={toggleEditDay} />
                    <NotifyTagsPicker jobTags={jobTags} selected={editTags} onToggle={toggleEditTag} />
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        onClick={() => handleSaveEdit(list._id)}
                        disabled={busyId === list._id}
                        className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-olive disabled:opacity-40"
                      >
                        <Check size={11} /> Save
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-dim"
                      >
                        <X size={11} /> Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => onSelect(list._id)} className="w-full text-left px-3 py-2.5 flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="font-body text-sm text-text truncate">{list.name}</p>
                      <p className="font-mono text-[10px] text-dim mt-0.5">
                        {fmtStart(list.startTime)} · {list.taskCount} task{list.taskCount === 1 ? "" : "s"}
                        {list.notifyTags.length > 0 && ` · notifies ${list.notifyTags.join(", ")}`}
                      </p>
                    </div>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        startEdit(list);
                      }}
                      onKeyDown={(e) => e.key === "Enter" && (e.stopPropagation(), startEdit(list))}
                      className="flex-shrink-0 text-dim hover:text-olive p-1"
                      aria-label={`Edit ${list.name}`}
                    >
                      <Pencil size={13} />
                    </span>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`Delete "${list.name}"? Its history is kept, but it won't show on the Tasks page anymore.`)) {
                          onDelete(list._id);
                        }
                      }}
                      onKeyDown={(e) => e.key === "Enter" && e.stopPropagation()}
                      className="flex-shrink-0 text-dim hover:text-burgundy-light p-1"
                      aria-label={`Delete ${list.name}`}
                    >
                      <Trash2 size={13} />
                    </span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {creating ? (
        <div className="mt-3 p-3 border border-border rounded-card bg-card space-y-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="List name"
            autoFocus
            className="w-full bg-bg border border-border rounded px-2 py-1.5 font-body text-sm text-text placeholder:text-dim outline-none focus:border-olive"
          />
          <input
            type="time"
            value={newStartTime}
            onChange={(e) => setNewStartTime(e.target.value)}
            className="w-full bg-bg border border-border rounded px-2 py-1.5 font-mono text-xs text-text outline-none focus:border-olive"
          />
          <p className="font-mono text-[10px] text-dim">Blank start time = a never-collapsing anytime list.</p>
          <DayToggle days={newDays} onToggle={toggleNewDay} />
          <NotifyTagsPicker jobTags={jobTags} selected={newTags} onToggle={toggleNewTag} />
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleCreate}
              disabled={saving || !newName.trim()}
              className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-olive disabled:opacity-40"
            >
              <Check size={11} /> {saving ? "Creating…" : "Create"}
            </button>
            <button
              onClick={() => setCreating(false)}
              className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-dim"
            >
              <X size={11} /> Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setCreating(true)}
          className="mt-3 w-full flex items-center justify-center gap-1.5 border border-dashed border-border-light text-dim font-body text-xs py-2.5 rounded-card hover:border-olive/40 hover:text-olive transition-colors"
        >
          <Plus size={13} /> New Task List
        </button>
      )}
    </div>
  );
}
