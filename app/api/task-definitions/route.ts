import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import TaskDefinition, { type InstructionStep } from "@/models/TaskDefinition";
import Task from "@/models/Task";
import TaskList from "@/models/TaskList";
import Location from "@/models/Location";
import { sanitizeFormFields } from "@/lib/form-fields";
import { resolveSessionUser, isManagerOrAbove, pickActiveLocationId } from "@/lib/session";
import { validateLocationId } from "@/lib/locations";

export const dynamic = "force-dynamic";

// GET /api/task-definitions?scope=own|company — a saved-task catalog. Two
// modes (see docs/features/task-lists.md's "Company Task Catalog" section):
//
// - `scope=own` (default, unchanged access — any signed-in company user):
//   this location's own catalog, regardless of which of this location's
//   lists currently use each entry. Includes, per definition, which lists
//   it's currently placed in (name + placement id) — always at THIS same
//   location — so the manager UI can show "used in Opening, Closing" and
//   block/allow deletion accordingly. Also the pull-sync source for the
//   offline SQLite cache's `task_definitions` table (companyId/updatedAt
//   added for that purpose — see docs/features/offline.md).
// - `scope=company` (new, manager-or-above only): a read-only browse of
//   EVERY location's definitions in the company — "example data" a manager
//   can clone from for their own store (see POST /api/tasks's
//   cloneFromDefinitionId). nfcTagUid/instructionSteps are always nulled
//   out here regardless of the stored value — neither is portable, and the
//   UI must never render another store's tag UID or instruction photos —
//   and no `placements` array is included (not this manager's own
//   configuration to act on).
export async function GET(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });

  await connectDB();

  const scope = req.nextUrl.searchParams.get("scope") === "company" ? "company" : "own";

  if (scope === "company") {
    if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });

    const definitions = await TaskDefinition.find({ companyId, isActive: true }).sort({ name: 1 }).lean();
    const locationIds = Array.from(new Set(definitions.map((d) => d.locationId).filter((id): id is string => !!id)));
    const locationNameById = new Map(
      locationIds.length > 0
        ? (await Location.find({ _id: { $in: locationIds } }, { name: 1 }).lean()).map((l) => [l._id.toString(), l.name])
        : []
    );

    return NextResponse.json(
      definitions.map((d) => ({
        _id: d._id.toString(),
        companyId,
        locationId: d.locationId ?? null,
        locationName: d.locationId ? locationNameById.get(d.locationId) ?? null : null,
        name: d.name,
        icon: d.icon,
        taskType: d.taskType,
        formFields: d.formFields ?? [],
        projectedMinutes: d.projectedMinutes,
        nfcTagUid: null,
        instructionSteps: [],
        requiresPhoto: false,
        updatedAt: d.updatedAt ? new Date(d.updatedAt).toISOString() : null,
      }))
    );
  }

  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);

  const definitions = await TaskDefinition.find({ companyId, locationId, isActive: true }).sort({ name: 1 }).lean();
  const placements = await Task.find({
    companyId,
    locationId,
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
  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);
  if (!locationId) return NextResponse.json({ error: "No location assigned" }, { status: 403 });

  const { name, icon, projectedMinutes, formFields } = await req.json();
  if (typeof name !== "string" || !name.trim() || typeof icon !== "string" || !icon) {
    return NextResponse.json({ error: "name and icon required" }, { status: 400 });
  }

  await connectDB();

  const definition = await TaskDefinition.create({
    companyId,
    locationId,
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
