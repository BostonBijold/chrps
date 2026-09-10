import mongoose from "mongoose";
import InventoryItemType from "@/models/InventoryItemType";
import InventoryLog from "@/models/InventoryLog";
import InventoryGroup from "@/models/InventoryGroup";
import TaskDefinition from "@/models/TaskDefinition";
import TaskInventoryLink from "@/models/TaskInventoryLink";
import Task from "@/models/Task";
import Location from "@/models/Location";
import { claimNfcTag } from "@/lib/nfc-tags";

// Thrown by assertInventoryNfcVerified below — every route that can write
// an InventoryLog for an item with nfcRequiredToLog must catch this and
// turn it into a clean 4xx rather than letting it bubble up as a 500.
export class InventoryNfcRequiredError extends Error {
  constructor() {
    super("This item requires scanning its linked NFC tag to log a count — use Save via NFC.");
    this.name = "InventoryNfcRequiredError";
  }
}

// Mirrors lib/task-log-actions.ts's assertNfcVerified exactly, one layer
// down: gates POST /api/inventory-logs the same way a bound TaskDefinition
// gates task completion, but only when the item type has opted in via
// nfcRequiredToLog (default false — see docs/features/inventory.md's "NFC
// enforcement"). A required-but-unbound item (nfcTagUid: null) can never be
// satisfied — a valid-but-inert state, not specially handled here.
export async function assertInventoryNfcVerified(itemTypeId: string, verifiedNfcUid?: string | null) {
  const itemType = await InventoryItemType.findById(itemTypeId).select("nfcTagUid nfcRequiredToLog").lean();
  if (!itemType) return;
  if (itemType.nfcRequiredToLog && (!itemType.nfcTagUid || itemType.nfcTagUid !== verifiedNfcUid)) {
    throw new InventoryNfcRequiredError();
  }
}

// Binds a physical tag's raw UID to an item type's storage location — see
// docs/features/nfc.md's "Multi-target binding". Mirrors
// lib/task-definitions.ts's bindNfcTag one layer over, now that
// InventoryItemType is location-owned too (see docs/features/locations.md's
// "Location scoping"): the primary bind is scoped to BOTH companyId and
// locationId — an item type belongs to exactly one store, so this is the
// actual authorization fix that prevents binding/unbinding an item type
// that only exists at a different location.
//
// `alsoBoundTo`'s own collision-check query stays COMPANY-WIDE, deliberately
// not locationId-filtered — same reasoning as bindNfcTag's own comment:
// seeing "this UID is also used at your other store" is genuinely useful
// signal for a manager who scanned the wrong physical tag, not something to
// hide. It's purely informational — it never blocks the bind — and is
// checked across BOTH InventoryItemType and TaskDefinition, since either
// collection could already be claiming this UID. Each entry now carries its
// own locationName so the UI can say exactly where the collision is, since
// a bare name is ambiguous once both are location-owned (two stores can
// legitimately have an identically-named "Walk-in Freezer").
// Gated on the tag registry — mirrors lib/task-definitions.ts's bindNfcTag
// exactly (claim-then-bind in one step, no separate claim UI), see
// docs/features/nfc.md's "Claiming".
export async function bindInventoryNfcTag(
  companyId: string,
  locationId: string | null,
  userId: string,
  itemTypeId: string,
  uid: string
) {
  const normalizedUid = uid.toLowerCase();
  await claimNfcTag(companyId, locationId, userId, normalizedUid);
  const itemType = await InventoryItemType.findOneAndUpdate(
    { _id: itemTypeId, companyId, locationId },
    { $set: { nfcTagUid: normalizedUid } },
    { returnDocument: "after" }
  );
  if (!itemType) return null;

  const [otherItemTypes, boundTasks] = await Promise.all([
    InventoryItemType.find(
      { companyId, nfcTagUid: normalizedUid, isActive: true, _id: { $ne: itemTypeId } },
      { name: 1, locationId: 1 }
    ).lean(),
    TaskDefinition.find({ companyId, nfcTagUid: normalizedUid, isActive: true }, { name: 1, locationId: 1 }).lean(),
  ]);

  const otherLocationIds = Array.from(
    new Set([...otherItemTypes, ...boundTasks].map((d) => d.locationId).filter((id): id is string => !!id))
  );
  const locationNameById = new Map(
    otherLocationIds.length > 0
      ? (await Location.find({ _id: { $in: otherLocationIds } }, { name: 1 }).lean()).map((l) => [
          l._id.toString(),
          l.name,
        ])
      : []
  );

  const alsoBoundTo = [...otherItemTypes, ...boundTasks].map((d) => ({
    name: d.name,
    locationName: d.locationId ? locationNameById.get(d.locationId) ?? null : null,
  }));

  return { itemType, alsoBoundTo };
}

