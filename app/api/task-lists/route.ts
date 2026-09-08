import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import TaskList from "@/models/TaskList";
import Task from "@/models/Task";
import Company from "@/models/Company";
import { resolveSessionUser, isManagerOrAbove, pickActiveLocationId } from "@/lib/session";
import { validateLocationId } from "@/lib/locations";
import { upsertStartTimeSchedule } from "@/lib/qstash-schedules";

export const dynamic = "force-dynamic";

// GET /api/task-lists — also the pull-sync source for the offline SQLite
// cache's `task_lists`/`tasks` tables (see docs/features/offline.md). Each
// task is returned as its RAW placement (definitionId, scheduledDays,
// successThreshold, projectedMinutes override — null means "inherit the
// definition's default", updatedAt) rather than a resolveTasks-flattened
// shape — the offline cache mirrors Task/TaskDefinition as two separate
// tables, same split as Mongo, so a definition edit only needs to update
// one row instead of every placement that shares it. name/icon/taskType/
// formFields live in GET /api/task-definitions instead.
export async function GET(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);

  await connectDB();

  // Same startTime-first ordering as the Tasks/Manage pages — see the note
  // in app/(app)/tasks/page.tsx.
  const taskLists = await TaskList.find({ companyId, locationId, isActive: true }).sort({ startTime: 1, order: 1 }).lean();

  const taskListsWithTasks = await Promise.all(
    taskLists.map(async (taskList) => {
      const rawTasks = await Task.find({
        taskListId: taskList._id,
        companyId,
        locationId,
        isActive: true,
      })
        .sort({ order: 1 })
        .lean();

      return {
        _id: taskList._id.toString(),
        name: taskList.name,
        timeOfDay: taskList.timeOfDay,
        startTime: taskList.startTime ?? null,
        order: taskList.order,
        // Additive field for the Admin Console's Task Management page (see
        // docs/features/console-task-management.md) — its list editor
        // needs the list's own current scheduledDays to show accurate
        // toggle state, not just each task's own (which defaults from this
        // but can diverge). Ignored by the offline SQLite cache, which only
        // reads the fields its own schema already mirrors.
        scheduledDays: taskList.scheduledDays ?? [0, 1, 2, 3, 4, 5, 6],
        // Additive field for the Admin Console's Task Management page's
        // tag picker — see
        // docs/features/notification-job-tag-targeting.md. Ignored by the
        // offline SQLite cache, same as scheduledDays above.
        notifyTags: taskList.notifyTags ?? [],
        updatedAt: taskList.updatedAt ? new Date(taskList.updatedAt).toISOString() : null,
        tasks: rawTasks.map((task) => ({
          _id: task._id.toString(),
          taskListId: task.taskListId.toString(),
          definitionId: task.definitionId.toString(),
          scheduledDays: task.scheduledDays,
          successThreshold: task.successThreshold,
          projectedMinutes: task.projectedMinutes ?? null,
          order: task.order,
          updatedAt: task.updatedAt ? new Date(task.updatedAt).toISOString() : null,
        })),
      };
    })
  );

  return NextResponse.json(taskListsWithTasks);
}

// POST /api/task-lists — a manager creates a new task list (name + start
// time). Its tasks are added afterward through POST /api/tasks, same flow
// used for any other task list (browse the template catalog or build a
// custom task) — see components/AddTaskSheet.tsx.
export async function POST(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);
  if (!locationId) return NextResponse.json({ error: "No location assigned" }, { status: 403 });

  const { name, startTime, scheduledDays, notifyTags } = (await req.json()) as {
    name?: string;
    startTime?: string | null;
    scheduledDays?: number[];
    notifyTags?: string[];
  };

  if (!name?.trim()) {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }

  await connectDB();

  const topList = await TaskList.findOne({ companyId, locationId }).sort({ order: -1 }).lean();
  const nextOrder = topList ? topList.order + 1 : 0;
  const days = Array.isArray(scheduledDays) && scheduledDays.length > 0 ? scheduledDays : [0, 1, 2, 3, 4, 5, 6];

  const taskList = await TaskList.create({
    companyId,
    locationId,
    name: name.trim(),
    // A manager-created list is a free-form "custom" window, same as any
    // other non-seeded shift — it participates in the same time-aware
    // collapse math as Opening/Mid-Shift/Closing when it has a startTime,
    // and behaves like a standalone (never-collapsing) list when it doesn't.
    timeOfDay: startTime ? "custom" : "anytime",
    startTime: startTime || null,
    order: nextOrder,
    isDefault: false,
    scheduledDays: days,
    notifyTags: Array.isArray(notifyTags) ? notifyTags : [],
  });

  // Best-effort — a QStash hiccup shouldn't fail list creation itself, the
  // same "accepted tradeoff" reasoning as a missed push being lower-stakes
  // than a missed task elsewhere in this feature. See
  // docs/features/notifications.md's "Start-time reminders".
  try {
    const company = await Company.findById(companyId, "timezone").lean<{ timezone?: string | null }>();
    taskList.qstashScheduleId = await upsertStartTimeSchedule({
      taskListId: taskList._id.toString(),
      startTime: taskList.startTime,
      scheduledDays: taskList.scheduledDays,
      timezone: company?.timezone ?? null,
    });
    await taskList.save();
  } catch (err) {
    console.error(`POST /api/task-lists: schedule upsert failed for ${taskList._id}`, err);
  }

  return NextResponse.json({
    _id: taskList._id.toString(),
    name: taskList.name,
    timeOfDay: taskList.timeOfDay,
    startTime: taskList.startTime ?? null,
    order: taskList.order,
    scheduledDays: taskList.scheduledDays,
    notifyTags: taskList.notifyTags,
  });
}
