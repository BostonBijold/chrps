import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import TaskLog from "@/models/TaskLog";
import { resolveSessionUser, pickActiveLocationId } from "@/lib/session";
import { validateLocationId } from "@/lib/locations";

export const dynamic = "force-dynamic";

// GET /api/task-logs/poll-check?date=YYYY-MM-DD — a deliberately cheap
// "has anything actually changed" fingerprint for today's TaskLogs, which
// TasksView.tsx (and TaskListSessionView.tsx's own foreground-revalidation
// poll) hits every few seconds. Returns only a {count, maxUpdatedAt} pair,
// never document bodies, so a foregrounded idle tab can poll this on a
// short interval without paying for a full TaskLog fetch each time — the
// client only calls the real GET /api/task-logs when this version string
// differs from what it already has. See TasksView.tsx's refetchLogs.
//
// Per-task claiming (see docs/features/task-lists.md's "Per-task claiming")
// means claim state now lives entirely on TaskLog itself
// (performedByUserId/startedAt) — there's no separate list-level lock
// fingerprint to compute anymore.
export async function GET(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });

  const date = req.nextUrl.searchParams.get("date") ?? new Date().toISOString().split("T")[0];
  await connectDB();
  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);

  const [logStats] = await TaskLog.aggregate([
    { $match: { companyId, locationId, date } },
    { $group: { _id: null, count: { $sum: 1 }, maxUpdatedAt: { $max: "$updatedAt" } } },
  ]);

  return NextResponse.json({ logsVersion: versionString(logStats) });
}

function versionString(stat?: { count: number; maxUpdatedAt?: Date | string | null }) {
  const count = stat?.count ?? 0;
  const maxUpdatedAt = stat?.maxUpdatedAt ? new Date(stat.maxUpdatedAt).getTime() : 0;
  return `${count}:${maxUpdatedAt}`;
}
