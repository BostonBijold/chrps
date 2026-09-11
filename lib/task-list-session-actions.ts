import mongoose from "mongoose";
import TaskListSession from "@/models/TaskListSession";
import Task from "@/models/Task";
import TaskLog from "@/models/TaskLog";
import User from "@/models/User";
import type { LogState } from "@/models/TaskLog";
import type { CompletionState } from "@/models/TaskListSession";

// List-level session bookkeeping, layered on top of the per-task TaskLog
// writes in lib/task-log-actions.ts. TaskLog stays the source of truth for
// individual task state/timing; TaskListSession is a session-scoped wrapper
// tracking the list as a whole (real start/finish, completion order,
// pause/jump count). See docs/features/timer.md.
//
// Deliberately has no dependency on task-log-actions.ts (that file depends
// on this one, for the calls documented at each call site below) — keeps
// the import graph one-directional instead of circular.
//
// Everything here is scoped by companyId, not by an individual user — a
// TaskListSession represents "today's run of this task list for the
// company," and any employee on shift can pick up an already-open one or
// complete one of its tasks (see models/TaskLog.ts and
// models/TaskListSession.ts for the reasoning).

// Raw "this list's active tasks + that date's logs for them" fetch — used
// by isTaskListFullyResolved below, so there's exactly one query shape for
// "what does this list look like today."
async function fetchTaskListTasksAndLogs(companyId: string, locationId: string | null, taskListId: string, date: string) {
  const tasks = await Task.find({ taskListId, companyId, isActive: true })
    .sort({ order: 1 })
    .lean();
  if (tasks.length === 0) return { tasks, logs: [] as Array<{ taskId: { toString(): string }; state: string }> };

  const logs = await TaskLog.find({
    companyId,
    locationId,
    date,
    taskId: { $in: tasks.map((t) => t._id) },
  }).lean();
  return { tasks, logs };
}

// True once every active task in the list has a terminal (done/missed)
// log for date — what closes a TaskListSession. An empty/deleted list
// is never "resolved" (nothing to close against).
export async function isTaskListFullyResolved(companyId: string, locationId: string | null, taskListId: string, date: string): Promise<boolean> {
  const { tasks, logs } = await fetchTaskListTasksAndLogs(companyId, locationId, taskListId, date);
  if (tasks.length === 0) return false;
  const terminalIds = new Set(
    logs.filter((l) => l.state === "done" || l.state === "missed").map((l) => l.taskId.toString())
  );
  return tasks.every((t) => terminalIds.has(t._id.toString()));
}

// One summary per taskList, for every TaskListSession opened against
// companyId/locationId on date — the list's own MOST RECENT run (by
// startedAt), since a list can legitimately be started/finished/restarted
// more than once the same day (see models/TaskListSession.ts's
// no-unique-index note). Powers TaskListCard's "✓ Done" pill (start/end
// time + session owner — the person whose performedByUserId is stamped on
// the session, i.e. whoever opened it first) — see docs/features/task-lists.md —
// and, when status is "assigned", the shift-lead pre-assignment row instead
// (see docs/features/shift-lead-preassignment.md). Mongo's null-sorts-last-
// on-descending behavior means an "assigned" record (startedAt: null) only
// ever wins the "latest per list" pick below when there's no real
// in_progress/completed run to beat it — exactly the "surface it only while
// nothing's actually running yet" rule that row needs, with no extra
// filtering logic required here.
export interface TaskListSessionSummary {
  taskListId: string;
  status: "assigned" | "in_progress" | "completed";
  startedAt: Date | null;
  completedAt: Date | null;
  performedByUserId: string | null;
  assignedUserId: string | null;
  assignedByUserId: string | null;
  assignedAt: Date | null;
}

export async function getSessionSummariesForDate(
  companyId: string,
  locationId: string | null,
  date: string
): Promise<TaskListSessionSummary[]> {
  const sessions = await TaskListSession.find({ companyId, locationId, date })
    .sort({ startedAt: -1 })
    .lean();
  const latestByTaskListId = new Map<string, TaskListSessionSummary>();
  for (const s of sessions) {
    const key = s.taskListId.toString();
    if (latestByTaskListId.has(key)) continue; // sorted desc — first hit per list is already the latest
    latestByTaskListId.set(key, {
      taskListId: key,
      status: s.status,
      startedAt: s.startedAt ?? null,
      completedAt: s.completedAt ?? null,
      performedByUserId: s.performedByUserId ?? null,
      assignedUserId: s.assignedUserId ?? null,
      assignedByUserId: s.assignedByUserId ?? null,
      assignedAt: s.assignedAt ?? null,
    });
  }
  return Array.from(latestByTaskListId.values());
}

