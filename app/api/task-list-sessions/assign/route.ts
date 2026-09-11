import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import { assignShiftLead, clearShiftLead } from "@/lib/task-list-session-actions";
import { resolveSessionUser, pickActiveLocationId, isManagerOrAbove } from "@/lib/session";
import { validateLocationId } from "@/lib/locations";

export const dynamic = "force-dynamic";

// POST /api/task-list-sessions/assign — pre-assign (or reassign) today's
// shift lead for a task list, before anyone's started it. Manager-only —
// see docs/features/shift-lead-preassignment.md.
export async function POST(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role, userId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const body = await req.json();
  const { taskListId, date, assignedUserId } = body;
  if (!taskListId || !date || !assignedUserId) {
    return NextResponse.json({ error: "taskListId, date, and assignedUserId are required" }, { status: 400 });
  }

  await connectDB();
  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);

  const result = await assignShiftLead(companyId, locationId, taskListId, date, assignedUserId, userId);
  if (!result) {
    return NextResponse.json({ error: "This list has already been started today" }, { status: 409 });
  }

  return NextResponse.json({ ok: true });
}

// DELETE /api/task-list-sessions/assign?taskListId=...&date=YYYY-MM-DD —
// clear today's pre-assignment. Manager-only. A no-op (still 200) if there
// was nothing to clear.
export async function DELETE(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const taskListId = req.nextUrl.searchParams.get("taskListId");
  const date = req.nextUrl.searchParams.get("date");
  if (!taskListId || !date) {
    return NextResponse.json({ error: "taskListId and date are required" }, { status: 400 });
  }

  await connectDB();
  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);

  await clearShiftLead(companyId, locationId, taskListId, date);

  return NextResponse.json({ ok: true });
}
