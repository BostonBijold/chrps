import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import Task from "@/models/Task";
import TaskList from "@/models/TaskList";
import TaskDefinition from "@/models/TaskDefinition";
import { sanitizeFormFields } from "@/lib/form-fields";
import { resolveSessionUser, pickActiveLocationId } from "@/lib/session";
import { validateLocationId } from "@/lib/locations";

export const dynamic = "force-dynamic";

// POST /api/tasks — add a task to a task list, one of three ways:
//
// - `definitionId` supplied — place an EXISTING saved task (TaskDefinition)
//   AT THE CALLER'S OWN LOCATION into this list. Used by the "Manage Tasks &
//   Task Lists" catalog's "add existing task" flow — see
//   docs/features/task-lists.md's "Company Task Catalog" section. No new
//   TaskDefinition is created; every list this gets placed in (at this same
//   location) shares the same name/icon/fields/NFC binding.
// - `cloneFromDefinitionId` supplied — browse-to-clone a definition from a
//   DIFFERENT location (or anywhere in the company — see GET
//   /api/task-definitions?scope=company, "Company Task Catalog" as example
//   data other stores can draw from). Creates a brand-new TaskDefinition
//   scoped to the caller's own location, copying only the physically-
//   portable fields (name/icon/taskType/formFields/projectedMinutes/
//   templateId) — nfcTagUid/instructionSteps/requiresPhoto are never
//   copied, since a new store hasn't put up its own tag or taken its own
//   instruction photos yet.
// - `name`/`icon`/… supplied instead (the existing AddTaskSheet flow,
//   browsing the template catalog or building a custom task) — creates a
//   brand-new TaskDefinition at the caller's own location, then a placement
//   for it.
export async function POST(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);
  if (!locationId) return NextResponse.json({ error: "No location assigned" }, { status: 403 });

  const { taskListId, definitionId, cloneFromDefinitionId, templateId, name, icon, projectedMinutes, taskType, scheduledDays, successThreshold, formFields } = await req.json();

  if (!taskListId) {
    return NextResponse.json({ error: "taskListId required" }, { status: 400 });
  }
  if (!definitionId && !cloneFromDefinitionId && (!name?.trim() || !icon)) {
    return NextResponse.json({ error: "definitionId, cloneFromDefinitionId, or name and icon, required" }, { status: 400 });
  }

  await connectDB();

  const taskList = await TaskList.findOne({ _id: taskListId, companyId, locationId }).select("_id").lean();
  if (!taskList) return NextResponse.json({ error: "Task list not found" }, { status: 404 });

  let definition;
  if (definitionId) {
    // Same-location reference — the existing "Company Task Catalog" reuse
    // flow, unchanged, just now scoped to locationId too: a foreign-
    // location definitionId 404s exactly like any other not-found id.
    definition = await TaskDefinition.findOne({ _id: definitionId, companyId, locationId, isActive: true });
  } else if (cloneFromDefinitionId) {
    // Cross-location clone — deliberately NO locationId filter on this
    // lookup (that's the whole point: browsing another store's, or the
    // company's, catalog as example data). See the comment above.
    const source = await TaskDefinition.findOne({ _id: cloneFromDefinitionId, companyId, isActive: true });
    if (!source) return NextResponse.json({ error: "Task not found in catalog" }, { status: 404 });
    definition = await TaskDefinition.create({
      companyId,
      locationId,
      templateId: source.templateId ?? null,
      name: source.name,
      icon: source.icon,
      taskType: source.taskType,
      projectedMinutes: source.projectedMinutes,
      formFields: source.formFields ?? [],
      nfcTagUid: null,
      instructionSteps: [],
      requiresPhoto: false,
      isActive: true,
    });
  } else {
    definition = await TaskDefinition.create({
      companyId,
      locationId,
      templateId: templateId ?? null,
      name: name.trim(),
      icon,
      taskType: taskType ?? "form",
      projectedMinutes: taskType === "checkbox" ? 0 : (projectedMinutes ?? 15),
      formFields: sanitizeFormFields(formFields),
      nfcTagUid: null,
      isActive: true,
    });
  }

  if (!definition) {
    return NextResponse.json({ error: "Task not found in catalog" }, { status: 404 });
  }

  // Place at end of current list
  const maxOrder = await Task.findOne({ taskListId, companyId, locationId, isActive: true })
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
    locationId,
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