// Finds the open (in_progress) TaskListSession for this company/list/date,
// or creates one. Called whenever a task is about to become in_progress
// anchored to a list — startInProgressLog and switchActiveLog both call
// this whenever they're given a non-null sessionTaskListId, so "session
// started" always means a real task actually began running, never a guess
// reconstructed later from logs. performedByUserId is stamped only on
// creation, recording whoever opened this particular guided walkthrough —
// TaskListSession no longer acts as an exclusivity lock over the list's
// tasks (see docs/features/task-lists.md's "Per-task claiming"); it's kept
// purely as a session-scoped wrapper (real start/finish, completion order,
// pause/jump count) around whichever tasks got walked through this way.
//
// A pre-assigned shift lead (see docs/features/shift-lead-preassignment.md)
// takes priority: if today's list has an "assigned" record, this upgrades
// it in place rather than opening a separate "in_progress" one alongside
// it — performedByUserId is stamped from the PRE-assignment
// (assignedUserId), not from whoever's tap actually triggered this call, so
// a different person physically starting the list doesn't quietly take
// over the assignment. assignedUserId/assignedByUserId/assignedAt are left
// untouched, staying on the record as a permanent "who was assigned, and by
// whom" alongside the run itself.
export async function ensureOpenSession(companyId: string, locationId: string | null, performedByUserId: string, taskListId: string, date: string) {
  const assigned = await TaskListSession.findOne({ companyId, locationId, taskListId, date, status: "assigned" });
  if (assigned) {
    assigned.status = "in_progress";
    assigned.startedAt = new Date();
    assigned.performedByUserId = assigned.assignedUserId;
    await assigned.save();
    return assigned;
  }

  const existing = await TaskListSession.findOne({ companyId, locationId, taskListId, date, status: "in_progress" });
  if (existing) return existing;
  return TaskListSession.create({
    companyId,
    locationId,
    performedByUserId,
    taskListId,
    date,
    startedAt: new Date(),
    completedAt: null,
    status: "in_progress",
    totalActualMinutes: 0,
    completionSequence: [],
    pauseOrJumpCount: 0,
  });
}

