import mongoose from "mongoose";
import Task from "@/models/Task";
import TaskLog from "@/models/TaskLog";
import InventoryItemType from "@/models/InventoryItemType";
import { getLatestInventoryLogs } from "@/lib/inventory";

export interface LocationTaskCounts {
  doneCount: number;
  // done + missed — the same denominator GET /api/reports' per-task
  // completionRate already uses (unlogged days don't count against or for
  // a task, by design — see CLAUDE.md's Skip Types).
  engagedCount: number;
  // Same as engagedCount — kept as its own field for the rollup's "Tasks
  // Logged" column, since it reads more naturally there than "engaged."
  // (Used to also include the now-removed "rest" state, which made this
  // genuinely different from engagedCount; it no longer is.)
  totalTasksLogged: number;
}

// Shared by GET /api/reports (single-location, current view) and GET
// /api/reports/rollup (owner's cross-location snapshot — see
// docs/features/admin-console.md's Phase 2) so the two "how well is this
// location doing" numbers can never quietly drift apart, same reasoning as
// lib/report-dates.ts's getDates/elapsedDates extraction. Deliberately
// narrower than the full /api/reports payload — no per-task daily
// breakdown, no weekly-progress/streak math — since the rollup table only
// ever needs raw counts to compute (or roll up across locations) a
// completion rate. Returns raw counts rather than a pre-divided rate so a
// caller aggregating several locations sums numerators/denominators first
// — an average of per-location percentages would misweight a
// low-volume location against a high-volume one.
export async function getLocationTaskCounts(
  companyId: string,
  locationId: string | null,
  dates: string[]
): Promise<LocationTaskCounts> {
  const activeTasks = await Task.find({ companyId, isActive: true }, "_id").lean();
  if (activeTasks.length === 0) return { doneCount: 0, engagedCount: 0, totalTasksLogged: 0 };

  const logs = await TaskLog.find(
    { companyId, locationId, date: { $in: dates }, taskId: { $in: activeTasks.map((t) => t._id) } },
    "state"
  ).lean();

  let doneCount = 0;
  let missedCount = 0;
  for (const log of logs) {
    if (log.state === "done") doneCount++;
    else if (log.state === "missed") missedCount++;
  }

  const engagedCount = doneCount + missedCount;
  return { doneCount, engagedCount, totalTasksLogged: engagedCount };
}

// "How many of this location's catalog items are at or below their
// parLevel right now" — the same comparison GET /api/inventory-item-types
// already makes per-row (see that route's own `belowPar` computation).
// InventoryItemType is location-owned (see docs/features/inventory.md's
// "Location scoping"), so both the catalog query and the log join below are
// scoped to the same locationId. Only items with a set parLevel and at
// least one logged count can ever qualify.
export async function getBelowParCountForLocation(companyId: string, locationId: string | null): Promise<number> {
  const itemTypes = await InventoryItemType.find(
    { companyId, locationId, isActive: true, parLevel: { $ne: null } },
    "_id parLevel"
  ).lean();
  if (itemTypes.length === 0) return 0;

  const latestLogs = await getLatestInventoryLogs(
    companyId,
    locationId,
    itemTypes.map((it) => it._id as mongoose.Types.ObjectId)
  );

  let belowPar = 0;
  for (const it of itemTypes) {
    const latest = latestLogs.get(it._id.toString());
    if (latest !== undefined && it.parLevel !== null && latest.count <= it.parLevel) belowPar++;
  }
  return belowPar;
}
