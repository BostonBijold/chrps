import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import TaskList from "@/models/TaskList";
import Task from "@/models/Task";
import TaskLog from "@/models/TaskLog";
import { resolveSessionUser } from "@/lib/session";
import { isTaskVisibleOn } from "@/lib/task-visibility";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, locationId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });

  const date = req.nextUrl.searchParams.get("date") ?? new Date().toISOString().split("T")[0];

  await connectDB();

  const taskLists = await TaskList.find({ companyId, locationId, isActive: true, timeOfDay: { $ne: "anytime" } })
    .sort({ order: 1 }).lean();

  const taskListIds = taskLists.map((g) => g._id);
  const [tasks, logs] = await Promise.all([
    Task.find({ taskListId: { $in: taskListIds }, companyId, locationId, isActive: true }).lean(),
    TaskLog.find({ companyId, locationId, date }).lean(),
  ]);

  const hasLogs = logs.length > 0;

  // in_progress counts as logged — skip past it to find the next unstarted task
  const loggedIds = new Set(logs.map((l) => l.taskId.toString()));

  for (const taskList of taskLists) {
    const listTasks = tasks
      .filter((t) => t.taskListId.toString() === taskList._id.toString() && isTaskVisibleOn(t, date))
      .sort((a, b) => a.order - b.order);
    const next = listTasks.find((t) => !loggedIds.has(t._id.toString()));
    if (next) return NextResponse.json({ hasNext: true, hasLogs });
  }

  return NextResponse.json({ hasNext: false, hasLogs });
}
