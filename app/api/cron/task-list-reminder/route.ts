import { NextRequest, NextResponse } from "next/server";
import { Receiver } from "@upstash/qstash";
import { connectDB } from "@/lib/mongoose";
import Company from "@/models/Company";
import TaskList from "@/models/TaskList";
import Task from "@/models/Task";
import TaskLog from "@/models/TaskLog";
import { resolveTasks } from "@/lib/task-definitions";
import { isTaskVisibleOn } from "@/lib/task-visibility";
import { todayInZone } from "@/lib/task-list-window";
import { sendStartTimeReminder } from "@/lib/notifications";

export const dynamic = "force-dynamic";

// One list's exact-startTime reminder fire — see
// docs/features/notifications.md's "Start-time reminders". Each
// shift-window TaskList gets its own standing QStash schedule
// (lib/qstash-schedules.ts, created/updated by the task-list CRUD routes),
// so unlike app/api/cron/check-missed-lists this route isn't a poll: every
// invocation IS the occurrence, for exactly one list, carried in the
// request body rather than derived from "what time is it right now."
// Unauthenticated (no user session) — same QStash-signature auth boundary
// as the missed-list sweep. No dedup table: each QStash fire is already a
// distinct, non-repeating occurrence by construction (see "Failure
// handling" in the doc for what a QStash retry means here instead).

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY!,
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY!,
});

const TERMINAL_STATES = new Set(["done", "missed"]);

export async function POST(req: NextRequest) {
  const signature = req.headers.get("upstash-signature");
  const rawBody = await req.text();
  if (!signature) return NextResponse.json({ error: "Missing signature" }, { status: 401 });

  const valid = await receiver.verify({ signature, body: rawBody }).catch(() => false);
  if (!valid) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

  const taskListId = (JSON.parse(rawBody || "{}") as { taskListId?: string }).taskListId;
  if (!taskListId) return NextResponse.json({ ok: true, skipped: "no taskListId in body" });

  await connectDB();

  // A list can be deleted (which also deletes its QStash schedule — see
  // lib/qstash-schedules.ts) after a fire is already in flight, or a
  // company can turn notifications off/clear its timezone after the
  // schedule was created — none of these are errors, just nothing to do
  // this fire. Always 200 so QStash doesn't treat a legitimate skip as a
  // failure worth retrying.
  const taskList = await TaskList.findOne({ _id: taskListId, isActive: true }).lean<{
    _id: { toString(): string };
    companyId: string;
    locationId: string | null;
    name: string;
    notifyTags?: string[];
  } | null>();
  if (!taskList) return NextResponse.json({ ok: true, skipped: "list not found or inactive" });

  const company = await Company.findById(taskList.companyId, "timezone notificationsEnabled").lean<{
    timezone?: string | null;
    notificationsEnabled?: boolean;
  } | null>();
  if (!company || company.notificationsEnabled === false || !company.timezone) {
    return NextResponse.json({ ok: true, skipped: "notifications disabled or no timezone" });
  }

  const today = todayInZone(company.timezone);

  const rawTasks = await Task.find({ taskListId, companyId: taskList.companyId, isActive: true }).lean();
  const resolved = await resolveTasks(rawTasks);
  const visible = resolved.filter((t) => isTaskVisibleOn(t, today));
  if (visible.length === 0) return NextResponse.json({ ok: true, skipped: "nothing scheduled today" });

  const logs = await TaskLog.find(
    { companyId: taskList.companyId, date: today, taskId: { $in: visible.map((t) => t._id) } },
    "taskId state"
  ).lean<{ taskId: { toString(): string }; state: string }[]>();
  const stateByTaskId = new Map(logs.map((l) => [l.taskId.toString(), l.state]));

  // An early-arriving employee may have already worked through everything
  // before the scheduled time — a reminder to start something already
  // finished would read as a bug, not a nudge. "Finished" here means every
  // visible task already has a terminal TaskLog (done/missed/rest), not
  // literally only "done" — a task already marked missed or rest this
  // early is unusual, but there's equally nothing left to start.
  const allTerminal = visible.every((t) => {
    const state = stateByTaskId.get(t._id.toString());
    return !!state && TERMINAL_STATES.has(state);
  });
  if (allTerminal) return NextResponse.json({ ok: true, skipped: "already finished" });

  // Each shift-window list is now its own location-owned document with its
  // own independent QStash schedule (see docs/features/locations.md's
  // "Locations" section — the location-scoped task catalog fix closed the
  // once-open "one schedule per company" gap as a side effect), so this
  // fire targets exactly taskList.locationId's staff, not the whole
  // company. notifyTags (see
  // docs/features/notification-job-tag-targeting.md) narrows that further
  // when set.
  await sendStartTimeReminder({
    companyId: taskList.companyId,
    locationId: taskList.locationId ?? null,
    taskListId,
    taskListName: taskList.name,
    date: today,
    notifyTags: taskList.notifyTags ?? [],
  });

  return NextResponse.json({ ok: true, sent: true });
}