export async function unbindInventoryNfcTag(companyId: string, locationId: string | null, itemTypeId: string) {
  return InventoryItemType.findOneAndUpdate(
    { _id: itemTypeId, companyId, locationId },
    { $set: { nfcTagUid: null } },
    { returnDocument: "after" }
  );
}

// Archives an InventoryGroup and, in the same request, sets every member
// InventoryItemType's groupId back to null ("Ungrouped") — see
// docs/features/inventory.md's "Grouping". Items and their InventoryLog
// history are untouched either way; only the group label goes away. Scoped
// to locationId too, now that both InventoryGroup and InventoryItemType are
// location-owned (see docs/features/locations.md's "Location scoping") —
// though in practice a group's members can never be at a different
// location than the group itself, so this is defensive/consistent rather
// than load-bearing.
export async function archiveInventoryGroup(companyId: string, locationId: string | null, groupId: string) {
  const group = await InventoryGroup.findOne({ _id: groupId, companyId, locationId });
  if (!group) return null;

  const ungroupedCount = await InventoryItemType.countDocuments({ companyId, locationId, groupId, isActive: true });
  await InventoryItemType.updateMany({ companyId, locationId, groupId }, { $set: { groupId: null } });

  group.isActive = false;
  await group.save();

  return { group, ungroupedCount };
}

// Batch "most recent log per item type" — the Inventory tab's list view
// needs a current-count + last-logged-by/when for every active item type in
// one shot, not a per-row round trip. Pulls every log for the given
// itemTypeIds sorted newest-first and keeps only the first (= most recent)
// row seen per id, same Map-based join style as lib/task-definitions.ts's
// resolveTasks.
export async function getLatestInventoryLogs(
  companyId: string,
  locationId: string | null,
  itemTypeIds: mongoose.Types.ObjectId[]
): Promise<Map<string, { count: number; loggedByUserId: string; loggedAt: Date }>> {
  if (itemTypeIds.length === 0) return new Map();

  // The catalog (InventoryItemType) stays company-wide and shared across
  // locations, but its count is tracked independently per location — see
  // docs/features/locations.md's open questions.
  const logs = await InventoryLog.find({ companyId, locationId, itemTypeId: { $in: itemTypeIds } })
    .sort({ loggedAt: -1 })
    .lean();

  const latestByItemTypeId = new Map<string, { count: number; loggedByUserId: string; loggedAt: Date }>();
  for (const log of logs) {
    const key = log.itemTypeId.toString();
    if (!latestByItemTypeId.has(key)) {
      latestByItemTypeId.set(key, { count: log.count, loggedByUserId: log.loggedByUserId, loggedAt: log.loggedAt });
    }
  }
  return latestByItemTypeId;
}

// ── Task ↔ Inventory Linking — see docs/features/inventory.md's
// "Task ↔ Inventory Linking" section. TaskInventoryLink lives at the
// TaskDefinition level (not per Task placement) — same reasoning as
// TaskDefinition.nfcTagUid, a link set from one list's edit screen is
// shared by every list this saved task is placed in. Callers resolve a
// specific placement's Task._id to its definitionId first (see
// app/api/tasks/[id]/inventory-links/route.ts), same split as
// bindNfcTag/unbindNfcTag above. ──

export interface InventoryLinkView {
  itemTypeId: string;
  name: string;
  unit: string | null;
  nfcTagUid: string | null;
  nfcRequiredToLog: boolean;
  required: boolean;
}

// Joined with each linked InventoryItemType's own name/unit/nfcTagUid so
// both TaskFormScreen.tsx (renders the count inputs) and
// TaskListEditView.tsx (renders the "Linked Inventory" management panel)
// get one flat shape with no second round trip. A link whose item type has
// since been archived is silently dropped — same "don't show what's gone"
// convention as resolveTasks' FALLBACK, except here it's simpler to just
// omit rather than show a placeholder, since a stale link is meaningless to
// both screens once its item no longer exists.
export async function getInventoryLinksForTaskDefinition(
  companyId: string,
  locationId: string | null,
  taskDefinitionId: string
): Promise<InventoryLinkView[]> {
  const links = await TaskInventoryLink.find({ companyId, taskDefinitionId }).lean();
  if (links.length === 0) return [];

  // locationId-filtered — a link's item type now belongs to exactly the
  // same location as the task definition itself (enforced at link-creation
  // time by addOrUpdateInventoryLink below), so this also silently drops
  // any stale link left over from before InventoryItemType became
  // location-owned, same "don't show what's gone" convention as an
  // archived item's link being dropped.
  const itemTypes = await InventoryItemType.find({
    _id: { $in: links.map((l) => l.itemTypeId) },
    companyId,
    locationId,
    isActive: true,
  }).lean();
  const itemTypeById = new Map(itemTypes.map((it) => [it._id.toString(), it]));

  return links
    .map((l) => {
      const itemType = itemTypeById.get(l.itemTypeId.toString());
      if (!itemType) return null;
      return {
        itemTypeId: itemType._id.toString(),
        name: itemType.name,
        unit: itemType.unit ?? null,
        nfcTagUid: itemType.nfcTagUid ?? null,
        nfcRequiredToLog: itemType.nfcRequiredToLog ?? false,
        required: l.required,
      };
    })
    .filter((l): l is InventoryLinkView => l !== null);
}

