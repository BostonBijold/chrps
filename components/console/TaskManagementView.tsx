"use client";

import { useCallback, useEffect, useState } from "react";
import LocationSwitcher from "@/components/LocationSwitcher";
import TaskListsPane, { type ConsoleTaskList } from "@/components/console/TaskListsPane";
import TaskListDetailPane, { type ConsoleTask } from "@/components/console/TaskListDetailPane";
import TaskCatalogPane from "@/components/console/TaskCatalogPane";
import type { TaskType, FormFieldDef } from "@/models/TaskDefinition";

interface Props {
  isOwner: boolean;
  activeLocationId: string | null;
}

interface RawTask {
  _id: string;
  taskListId: string;
  definitionId: string;
  scheduledDays: number[];
  successThreshold: number;
  projectedMinutes: number | null;
  order: number;
}

interface RawTaskList {
  _id: string;
  name: string;
  startTime: string | null;
  order: number;
  scheduledDays: number[];
  tasks: RawTask[];
}

interface TaskDefinitionEntry {
  _id: string;
  name: string;
  icon: string;
  taskType: TaskType;
  formFields: FormFieldDef[];
  projectedMinutes: number;
  nfcTagUid: string | null;
  placements: Array<{ taskId: string; taskListId: string; taskListName: string }>;
}

// Joins a list's raw task placements onto the company catalog — mirrors
// lib/task-definitions.ts's resolveTasks (same fallback for a stray
// reference: "Deleted task" / "help-circle") since GET /api/task-lists
// intentionally returns raw placements only (see that route's own comment
// on why — it's also the offline cache's pull-sync source), leaving the
// join to whoever's actually rendering resolved fields.
function resolveTasksForList(list: RawTaskList, definitions: TaskDefinitionEntry[]): ConsoleTask[] {
  const byId = new Map(definitions.map((d) => [d._id, d]));
  return [...list.tasks]
    .sort((a, b) => a.order - b.order)
    .map((t) => {
      const def = byId.get(t.definitionId);
      return {
        _id: t._id,
        definitionId: t.definitionId,
        name: def?.name ?? "Deleted task",
        icon: def?.icon ?? "help-circle",
        taskType: def?.taskType ?? "form",
        formFields: def?.formFields ?? [],
        projectedMinutes: t.projectedMinutes ?? def?.projectedMinutes ?? 0,
        nfcTagUid: def?.nfcTagUid ?? null,
        scheduledDays: t.scheduledDays,
        successThreshold: t.successThreshold,
        order: t.order,
      };
    });
}

