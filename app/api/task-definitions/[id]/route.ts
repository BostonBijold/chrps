import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import TaskDefinition, { type InstructionStep } from "@/models/TaskDefinition";
import Task from "@/models/Task";
import { sanitizeFormFields } from "@/lib/form-fields";
import { sanitizeInstructionSteps } from "@/lib/instruction-steps";
import { resolveSessionUser, isManagerOrAbove } from "@/lib/session";

export const dynamic = "force-dynamic";

// PATCH /api/task-definitions/[id] — edit a catalog entry directly, by its
// own definitionId rather than through one of its placements. Needed for a
// definition with zero active placements ("not placed in any list" — see
// GET /api/task-definitions), which PATCH /api/tasks/[id] can't reach since
// that route keys off a Task placement id. Manager-only, same as this
// route's own DELETE below. Every list this task IS placed in still sees
// the change too — name/icon/formFields/projectedMinutes all live on the
// shared TaskDefinition, not any one placement (see
// docs/features/task-lists.md's "Company Task Catalog" section).
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const updates = await req.json();
  const patch: Record<string, unknown> = {};
  if (typeof updates.name === "string" && updates.name.trim()) patch.name = updates.name.trim();
  if (typeof updates.icon === "string" && updates.icon) patch.icon = updates.icon;
  if (typeof updates.projectedMinutes === "number") patch.projectedMinutes = updates.projectedMinutes;
  if ("formFields" in updates) patch.formFields = sanitizeFormFields(updates.formFields);
  if ("instructionSteps" in updates) patch.instructionSteps = sanitizeInstructionSteps(updates.instructionSteps);
  if (typeof updates.requiresPhoto === "boolean") patch.requiresPhoto = updates.requiresPhoto;

  await connectDB();

  const definition = await TaskDefinition.findOneAndUpdate(
    { _id: params.id, companyId, isActive: true },
    { $set: patch },
    { new: true }
  ).lean();
  if (!definition) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    _id: definition._id.toString(),
    name: definition.name,
    icon: definition.icon,
    taskType: definition.taskType,
    formFields: definition.formFields ?? [],
    projectedMinutes: definition.projectedMinutes,
    nfcTagUid: definition.nfcTagUid ?? null,
    instructionSteps: (definition.instructionSteps ?? []).map((s: InstructionStep) => ({
      _id: s._id.toString(),
      description: s.description ?? null,
      imageUrl: s.imageUrl ?? null,
    })),
    requiresPhoto: definition.requiresPhoto ?? false,
  });
}

// DELETE /api/task-definitions/[id] — removes a saved task from the
// company's catalog entirely (soft delete). Manager-only. Blocked while any
// active Task placement still references it — a manager has to remove it
// from every list first ("used in Opening, Closing — remove those first"),
// per the deliberate choice in docs/features/task-lists.md's "Company Task
// Catalog" section: simplest to build, no cascading-delete surprise state.
// Removing a single placement (not the whole definition) is
// DELETE /api/tasks/[id] instead — unaffected by this route.
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });

  await connectDB();

  const definition = await TaskDefinition.findOne({ _id: params.id, companyId });
  if (!definition) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const activePlacementCount = await Task.countDocuments({ companyId, definitionId: definition._id, isActive: true });
  if (activePlacementCount > 0) {
    return NextResponse.json(
      { error: `Still used in ${activePlacementCount} task list${activePlacementCount === 1 ? "" : "s"} — remove it from those first.` },
      { status: 409 }
    );
  }

  definition.isActive = false;
  await definition.save();

  return NextResponse.json({ ok: true });
}
