import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import TaskList from "@/models/TaskList";
import Task from "@/models/Task";
import Company from "@/models/Company";
import { resolveSessionUser, isManagerOrAbove, pickActiveLocationId } from "@/lib/session";
import { validateLocationId } from "@/lib/locations";
import { upsertStartTimeSchedule, deleteStartTimeSchedule } from "@/lib/qstash-schedules";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { taskListId: string } }
) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);

  const body = await req.json() as {
    name?: string;
    startTime?: string | null;
    scheduledDays?: number[];
  };

  await connectDB();

  const update: Record<string, unknown> = {};
  if (body.name !== undefined) update.name = body.name.trim();
  if (body.startTime !== undefined) update.startTime = body.startTime || null;
  if (body.scheduledDays !== undefined) update.scheduledDays = body.scheduledDays;

  const taskList = await TaskList.findOneAndUpdate(
    { _id: params.taskListId, companyId, locationId },
    { $set: update },
    { returnDocument: "after" }
  ).lean();

  if (!taskList) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Changing the list's scheduledDays pushes down and overwrites every
  // task currently in the list, setting them all to match the new default —
  // a manager turning Sunday off for the whole list shouldn't require
  // editing each task by hand. Simplest-to-build choice (noted per the
  // brief): this ALWAYS overwrites every task's scheduledDays on this list,
  // even one a manager had previously customized independently — it does
  // not try to track "has this task been individually customized since the
  // last list-level change" and leave those alone. A task can still be
  // reopened and re-customized afterward on top of the new default; this is
  // a default-then-override relationship, not a hard lock, it just doesn't
  // survive the *next* list-level change.
  if (body.scheduledDays !== undefined) {
    const days = body.scheduledDays;
    const clampedThreshold = Math.max(1, days.length);
    await Task.updateMany(
      { taskListId: params.taskListId, companyId, locationId },
      [
        {
          $set: {
            scheduledDays: days,
            successThreshold: { $min: ["$successThreshold", clampedThreshold] },
          },
        },
      ],
      // Pipeline-style update (an array, not a plain $set object) — needed
      // to express "clamp against the field's own current value" in one
      // atomic write. Mongoose requires this opt-in before it'll accept an
      // array as the update argument at all.
      { updatePipeline: true }
    );
  }

  // Only re-upsert the QStash schedule when startTime/scheduledDays
  // actually changed — a pure rename doesn't affect the cron expression or
  // destination. Best-effort, same reasoning as POST /api/task-lists: a
  // QStash hiccup shouldn't fail the list update itself.
  if (body.startTime !== undefined || body.scheduledDays !== undefined) {
    try {
      const company = await Company.findById(companyId, "timezone").lean<{ timezone?: string | null }>();
      const qstashScheduleId = await upsertStartTimeSchedule({
        taskListId: taskList._id.toString(),
        startTime: taskList.startTime ?? null,
        scheduledDays: taskList.scheduledDays ?? [0, 1, 2, 3, 4, 5, 6],
        timezone: company?.timezone ?? null,
      });
      await TaskList.updateOne({ _id: taskList._id }, { $set: { qstashScheduleId } });
    } catch (err) {
      console.error(`PATCH /api/task-lists/${params.taskListId}: schedule upsert failed`, err);
    }
  }

  return NextResponse.json({
    _id: taskList._id.toString(),
    name: taskList.name,
    startTime: taskList.startTime ?? null,
    scheduledDays: taskList.scheduledDays ?? [0, 1, 2, 3, 4, 5, 6],
  });
}

// DELETE /api/task-lists/[taskListId] — soft delete, same convention as an
// individual task: drops out of the active set but keeps its TaskLog/
// TaskListSession history intact.
export async function DELETE(
  req: NextRequest,
  { params }: { params: { taskListId: string } }
) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);

  await connectDB();

  const taskList = await TaskList.findOne({ _id: params.taskListId, companyId, locationId });
  if (!taskList) return NextResponse.json({ error: "Not found" }, { status: 404 });

  taskList.isActive = false;
  taskList.qstashScheduleId = null;
  await taskList.save();

  // Deletes the QStash schedule outright, not soft — nothing reads a
  // deleted schedule's history the way TaskLog/TaskListSession preserve
  // this list's own soft-deleted state. Best-effort: a QStash hiccup
  // shouldn't block the (already-applied) soft delete.
  try {
    await deleteStartTimeSchedule(params.taskListId);
  } catch (err) {
    console.error(`DELETE /api/task-lists/${params.taskListId}: schedule delete failed`, err);
  }

  return NextResponse.json({ ok: true });
}
