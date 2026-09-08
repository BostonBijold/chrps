import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import TaskLog from "@/models/TaskLog";
import TaskListSession from "@/models/TaskListSession";
import { resolveSessionUser, pickActiveLocationId } from "@/lib/session";
import { validateLocationId } from "@/lib/locations";

export const dynamic = "force-dynamic";

// GET /api/task-logs/poll-check?date=YYYY-MM-DD — a deliberately cheap
// "has anything actually changed" fingerprint for the two things
// TasksView.tsx polls every few seconds (today's TaskLogs and open
// shift-list session locks). Returns only a {count, maxUpdatedAt} pair per
// collection, never document bodies, so a foregrounded idle tab can poll
// this on a short interval without paying for a full TaskLog/
// TaskListSession fetch each time — the client only calls the real
// GET /api/task-logs / GET /api/task-lists/session-locks when a version
// string here differs from what it already has. See TasksView.tsx's
// refetchLogs/refetchSessionLocks callers.
//
// sessionLocksVersion intentionally matches on {companyId, locationId,
// date, status: "in_progress", performedByUserId: {$ne: null}} without
// restricting to specific shift-window taskListIds the way
// GET /api/task-lists/session-locks itself does — a superset is fine here,
// since a false-positive change just triggers one extra real fetch, never
// a correctness issue (the real endpoint still filters exactly).
export async function GET(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });

  const date = req.nextUrl.searchParams.get("date") ?? new Date().toISOString().split("T")[0];
  await connectDB();
  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);

  const [logStats, sessionStats] = await Promise.all([
    TaskLog.aggregate([
      { $match: { companyId, locationId, date } },
      { $group: { _id: null, count: { $sum: 1 }, maxUpdatedAt: { $max: "$updatedAt" } } },
    ]),
    TaskListSession.aggregate([
      { $match: { companyId, locationId, date, status: "in_progress", performedByUserId: { $ne: null } } },
      { $group: { _id: null, count: { $sum: 1 }, maxUpdatedAt: { $max: "$updatedAt" } } },
    ]),
  ]);

  return NextResponse.json({
    logsVersion: versionString(logStats[0]),
    sessionLocksVersion: versionString(sessionStats[0]),
  });
}

function versionString(stat?: { count: number; maxUpdatedAt?: Date | string | null }) {
  const count = stat?.count ?? 0;
  const maxUpdatedAt = stat?.maxUpdatedAt ? new Date(stat.maxUpdatedAt).getTime() : 0;
  return `${count}:${maxUpdatedAt}`;
}