// Pre-assigns (or reassigns) today's shift lead for a task list, before
// anyone's actually started it — see
// docs/features/shift-lead-preassignment.md. Finds-or-creates the day's
// "assigned" record; rejects (returns null) if a real run (in_progress/
// completed) already exists for that list/date, since the UI's own "row
// disappears once a session is running" rule shouldn't be trusted blindly
// on the server side. Manager-only gating happens in the API route, not
// here — same division of labor as every other action in this file.
export async function assignShiftLead(
  companyId: string,
  locationId: string | null,
  taskListId: string,
  date: string,
  assignedUserId: string,
  assignedByUserId: string
) {
  const started = await TaskListSession.findOne({
    companyId, locationId, taskListId, date,
    status: { $in: ["in_progress", "completed"] },
  }).select("_id").lean();
  if (started) return null;

  return TaskListSession.findOneAndUpdate(
    { companyId, locationId, taskListId, date, status: "assigned" },
    { $set: { assignedUserId, assignedByUserId, assignedAt: new Date() } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

// Clears today's pre-assignment, if one exists. Deletes the "assigned"
// record outright rather than leaving an empty shell behind — simplest
// option, and nothing downstream depends on an empty "assigned" doc
// existing (see the spec's Write path notes).
export async function clearShiftLead(companyId: string, locationId: string | null, taskListId: string, date: string) {
  await TaskListSession.deleteOne({ companyId, locationId, taskListId, date, status: "assigned" });
}

// Called after a manager Undo (DELETE /api/task-logs) removes a TaskLog —
// Undo only ever deletes the log itself, it never touches TaskListSession,
// so undoing the one log that had ever anchored a list's session leaves
// that session stuck: isTaskListFullyResolved can never become true again
// (nothing left to have a terminal log), so it never auto-closes. If
// literally no TaskLog remains for any of this list's active tasks on
// date, the session no longer represents anything that actually
// happened — delete it outright (whatever its status) rather than leave a
// phantom "completed" or "in_progress" TaskListSession row with nothing
// behind it. A no-op whenever some other task in the list still has a log
// (something's still genuinely in play).
export async function releaseSessionIfNowEmpty(companyId: string, locationId: string | null, taskId: string, date: string) {
  const task = await Task.findById(taskId).select("taskListId").lean();
  if (!task) return;
  const taskListId = task.taskListId.toString();
  const { tasks, logs } = await fetchTaskListTasksAndLogs(companyId, locationId, taskListId, date);
  if (tasks.length === 0 || logs.length > 0) return;
  await TaskListSession.deleteOne({ companyId, locationId, taskListId, date });
}

// Records a terminal completion against the open session for taskListId/
// date, if one exists — a task completing outside any session (tapped
// directly on the main task list, never anchored via sessionTaskListId) has
// nothing to match here, and callers simply don't call this in that case.
// Appends to completionSequence, folds actualMinutes into
// totalActualMinutes for `done` (missed/rest contribute 0 — same
// "terminal-but-zero" treatment Story 2's live-projection math uses), then
// closes the session the moment this leaves every active task in the list
// with a terminal log.
export async function recordSessionCompletion(
  companyId: string,
  locationId: string | null,
  taskListId: string,
  date: string,
  taskId: string,
  state: CompletionState,
  actualMinutes: number
) {
  const session = await TaskListSession.findOne({ companyId, locationId, taskListId, date, status: "in_progress" });
  if (!session) return;

  session.completionSequence.push({ taskId, completedAt: new Date(), state });
  if (state === "done") session.totalActualMinutes += actualMinutes;

  if (await isTaskListFullyResolved(companyId, locationId, taskListId, date)) {
    session.completedAt = new Date();
    session.status = "completed";
  }

  await session.save();
}

// Increments pauseOrJumpCount on the open session for taskListId/date, if
// one exists — both switchActiveLog (in-session navigation, only when it
// actually paused something rather than starting fresh) and the external
// trigger-task endpoint's Case 3 (a different task was active when this one
// got tapped) call this, since both represent "attention moved to a
// different task without that task being marked done."
export async function incrementSessionPauseOrJump(companyId: string, locationId: string | null, taskListId: string, date: string) {
  await TaskListSession.updateOne(
    { companyId, locationId, taskListId, date, status: "in_progress" },
    { $inc: { pauseOrJumpCount: 1 } }
  );
}

// performedByUserId isn't always a real User _id — SKIP_AUTH's local dev
// user (see lib/session.ts's DEV_USER_ID) is a plain sentinel string, not a
// Mongo ObjectId, and would otherwise throw a cast error. Falls back to a
// generic label same as the old getOpenSessionLocks did.
async function resolveClaimantName(userId: string): Promise<string> {
  if (!mongoose.isValidObjectId(userId)) return "someone else";
  const user = await User.findById(userId, "name").lean();
  return (user?.name as string | undefined) ?? "someone else";
}

// Decides what a FAB "scan to open" hit on taskId should do — see
// docs/features/nfc.md's "FAB 'scan to open' shortcut". Read-only: never
// creates or mutates a log itself. A physical tag identifies exactly one
// task, permanently — it never redirects to, or substitutes, a different
// task. Task-level claiming (see docs/features/task-lists.md's "Per-task
// claiming") means a shift-window task and an anytime task now resolve
// identically — there's no separate "session"/list-lock branch anymore.
export type FabScanResolution =
  | { kind: "already-logged"; taskId: string; state: LogState }
  | { kind: "claimed"; taskId: string; taskListId: string; claimedByName: string }
  | { kind: "open"; taskId: string; taskListId: string };

export async function resolveFabScanTarget(
  companyId: string,
  locationId: string | null,
  performedByUserId: string,
  taskId: string,
  date: string
): Promise<FabScanResolution | null> {
  const task = await Task.findOne({ _id: taskId, companyId, isActive: true }).select("taskListId").lean();
  if (!task) return null;
  const taskListId = task.taskListId.toString();

  const existingLog = await TaskLog.findOne({ companyId, locationId, taskId, date })
    .select("state performedByUserId")
    .lean();

  if (existingLog && (existingLog.state === "in_progress" || existingLog.state === "paused")) {
    // Claimed by someone else — a physical tag never bumps another
    // person's active claim; report it the same way TaskRow's own claim
    // pill would. Claimed by the SAME person (rejoining, e.g. resuming
    // after backgrounding the app) is safe to reopen, same as tapping
    // straight into that row would be.
    if (existingLog.performedByUserId && existingLog.performedByUserId !== performedByUserId) {
      const claimedByName = await resolveClaimantName(existingLog.performedByUserId as string);
      return { kind: "claimed", taskId, taskListId, claimedByName };
    }
    return { kind: "open", taskId, taskListId };
  }

  // Any other existing log (done/missed/rest) is a dead end — a tag
  // identifies exactly one task, permanently, and rescanning it is only
  // ever a status check, never a way to reopen or advance into it.
  if (existingLog) return { kind: "already-logged", taskId, state: existingLog.state as LogState };

  return { kind: "open", taskId, taskListId };
}