// Top-level coordinator for /console/tasks — see
// docs/features/console-task-management.md. Reuses every existing
// task-list/task/task-definition route as-is, joining GET /api/task-lists'
// raw placements onto GET /api/task-definitions' catalog client-side
// (resolveTasksForList above) rather than adding a new resolved backend
// route — no new backend for the management functionality itself, per the
// spec. Refetches both collections after every mutation rather than
// optimistically patching local state (unlike TaskListEditView.tsx's
// mobile equivalent) — simpler and safer here, since a task's name/icon/
// formFields edit cascades onto every OTHER list placement sharing the
// same TaskDefinition, not just the one being edited.
export default function TaskManagementView({ isOwner, activeLocationId }: Props) {
  const [taskLists, setTaskLists] = useState<RawTaskList[] | null>(null);
  const [definitions, setDefinitions] = useState<TaskDefinitionEntry[] | null>(null);
  const [selectedListId, setSelectedListId] = useState<string | null>(null);
  const [view, setView] = useState<"lists" | "catalog">("lists");

  const fetchTaskLists = useCallback(async () => {
    const res = await fetch("/api/task-lists");
    const data: RawTaskList[] = res.ok ? await res.json() : [];
    setTaskLists(data);
    return data;
  }, []);

  const fetchDefinitions = useCallback(async () => {
    const res = await fetch("/api/task-definitions");
    const data: TaskDefinitionEntry[] = res.ok ? await res.json() : [];
    setDefinitions(data);
    return data;
  }, []);

  useEffect(() => {
    fetchTaskLists();
    fetchDefinitions();
  }, [fetchTaskLists, fetchDefinitions]);

  // Auto-select the first list once loaded, and fall back to another list
  // (or none) if the selected one disappears — e.g. its last task was just
  // removed, which soft-deletes an empty list server-side (see
  // DELETE /api/tasks/[id]).
  useEffect(() => {
    if (taskLists === null) return;
    if (selectedListId && taskLists.some((l) => l._id === selectedListId)) return;
    setSelectedListId(taskLists[0]?._id ?? null);
  }, [taskLists, selectedListId]);

  const refetchTasksAndDefinitions = () => Promise.all([fetchTaskLists(), fetchDefinitions()]);

  const handleCreateList = async (name: string, startTime: string | null, scheduledDays: number[]) => {
    const res = await fetch("/api/task-lists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, startTime, scheduledDays }),
    });
    const created = await res.json();
    await fetchTaskLists();
    setSelectedListId(created._id);
  };

  const handleUpdateList = async (
    id: string,
    patch: { name?: string; startTime?: string | null; scheduledDays?: number[] }
  ) => {
    await fetch(`/api/task-lists/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    // A scheduledDays change cascades onto every task in the list
    // server-side (see PATCH /api/task-lists/[taskListId]'s own comment) —
    // refetch rather than patch local state so that cascade is reflected.
    await fetchTaskLists();
  };

  const handleDeleteList = async (id: string) => {
    await fetch(`/api/task-lists/${id}`, { method: "DELETE" });
    if (selectedListId === id) setSelectedListId(null);
    await fetchTaskLists();
  };

  const handleReorderTasks = async (orderedIds: string[]) => {
    if (!selectedListId) return;
    // Optimistic local reorder — a drag-and-drop release should feel
    // instant, not wait on a round trip, same reasoning as
    // TaskListEditView.tsx's mobile handleDragEnd.
    setTaskLists((prev) =>
      prev?.map((list) => {
        if (list._id !== selectedListId) return list;
        const byId = new Map(list.tasks.map((t) => [t._id, t]));
        return { ...list, tasks: orderedIds.map((id, idx) => ({ ...byId.get(id)!, order: idx })) };
      }) ?? null
    );
    await fetch("/api/tasks/reorder", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tasks: orderedIds.map((_id, idx) => ({ _id, order: idx })) }),
    });
  };

  const handleSaveTask = async (
    id: string,
    name: string,
    icon: string,
    projectedMinutes: number,
    formFields: FormFieldDef[],
    scheduledDays: number[],
    successThreshold: number
  ) => {
    await fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, icon, formFields, projectedMinutes, scheduledDays, successThreshold }),
    });
    // name/icon/formFields write through to the shared TaskDefinition (see
    // PATCH /api/tasks/[id]'s own comment) and so can change what other
    // list placements show too — refetch both rather than patch just this
    // one placement's local entry.
    await refetchTasksAndDefinitions();
  };

  const handleRemoveTask = async (id: string) => {
    await fetch(`/api/tasks/${id}`, { method: "DELETE" });
    await refetchTasksAndDefinitions();
  };

  const handleAddTask = async (
    templateId: string | null,
    name: string,
    icon: string,
    projectedMinutes: number,
    taskType: "form",
    scheduledDays: number[],
    successThreshold: number,
    formFields: FormFieldDef[]
  ) => {
    if (!selectedListId) return;
    await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskListId: selectedListId,
        templateId,
        name,
        icon,
        projectedMinutes,
        taskType,
        scheduledDays,
        successThreshold,
        formFields,
      }),
    });
    await refetchTasksAndDefinitions();
  };

  const handleAddExisting = async (definitionId: string) => {
    if (!selectedListId) return;
    await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskListId: selectedListId, definitionId }),
    });
    await refetchTasksAndDefinitions();
  };

  const handleAddClone = async (definitionId: string) => {
    if (!selectedListId) return;
    await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskListId: selectedListId, cloneFromDefinitionId: definitionId }),
    });
    await refetchTasksAndDefinitions();
  };

  // Task Catalog pane handlers — these key off definitionId directly
  // (PATCH/POST/DELETE /api/task-definitions), unlike the list-scoped
  // handlers above which key off a Task placement id. A definition with no
  // active placements has no placement id to key off of at all, which is
  // exactly the gap this pane exists to fill — see
  // docs/features/console-task-management.md's "Task Catalog pane".
  const handleSaveDefinition = async (
    id: string,
    name: string,
    icon: string,
    projectedMinutes: number,
    formFields: FormFieldDef[]
  ) => {
    await fetch(`/api/task-definitions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, icon, projectedMinutes, formFields }),
    });
    await refetchTasksAndDefinitions();
  };

  const handleDeleteDefinition = async (id: string) => {
    const res = await fetch(`/api/task-definitions/${id}`, { method: "DELETE" });
    if (res.ok) {
      await refetchTasksAndDefinitions();
      return { ok: true };
    }
    const body = await res.json().catch(() => ({}));
    return { ok: false, error: body.error as string | undefined };
  };

  const handleCreateDefinition = async (
    name: string,
    icon: string,
    projectedMinutes: number,
    formFields: FormFieldDef[]
  ) => {
    await fetch("/api/task-definitions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, icon, projectedMinutes, formFields }),
    });
    await fetchDefinitions();
  };

  const consoleTaskLists: ConsoleTaskList[] | null =
    taskLists?.map((l) => ({
      _id: l._id,
      name: l.name,
      startTime: l.startTime,
      scheduledDays: l.scheduledDays,
      taskCount: l.tasks.length,
    })) ?? null;

  const selectedList = taskLists?.find((l) => l._id === selectedListId) ?? null;
  const resolvedTasks = selectedList && definitions ? resolveTasksForList(selectedList, definitions) : null;

  return (
    <div>
      <div className="flex items-start justify-between mb-1 gap-4">
        <h1 className="font-heading text-2xl text-text">Task Management</h1>
        <div className="flex-shrink-0 flex items-center gap-1 bg-card border border-border rounded-pill p-1">
          <button
            onClick={() => setView("lists")}
            className={`font-mono text-[11px] uppercase tracking-widest px-3 py-1.5 rounded-pill transition-colors ${
              view === "lists" ? "bg-olive text-text" : "text-dim hover:text-muted"
            }`}
          >
            Task Lists
          </button>
          <button
            onClick={() => setView("catalog")}
            className={`font-mono text-[11px] uppercase tracking-widest px-3 py-1.5 rounded-pill transition-colors ${
              view === "catalog" ? "bg-olive text-text" : "text-dim hover:text-muted"
            }`}
          >
            Task Catalog
          </button>
        </div>
      </div>
      <p className="font-body text-sm text-muted mb-4">
        {view === "lists"
          ? "The same task lists and tasks the mobile app uses — create, rename, schedule, and edit them here."
          : "Every saved task this location has, independent of which task lists (if any) place it."}
      </p>
      <LocationSwitcher
        isOwner={isOwner}
        activeLocationId={activeLocationId}
        onChanged={refetchTasksAndDefinitions}
      />
      {view === "lists" ? (
        <div className="flex items-start">
          <TaskListsPane
            taskLists={consoleTaskLists}
            selectedListId={selectedListId}
            onSelect={setSelectedListId}
            onCreate={handleCreateList}
            onUpdate={handleUpdateList}
            onDelete={handleDeleteList}
          />
          <TaskListDetailPane
            taskList={selectedList ? { _id: selectedList._id, name: selectedList.name } : null}
            tasks={resolvedTasks}
            onReorder={handleReorderTasks}
            onSaveTask={handleSaveTask}
            onRemoveTask={handleRemoveTask}
            onAddTask={handleAddTask}
            onAddExisting={handleAddExisting}
            onAddClone={handleAddClone}
          />
        </div>
      ) : (
        <TaskCatalogPane
          definitions={definitions}
          onSave={handleSaveDefinition}
          onDelete={handleDeleteDefinition}
          onCreate={handleCreateDefinition}
        />
      )}
    </div>
  );
}
