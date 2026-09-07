import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import TaskDefinition, { type InstructionStep } from "@/models/TaskDefinition";
import Task from "@/models/Task";
import TaskList from "@/models/TaskList";
import { sanitizeFormFields } from "@/lib/form-fields";
import { resolveSessionUser, isManagerOrAbove } from "@/lib/session";

export const dynamic = "force-dynamic";

// GET /api/task-definitions — the company's full saved-task catalog
// ("Company Task Catalog"), regardless of which lists currently use them —
// see docs/features/task-lists.md's "Company Task Catalog" section.
// Includes, per definition, which lists it's currently placed in (name +
// placement id), so the manager UI can show "used in Opening, Closing" and
// block/allow deletion accordingly. Also the pull-sync source for the
// offline SQLite cache's `task_definitions` table (companyId/updatedAt
// added for that purpose — see docs/features/offline.md).
export async function GET() {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });

  await connectDB();

  const definitions = await TaskDefinition.find({ companyId, isActive: true }).sort({ name: 1 }).lean();
  const placements = await Task.find({
    companyId,
    isActive: true,
    definitionId: { $in: definitions.map((d) => d._id) },
  }).lean();

  const taskLists = await TaskList.find({
    _id: { $in: placements.map((p) => p.taskListId) },
  }).select("name").lean();
  const listNameById = new Map(taskLists.map((tl) => [tl._id.toString(), tl.name]));

  const placementsByDefinitionId = new Map<string, Array<{ taskId: string; taskListId: string; taskListName: string }>>();
  for (const p of placements) {
    const key = p.definitionId.toString();
    const list = placementsByDefinitionId.get(key) ?? [];
    list.push({
      taskId: p._id.toString(),
      taskListId: p.taskListId.toString(),
      taskListName: listNameById.get(p.taskListId.toString()) ?? "",
    });
    placementsByDefinitionId.set(key, list);
  }

  return NextResponse.json(
    definitions.map((d) => ({
      _id: d._id.toString(),
      companyId,
      name: d.name,
      icon: d.icon,
      taskType: d.taskType,
      formFields: d.formFields ?? [],
      projectedMinutes: d.projectedMinutes,
      nfcTagUid: d.nfcTagUid ?? null,
      instructionSteps: (d.instructionSteps ?? []).map((s: InstructionStep) => ({
        _id: s._id.toString(),
        description: s.description ?? null,
        imageUrl: s.imageUrl ?? null,
      })),
      requiresPhoto: d.requiresPhoto ?? false,
      updatedAt: d.updatedAt ? new Date(d.updatedAt).toISOString() : null,
      placements: placementsByDefinitionId.get(d._id.toString()) ?? [],
    }))
  );
}

// POST /api/task-definitions — add a saved task straight to the company's
// catalog, with no list placement at all — the Admin Console's Task Catalog
// pane's "+ New task" (see docs/features/console-task-management.md). Every
// other creation path (AddTaskSheet's "Create custom task", POST
// /api/tasks with no definitionId) always creates a placement in the same
// request; this is the one way to get a catalog-only entry a manager can
// place into a list later, on their own schedule. Manager-only, same as
// this file's DELETE.
export async function POST(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const { name, icon, projectedMinutes, formFields } = await req.json();
  if (typeof name !== "string" || !name.trim() || typeof icon !== "string" || !icon) {
    return NextResponse.json({ error: "name and icon required" }, { status: 400 });
  }

  await connectDB();

  const definition = await TaskDefinition.create({
    companyId,
    templateId: null,
    name: name.trim(),
    icon,
    taskType: "form",
    projectedMinutes: typeof projectedMinutes === "number" ? projectedMinutes : 5,
    formFields: sanitizeFormFields(formFields),
    nfcTagUid: null,
    isActive: true,
  });

  return NextResponse.json({
    _id: definition._id.toString(),
    companyId,
    name: definition.name,
    icon: definition.icon,
    taskType: definition.taskType,
    formFields: definition.formFields,
    projectedMinutes: definition.projectedMinutes,
    nfcTagUid: null,
    instructionSteps: [],
    requiresPhoto: false,
    updatedAt: definition.updatedAt ? new Date(definition.updatedAt).toISOString() : null,
    placements: [],
  });
}
