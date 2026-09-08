import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import Task from "@/models/Task";
import TaskDefinition from "@/models/TaskDefinition";
import TaskList from "@/models/TaskList";
import { sanitizeFormFields } from "@/lib/form-fields";
import { resolveTask } from "@/lib/task-definitions";
import { resolveSessionUser, pickActiveLocationId } from "@/lib/session";
import { validateLocationId } from "@/lib/locations";

export const dynamic = "force-dynamic";

// DELETE /api/tasks/[id] — remove from the company's task list (soft
// delete). Placement-only: the underlying TaskDefinition (and any other
// list's placement of it) is untouched — it just drops back into the
// "Company Task Catalog" with one fewer placement, ready to be placed
// again. See docs/features/task-lists.md's "Company Task Catalog" section.
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);

  await connectDB();

  const task = await Task.findOne({ _id: params.id, companyId, locationId });
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Soft delete — keeps log history intact
  task.isActive = false;
  await task.save();

  // If that was the last active task in its list, the list itself has
  // nothing left to show — soft-delete it too so it drops off the Tasks
  // page instead of lingering as an empty card. Same convention as a
  // manager-initiated list delete (app/api/task-lists/[taskListId]/route.ts).
  const remaining = await Task.countDocuments({
    taskListId: task.taskListId,
    companyId,
    locationId,
    isActive: true,
  });
  if (remaining === 0) {
    await TaskList.updateOne(
      { _id: task.taskListId, companyId, locationId },
      { $set: { isActive: false } }
    );
  }

  return NextResponse.json({ ok: true });
}

// PATCH /api/tasks/[id] — update a task. Fields split between the two
// layers they actually belong to (see models/Task.ts / TaskDefinition.ts):
// name/icon/taskType/formFields write through to the TaskDefinition and so
// cascade to every list this task is placed in ("the same physical check"),
// while scheduledDays/successThreshold/projectedMinutes stay placement-only
// — projectedMinutes in particular becomes this ONE placement's override of
// the definition's default, not the default itself, since it's always
// edited from a specific list's row.
const DEFINITION_FIELDS = ["name", "icon", "taskType", "formFields", "requiresPhoto"] as const;
const PLACEMENT_FIELDS = ["projectedMinutes", "scheduledDays", "successThreshold"] as const;

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);

  const updates = await req.json();
  const definitionUpdates: Partial<Record<(typeof DEFINITION_FIELDS)[number], unknown>> = {};
  const placementUpdates: Partial<Record<(typeof PLACEMENT_FIELDS)[number], unknown>> = {};
  for (const key of DEFINITION_FIELDS) if (key in updates) definitionUpdates[key] = updates[key];
  for (const key of PLACEMENT_FIELDS) if (key in updates) placementUpdates[key] = updates[key];
  if ("formFields" in definitionUpdates) definitionUpdates.formFields = sanitizeFormFields(definitionUpdates.formFields);

  await connectDB();

  const task = await Task.findOne({ _id: params.id, companyId, locationId }).lean();
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Clamp threshold against whichever scheduledDays is now in effect —
  // the one just sent, or the task's existing one if only the threshold
  // changed — rather than rejecting a mathematically impossible value.
  // If neither is actually changing the threshold, preserve whatever it
  // already was (only clamping it down, never bumping it up to days.length
  // just because scheduledDays changed for an unrelated reason).
  if ("scheduledDays" in placementUpdates || "successThreshold" in placementUpdates) {
    const days = Array.isArray(placementUpdates.scheduledDays)
      ? (placementUpdates.scheduledDays as number[])
      : task.scheduledDays ?? [0, 1, 2, 3, 4, 5, 6];
    const requestedThreshold = "successThreshold" in placementUpdates
      ? Number(placementUpdates.successThreshold)
      : task.successThreshold ?? days.length;
    placementUpdates.successThreshold = Math.max(1, Math.min(requestedThreshold, days.length));
  }

  if (Object.keys(definitionUpdates).length > 0) {
    await TaskDefinition.updateOne({ _id: task.definitionId, companyId, locationId }, { $set: definitionUpdates });
  }
  if (Object.keys(placementUpdates).length > 0) {
    await Task.updateOne({ _id: task._id, companyId, locationId }, { $set: placementUpdates });
  }

  const updatedTask = await Task.findOne({ _id: task._id, companyId, locationId }).lean();
  if (!updatedTask) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const resolved = await resolveTask(updatedTask);

  return NextResponse.json({
    _id: resolved._id.toString(),
    name: resolved.name,
    icon: resolved.icon,
    projectedMinutes: resolved.projectedMinutes,
    taskType: resolved.taskType,
    scheduledDays: resolved.scheduledDays,
    successThreshold: resolved.successThreshold,
    formFields: resolved.formFields,
    requiresPhoto: resolved.requiresPhoto,
  });
}
