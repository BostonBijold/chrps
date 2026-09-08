import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import TaskList from "@/models/TaskList";
import { getOpenSessionLocks } from "@/lib/task-list-session-actions";
import { resolveSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

// GET /api/task-lists/session-locks?date=YYYY-MM-DD — which of the
// company's shift-window task lists currently have an open (in_progress,
// still claimed) Task List Session, and who holds it. Backs the "Start
// Tasks" button's locked state and the manager-only unlock icon — see the
// "Task List Locking" design in docs/features/task-lists.md. Polled
// alongside logs (see TasksView.tsx) so the lock reflects reality without a
// manual refresh.
export async function GET(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, locationId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });

  const date = req.nextUrl.searchParams.get("date") ?? new Date().toISOString().split("T")[0];

  await connectDB();

  const taskLists = await TaskList.find({ companyId, locationId, isActive: true, startTime: { $ne: null } })
    .select("_id")
    .lean();

  const locks = await getOpenSessionLocks(companyId, locationId, taskLists.map((tl) => tl._id.toString()), date);
  return NextResponse.json(locks);
}
