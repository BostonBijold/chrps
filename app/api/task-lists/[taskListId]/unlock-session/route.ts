import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import TaskList from "@/models/TaskList";
import { unlockSession } from "@/lib/task-list-session-actions";
import { resolveSessionUser, isManagerOrAbove } from "@/lib/session";

export const dynamic = "force-dynamic";

// POST /api/task-lists/[taskListId]/unlock-session — manager-only. Clears
// performedByUserId back to null on the OPEN session for this list/date, so
// someone else can pick it up: nothing is closed or duplicated, no
// reassignment step, already-completed tasks in it stay exactly as they
// are. See the "Task List Locking" design in docs/features/task-lists.md.
export async function POST(
  req: NextRequest,
  { params }: { params: { taskListId: string } }
) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role, locationId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const { date } = (await req.json()) as { date?: string };
  if (!date) return NextResponse.json({ error: "date required" }, { status: 400 });

  await connectDB();

  const taskList = await TaskList.findOne({ _id: params.taskListId, companyId, locationId }).select("_id").lean();
  if (!taskList) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await unlockSession(companyId, locationId, params.taskListId, date);
  return NextResponse.json({ ok: true });
}
