import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongoose";
import User from "@/models/User";
import { getSessionSummariesForDate } from "@/lib/task-list-session-actions";
import { resolveSessionUser, pickActiveLocationId } from "@/lib/session";
import { validateLocationId } from "@/lib/locations";

export const dynamic = "force-dynamic";

// GET /api/task-list-sessions?date=YYYY-MM-DD — one summary per taskList
// (its most recent TaskListSession run that day: startedAt/completedAt/
// ownerName), powering TaskListCard's "✓ Done" pill. TasksView.tsx fetches
// this alongside GET /api/task-logs whenever the selected date changes or
// the logs poll detects a change — see TasksView.tsx's refetchSessions.
export async function GET(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });

  const date = req.nextUrl.searchParams.get("date") ?? new Date().toISOString().split("T")[0];
  await connectDB();
  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);

  const summaries = await getSessionSummariesForDate(companyId, locationId, date);

  // Resolve each session's owner (performedByUserId — whoever opened it
  // first, see models/TaskListSession.ts) into a display name. Same
  // "filter out non-ObjectId sentinels" guard as GET /api/task-logs —
  // SKIP_AUTH's local dev user id isn't a real Mongo ObjectId and would
  // otherwise throw a cast error on the $in query.
  const ownerIds = Array.from(
    new Set(
      summaries
        .map((s) => s.performedByUserId)
        .filter((id): id is string => !!id && mongoose.isValidObjectId(id))
    )
  );
  const owners = ownerIds.length > 0 ? await User.find({ _id: { $in: ownerIds } }, "name").lean() : [];
  const nameByOwnerId = new Map(owners.map((u) => [u._id.toString(), u.name as string | undefined]));

  return NextResponse.json(
    summaries.map((s) => ({
      taskListId: s.taskListId,
      startedAt: s.startedAt.toISOString(),
      completedAt: s.completedAt ? s.completedAt.toISOString() : null,
      status: s.status,
      ownerName: s.performedByUserId ? nameByOwnerId.get(s.performedByUserId) ?? "someone else" : null,
    }))
  );
}
