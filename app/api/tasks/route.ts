import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import Task from "@/models/Task";
import TaskDefinition from "@/models/TaskDefinition";
import { sanitizeFormFields } from "@/lib/form-fields";
import { resolveSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

// POST /api/tasks — add a task to a task list, either of two ways:
//
// - `definitionId` supplied — place an EXISTING company saved task
//   (TaskDefinition) into this list. New capability, used by the "Manage
//   Tasks & Task Lists" catalog's "add existing task" flow — see
//   docs/features/task-lists.md's "Company Task Catalog" section. No new
//   TaskDefinition is created; every list this gets placed in shares the
//   same name/icon/fields/NFC binding.
// - `name`/`icon`/… supplied instead (the existing AddTaskSheet flow,
//   browsing the template catalog or building a custom task) — creates a
//   brand-new TaskDefinition, then a placement for it. Unchanged behavior
//   from a caller's perspective; internally this now writes two documents
//   instead of one.
export async function POST(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });

  const { taskListId, definitionId, templateId, name, icon, projectedMinutes, taskType, scheduledDays, successThreshold, formFields } = await req.json();

  if (!taskListId) {
    return NextResponse.json({ error: "taskListId required" }, { status: 400 });
  }
  if (!definitionId && (!name?.trim() || !icon)) {
    return NextResponse.json({ error: "definitionId, or name and icon, required" }, { status: 400 });
  }

  await connectDB();

  const definition = definitionId
    ? await TaskDefinition.findOne({ _id: definitionId, companyId, isActive: true })
    : await TaskDefinition.create({
        companyId,
        templateId: templateId ?? null,
        name: name.trim(),
        icon,
        taskType: taskType ?? "form",
        projectedMinutes: taskType === "checkbox" ? 0 : (projectedMinutes ?? 15),
        formFields: sanitizeFormFields(formFields),
        nfcTagUid: null,
        isActive: true,
      });

  if (!definition) {
    return NextResponse.json({ error: "Task not found in catalog" }, { status: 404 });
  }

  // Place at end of current list
  const maxOrder = await Task.findOne({ taskListId, companyId, isActive: true })
    .sort({ order: -1 })
    .lean();
  const nextOrder = maxOrder ? maxOrder.order + 1 : 0;

  // Default: every day, full threshold — existing (pre-schedule) behavior.
  const days: number[] = Array.isArray(scheduledDays) && scheduledDays.length > 0 ? scheduledDays : [0, 1, 2, 3, 4, 5, 6];
  // Clamp rather than reject — a threshold that can't mathematically be hit
  // is silently capped at the number of scheduled days instead.
  const threshold = Math.max(1, Math.min(typeof successThreshold === "number" ? successThreshold : days.length, days.length));

  const task = await Task.create({
    companyId,
    taskListId,
    definitionId: definition._id,
    projectedMinutes: null, // no override yet — inherits the definition's default
    order: nextOrder,
    isActive: true,
    scheduledDays: days,
    successThreshold: threshold,
  });

  return NextResponse.json({
    _id: task._id.toString(),
    definitionId: definition._id.toString(),
    name: definition.name,
    icon: definition.icon,
    projectedMinutes: definition.projectedMinutes,
    order: task.order,
    taskType: definition.taskType,
    scheduledDays: task.scheduledDays,
    successThreshold: task.successThreshold,
    formFields: definition.formFields,
    nfcTagUid: definition.nfcTagUid,
    instructionSteps: definition.instructionSteps ?? [],
    requiresPhoto: definition.requiresPhoto ?? false,
  });
}
