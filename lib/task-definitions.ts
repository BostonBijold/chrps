import mongoose from "mongoose";
import TaskDefinition from "@/models/TaskDefinition";
import Task from "@/models/Task";
import TaskList from "@/models/TaskList";
import TaskLog from "@/models/TaskLog";
import InventoryItemType from "@/models/InventoryItemType";
import Location from "@/models/Location";
import type { TaskType, FormFieldDef, InstructionStep } from "@/models/TaskDefinition";
import { pickMostRelevantPlacement } from "./placement-resolution";
export { pickMostRelevantPlacement } from "./placement-resolution";

// Joins a Task placement onto its TaskDefinition — see models/Task.ts and
// models/TaskDefinition.ts for the split. Every reader in the app that used
// to pull name/icon/taskType/formFields/nfcTagUid straight off a Task
// document now gets the identical flat shape back from here instead, with
// projectedMinutes resolved (the placement's own override, or the
// definition's default) — so nothing downstream of this (API response
// shapes, RowItem/TimerItem, StreakDots, Reports) needed to change at
// all, only where these fields are actually stored.

export interface ResolvedTaskFields {
  name: string;
  icon: string;
  taskType: TaskType;
  formFields: FormFieldDef[];
  nfcTagUid: string | null;
  templateId: string | null;
  projectedMinutes: number;
  instructionSteps: InstructionStep[];
  requiresPhoto: boolean;
}

// Bare minimum shape resolveTasks needs from a lean Task doc — callers can
// pass richer lean docs through and keep every other field via the `T`
// generic (createdAt, _id, taskListId, etc. all pass through untouched).
interface LeanTaskLike {
  definitionId: mongoose.Types.ObjectId | string;
  projectedMinutes?: number | null;
}

const FALLBACK: ResolvedTaskFields = {
  name: "Deleted task",
  icon: "help-circle",
  taskType: "form",
  formFields: [],
  nfcTagUid: null,
  templateId: null,
  projectedMinutes: 0,
  instructionSteps: [],
  requiresPhoto: false,
};

// Batch join — one query for every distinct definitionId referenced,
// regardless of how many placements share it. A placement whose definition
// can't be found (shouldn't happen under normal operation — deleting a
// definition is blocked while placements reference it, see
// app/api/task-definitions/[id]/route.ts — but defensive against a stray
// reference) falls back to a visible placeholder rather than throwing.
export async function resolveTasks<T extends LeanTaskLike>(tasks: T[]): Promise<Array<T & ResolvedTaskFields>> {
  const definitionIds = Array.from(new Set(tasks.map((t) => t.definitionId.toString())));
  const definitions = definitionIds.length > 0
    ? await TaskDefinition.find({ _id: { $in: definitionIds } }).lean()
    : [];
  const byId = new Map(definitions.map((d) => [d._id.toString(), d]));

  return tasks.map((t) => {
    const def = byId.get(t.definitionId.toString());
    return {
      ...t,
      name: def?.name ?? FALLBACK.name,
      icon: def?.icon ?? FALLBACK.icon,
      taskType: (def?.taskType as TaskType | undefined) ?? FALLBACK.taskType,
      formFields: def?.formFields ?? FALLBACK.formFields,
      nfcTagUid: def?.nfcTagUid ?? FALLBACK.nfcTagUid,
      templateId: def?.templateId ? def.templateId.toString() : FALLBACK.templateId,
      projectedMinutes: t.projectedMinutes ?? def?.projectedMinutes ?? FALLBACK.projectedMinutes,
      instructionSteps: def?.instructionSteps ?? FALLBACK.instructionSteps,
      requiresPhoto: def?.requiresPhoto ?? FALLBACK.requiresPhoto,
    };
  });
}

export async function resolveTask<T extends LeanTaskLike>(task: T): Promise<T & ResolvedTaskFields> {
  const [resolved] = await resolveTasks([task]);
  return resolved;
}

