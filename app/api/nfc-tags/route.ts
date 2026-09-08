import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import { resolveSessionUser, isManagerOrAbove, pickActiveLocationId } from "@/lib/session";
import { validateLocationId } from "@/lib/locations";
import PendingNfcLink from "@/models/PendingNfcLink";
import Task from "@/models/Task";

export const dynamic = "force-dynamic";

// POST /api/nfc-tags — arms a PendingNfcLink for taskId: "Link a Physical
// Tag" in Manage Task List calls this, then the manager physically taps an
// unclaimed tag, which claims it against whichever task was armed here (see
// app/nfc/[tagCode]/page.tsx). One pending link per user — a fresh arm
// replaces whatever was previously pending. Manager-only, same gate as
// task-list management (app/api/task-lists/route.ts) — linking a tag is
// configuration, not something any employee on shift does.
export async function POST(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { userId, companyId, role } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);

  const { taskId } = await req.json();
  if (!taskId) {
    return NextResponse.json({ error: "Missing taskId" }, { status: 400 });
  }

  await connectDB();

  const task = await Task.findOne({ _id: taskId, companyId, locationId, isActive: true }).lean();
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  await PendingNfcLink.findOneAndUpdate(
    { userId },
    { $set: { companyId, locationId, taskId, armedAt: new Date() } },
    { upsert: true }
  );

  return NextResponse.json({ ok: true });
}