// Manager-only create/update — re-linking an already-linked item just
// updates `required` on the existing row (the schema's unique index on
// (taskDefinitionId, itemTypeId) is what makes this an upsert rather than
// risking a duplicate-key error). Validates the item type actually belongs
// to the SAME location as the task definition first — now that both
// InventoryItemType and TaskDefinition are location-owned (see
// docs/features/locations.md's "Location scoping"), a link should never be
// creatable across locations; returns null (caller 404s) rather than
// silently linking a foreign-location item that would never resolve
// through getInventoryLinksForTaskDefinition's own locationId filter above.
export async function addOrUpdateInventoryLink(
  companyId: string,
  locationId: string | null,
  taskDefinitionId: string,
  itemTypeId: string,
  required: boolean
) {
  const itemType = await InventoryItemType.findOne({ _id: itemTypeId, companyId, locationId, isActive: true })
    .select("_id")
    .lean();
  if (!itemType) return null;

  return TaskInventoryLink.findOneAndUpdate(
    { companyId, taskDefinitionId, itemTypeId },
    { $set: { required } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  );
}

export async function removeInventoryLink(companyId: string, taskDefinitionId: string, itemTypeId: string) {
  return TaskInventoryLink.deleteOne({ companyId, taskDefinitionId, itemTypeId });
}

// Writes one InventoryLog row per entry that's actually linked to this
// task — called from app/api/task-logs's PATCH handler right after a
// task-form completion ("done") write succeeds, see
// docs/features/inventory.md's "Task ↔ Inventory Linking". Entries for an
// itemTypeId NOT actually linked to this task's definition are silently
// dropped (defensive — the client only ever sends what TaskFormScreen
// fetched as this task's own links, but never trust a client-asserted
// itemTypeId outright). verifiedNfcUid is re-checked against each item
// type's OWN bound tag here, same as POST /api/inventory-logs — a value
// that doesn't actually match is dropped, never stored as verified, even
// though it already verified the TASK's completion; the two are separate
// claims that happen to reuse the same scanned UID when they line up.
export async function writeInventoryLogsForTaskCompletion(
  companyId: string,
  locationId: string | null,
  loggedByUserId: string,
  taskId: string,
  entries: Array<{ itemTypeId: string; count: number; verifiedNfcUid?: string | null }>
) {
  if (entries.length === 0) return;

  const task = await Task.findById(taskId).select("definitionId").lean();
  if (!task) return;

  const links = await TaskInventoryLink.find({ companyId, taskDefinitionId: task.definitionId }, { itemTypeId: 1 }).lean();
  const linkedItemTypeIds = new Set(links.map((l) => l.itemTypeId.toString()));
  const validEntries = entries.filter((e) => linkedItemTypeIds.has(e.itemTypeId));
  if (validEntries.length === 0) return;

  const itemTypes = await InventoryItemType.find({
    _id: { $in: validEntries.map((e) => e.itemTypeId) },
    companyId,
    locationId,
    isActive: true,
  }).lean();
  const itemTypeById = new Map(itemTypes.map((it) => [it._id.toString(), it]));

  const loggedAt = new Date();
  const docs = validEntries
    .filter((e) => itemTypeById.has(e.itemTypeId))
    .flatMap((e) => {
      const itemType = itemTypeById.get(e.itemTypeId)!;
      const claimedUid = e.verifiedNfcUid ? e.verifiedNfcUid.toLowerCase() : null;
      const verifiedNfcUid = claimedUid && itemType.nfcTagUid && claimedUid === itemType.nfcTagUid ? claimedUid : null;
      // A required item that this task's own scan didn't happen to verify
      // (different tag, or no tag on the task) is skipped entirely rather
      // than written unverified — see docs/features/inventory.md's "NFC
      // enforcement". The task's own completion is unaffected either way.
      if (itemType.nfcRequiredToLog && !verifiedNfcUid) return [];
      return [
        {
          companyId,
          locationId,
          itemTypeId: e.itemTypeId,
          count: e.count,
          loggedByUserId,
          loggedAt,
          verifiedNfcUid,
        },
      ];
    });

  if (docs.length > 0) await InventoryLog.insertMany(docs);
}
