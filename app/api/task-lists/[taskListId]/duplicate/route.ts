import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import TaskList from "@/models/TaskList";
import Task from "@/models/Task";
import Company from "@/models/Company";
import { resolveSessionUser, isManagerOrAbove, pickActiveLocationId } from "@/lib/session";
import { validateLocationId } from "@/lib/locations";
import { upsertStartTimeSchedule } from "@/lib/qstash-schedules";

export const dynamic = "force-dynamic";

// POST /api/task-lists/[taskListId]/duplicate — manager-only. Copies the
// list itself (name, timeOfDay/startTime, scheduledDays) plus every active
// task placement in it, appended at the end of the company's list order —
// same nextOrder convention as creating a brand-new list (POST
// /api/task-lists). Each copied placement points at the SAME
// TaskDefinition as its source (definitionId is copied, not duplicated) —
// duplicating a list is meant to reuse the company's existing saved checks
// in a new schedule, not fork a second, independent copy of each one (that
// would silently split its TaskLog history/streak and NFC binding away
// from the original — see docs/features/task-lists.md's "Company Task
// Catalog" section on what a shared TaskDefinition means). Only
// scheduledDays/successThreshold/projectedMinutes/order — the placement-
// level fields — get copied per task.
export async function POST(
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

  const source = await TaskList.findOne({ _id: params.taskListId, companyId, locationId, isActive: true }).lean();
  if (!source) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const sourceTasks = await Task.find({ taskListId: source._id, companyId, locationId, isActive: true })
    .sort({ order: 1 })
    .lean();

  const topList = await TaskList.findOne({ companyId, locationId }).sort({ order: -1 }).lean();
  const nextOrder = topList ? topList.order + 1 : 0;

  const newList = await TaskList.create({
    companyId,
    locationId,
    name: `${source.name} (Copy)`,
    timeOfDay: source.timeOfDay,
    startTime: source.startTime ?? null,
    order: nextOrder,
    isDefault: false,
    scheduledDays: source.scheduledDays ?? [0, 1, 2, 3, 4, 5, 6],
  });

  if (sourceTasks.length > 0) {
    await Task.insertMany(
      sourceTasks.map((t) => ({
        taskListId: newList._id,
        companyId,
        locationId,
        definitionId: t.definitionId,
        projectedMinutes: t.projectedMinutes ?? null,
        order: t.order,
        scheduledDays: t.scheduledDays ?? source.scheduledDays ?? [0, 1, 2, 3, 4, 5, 6],
        successThreshold: t.successThreshold ?? 7,
      }))
    );
  }

  // The duplicate inherits the source's startTime/scheduledDays, so it
  // gets its own independent QStash schedule too — best-effort, same
  // reasoning as POST /api/task-lists.
  try {
    const company = await Company.findById(companyId, "timezone").lean<{ timezone?: string | null }>();
    newList.qstashScheduleId = await upsertStartTimeSchedule({
      taskListId: newList._id.toString(),
      startTime: newList.startTime,
      scheduledDays: newList.scheduledDays,
      timezone: company?.timezone ?? null,
    });
    await newList.save();
  } catch (err) {
    console.error(`POST /api/task-lists/${params.taskListId}/duplicate: schedule upsert failed`, err);
  }

  return NextResponse.json({
    _id: newList._id.toString(),
    name: newList.name,
    startTime: newList.startTime ?? null,
  });
}
