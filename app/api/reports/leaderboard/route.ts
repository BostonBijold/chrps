import mongoose from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import { getDates, elapsedDates as computeElapsedDates } from "@/lib/report-dates";
import { resolveSessionUser, isManagerOrAbove, pickActiveLocationId } from "@/lib/session";
import { validateLocationId } from "@/lib/locations";
import User from "@/models/User";
import Task from "@/models/Task";
import TaskLog from "@/models/TaskLog";
import { resolveTasks } from "@/lib/task-definitions";

export const dynamic = "force-dynamic";

// Below this many engaged (done+missed) tasks in the window, a person's
// rate is "Not enough data" rather than a ranked, potentially-misleading
// percentage — see docs/features/reports.md's "Reports v2" addendum,
// Story 1's resolved denominator decision.
const MIN_ENGAGED_TO_RANK = 5;

// GET /api/reports/leaderboard?days=7|30&localDate=YYYY-MM-DD — manager-only
// team leaderboard, ranked by completion rate over tasks each person
// actually logged (not the full company schedule — see the doc's Story 1
// "open question," resolved as option (b)). Doesn't fit GET /api/reports's
// per-session-user role-scoped shape since it's inherently an
// all-employees aggregate, hence a separate route.
export async function GET(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const { searchParams } = req.nextUrl;
  const days = Math.min(30, Math.max(7, parseInt(searchParams.get("days") ?? "7")));
  const localDate = searchParams.get("localDate") ?? new Date().toISOString().split("T")[0];
  const dates = getDates(days, localDate);
  const dateWindow = computeElapsedDates(dates, localDate);

  await connectDB();

  // Same location-scoping convention as GET /api/reports — an owner may
  // pass ?locationId=<id> to view a specific store's leaderboard; a manager
  // always sees only their own. See docs/features/locations.md.
  const requestedLocationId = await validateLocationId(companyId, searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);

  // Same defensive guard app/api/team/route.ts uses — SKIP_AUTH's dev
  // sentinel company id isn't a valid ObjectId and would otherwise throw.
  // A location-bound manager only ranks their own store's roster; an owner
  // without locationId set (a company with no locations yet) sees everyone,
  // matching this route's pre-Locations behavior.
  const roster = mongoose.isValidObjectId(companyId)
    ? await User.find({ companyId, ...(locationId ? { locationId } : {}) }, "name").lean()
    : [];

  const rawTasks = await Task.find({ companyId, locationId, isActive: true }).lean();
  const allTasks = await resolveTasks(rawTasks);
  const taskById = new Map(allTasks.map((t) => [t._id.toString(), t]));

  const logs = await TaskLog.find({
    companyId,
    locationId,
    date: { $in: dateWindow },
    state: { $in: ["done", "missed"] }, // the only two states a task can resolve to (see Story 1's resolved denominator)
  }).lean();

  interface Agg {
    userId: string;
    name: string;
    doneCount: number;
    missedCount: number;
    onTimeCount: number; // Story 2 — outcome breakdown
    lateCount: number;
  }
  const byUser = new Map<string, Agg>();
  const getAgg = (userId: string, name: string) => {
    let agg = byUser.get(userId);
    if (!agg) {
      agg = { userId, name, doneCount: 0, missedCount: 0, onTimeCount: 0, lateCount: 0 };
      byUser.set(userId, agg);
    }
    return agg;
  };

  const nameById = new Map(roster.map((u) => [u._id.toString(), u.name ?? "Unnamed"]));
  for (const u of roster) getAgg(u._id.toString(), u.name ?? "Unnamed");

  for (const log of logs) {
    const agg = getAgg(log.performedByUserId, nameById.get(log.performedByUserId) ?? "Unknown");
    if (log.state === "done") {
      agg.doneCount++;
      const task = taskById.get(log.taskId.toString());
      const isTimed = task && task.taskType !== "checkbox" && task.taskType !== "stopwatch";
      // Same threshold app/api/reports/route.ts's avgVariance already uses
      // (actual > projected), just applied per-log instead of averaged.
      if (isTimed && task && (log.actualMinutes ?? 0) > task.projectedMinutes) {
        agg.lateCount++;
      } else {
        agg.onTimeCount++;
      }
    } else if (log.state === "missed") {
      agg.missedCount++;
    }
  }

  const ranked: Array<Agg & { completionRate: number; engaged: number }> = [];
  const insufficientData: Agg[] = [];
  for (const agg of Array.from(byUser.values())) {
    const engaged = agg.doneCount + agg.missedCount;
    if (engaged < MIN_ENGAGED_TO_RANK) {
      insufficientData.push(agg);
    } else {
      ranked.push({ ...agg, engaged, completionRate: agg.doneCount / engaged });
    }
  }
  ranked.sort((a, b) => b.completionRate - a.completionRate || b.doneCount - a.doneCount);
  insufficientData.sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({ days, today: localDate, ranked, insufficientData });
}