// Shared by both NFC-binding routes — app/api/tasks/[id]/nfc-tag (resolves
// a specific list placement to its definitionId first) and
// app/api/task-definitions/[id]/nfc-tag (binds a definition directly, so it
// works even for one not yet placed in any list). The primary bind/unbind
// is scoped to BOTH companyId and locationId — a definition belongs to
// exactly one store, so this is the actual authorization fix that prevents
// binding/unbinding a definition that only exists at a different location.
//
// A physical tag can now back MORE THAN ONE target (see
// docs/features/nfc.md's "Multi-target binding" — e.g. the same freezer tag
// backing both a temperature-log task and an Inventory item), so binding
// here no longer clears the UID off any other definition — it just sets it
// on this one, leaving any existing binding(s) elsewhere intact. GET
// /api/tasks/by-nfc-uid is what fans a scan back out to every matching
// target (itself now locationId-filtered for TaskDefinition matches) and
// disambiguates when there's more than one.
//
// `alsoBoundTo`'s own collision-check query stays COMPANY-WIDE, deliberately
// not locationId-filtered: seeing "this UID is also used at your other
// store" is genuinely useful signal for a manager who scanned the wrong
// physical tag, not something to hide. It's purely informational — it never
// blocks the bind — and is checked across BOTH TaskDefinition and
// InventoryItemType (lib/inventory.ts's own bindInventoryNfcTag does the
// exact mirror-image check, now that InventoryItemType is location-owned
// too — see docs/features/locations.md's "Location scoping"), since either
// collection could already be claiming this UID. Each entry now carries its
// own locationName so the UI can say exactly where the collision is, since
// a bare name is ambiguous once definitions are location-owned (two stores
// can legitimately have an identically-named "Walk-in Fridge Temp").
export async function bindNfcTag(companyId: string, locationId: string | null, definitionId: string, uid: string) {
  const normalizedUid = uid.toLowerCase();
  const definition = await TaskDefinition.findOneAndUpdate(
    { _id: definitionId, companyId, locationId },
    { $set: { nfcTagUid: normalizedUid } },
    { returnDocument: "after" }
  );
  if (!definition) return null;

  const [otherDefinitions, boundItemTypes] = await Promise.all([
    TaskDefinition.find(
      { companyId, nfcTagUid: normalizedUid, isActive: true, _id: { $ne: definitionId } },
      { name: 1, locationId: 1 }
    ).lean(),
    InventoryItemType.find({ companyId, nfcTagUid: normalizedUid, isActive: true }, { name: 1 }).lean(),
  ]);

  const otherLocationIds = Array.from(
    new Set(otherDefinitions.map((d) => d.locationId).filter((id): id is string => !!id))
  );
  const locationNameById = new Map(
    otherLocationIds.length > 0
      ? (await Location.find({ _id: { $in: otherLocationIds } }, { name: 1 }).lean()).map((l) => [
          l._id.toString(),
          l.name,
        ])
      : []
  );

  const alsoBoundTo = [
    ...otherDefinitions.map((d) => ({
      name: d.name,
      locationName: d.locationId ? locationNameById.get(d.locationId) ?? null : null,
    })),
    ...boundItemTypes.map((it) => ({ name: it.name, locationName: null })),
  ];

  return { definition, alsoBoundTo };
}

export async function unbindNfcTag(companyId: string, locationId: string | null, definitionId: string) {
  return TaskDefinition.findOneAndUpdate(
    { _id: definitionId, companyId, locationId },
    { $set: { nfcTagUid: null } },
    { returnDocument: "after" }
  );
}

// Resolves a scanned/bound TaskDefinition to whichever of its active
// placements is "most relevant right now" — needed because, unlike before
// the catalog split, one physical tag (bound at the definition level) can
// now back more than one list placement (e.g. the fridge-temp check placed
// in both the opening and closing lists). Thin Mongo-reading wrapper around
// pickMostRelevantPlacement above — see that function for the actual
// selection logic and rationale.
export async function resolveMostRelevantPlacement(
  companyId: string,
  locationId: string | null,
  definitionId: string,
  localDate: string,
  nowMinutesLocal: number | null
): Promise<mongoose.Types.ObjectId | null> {
  const placements = await Task.find({ companyId, locationId, definitionId, isActive: true }).lean();
  if (placements.length === 0) return null;

  const taskLists = await TaskList.find({
    _id: { $in: placements.map((p) => p.taskListId) },
    companyId,
    locationId,
  }).lean();

  const logs = await TaskLog.find({
    companyId,
    locationId,
    date: localDate,
    taskId: { $in: placements.map((p) => p._id) },
  }).lean();

  const placementById = new Map(placements.map((p) => [p._id.toString(), p]));
  const bestId = pickMostRelevantPlacement(
    placements.map((p) => ({ id: p._id.toString(), taskListId: p.taskListId.toString(), order: p.order })),
    taskLists.map((tl) => ({ id: tl._id.toString(), order: tl.order, startTime: tl.startTime ?? null })),
    logs.map((l) => ({ taskId: l.taskId.toString(), state: l.state })),
    nowMinutesLocal
  );
  return bestId ? placementById.get(bestId)!._id : null;
}
