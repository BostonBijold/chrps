import mongoose from "mongoose";
import TaskListSession from "@/models/TaskListSession";
import Task from "@/models/Task";
import TaskList from "@/models/TaskList";
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

// Finds the open (in_progress) TaskListSession for this company/list/date,
// or creates one. Called whenever a task is about to become in_progress
// anchored to a list — startInProgressLog and switchActiveLog both call
// this whenever they're given a non-null sessionTaskListId, so "session
// started" always means a real task actually began running, never a guess
// reconstructed later from logs. performedByUserId is stamped only on
// creation, recording whoever actually opened this run — a later employee
// joining the same open session doesn't reassign it, UNLESS a manager has
// unlocked it (performedByUserId: null — see unlockSession below), in which
// case it's up for grabs and whoever touches it next claims it, same as a
// fresh session's first touch. See docs/features/task-lists.md's task list
// locking section.
export async function ensureOpenSession(companyId: string, locationId: string | null, performedByUserId: string, taskListId: string, date: string) {
  const existing = await TaskListSession.findOne({ companyId, locationId, taskListId, date, status: "in_progress" });
  if (existing) {
    if (!existing.performedByUserId) {
      existing.performedByUserId = performedByUserId;
      await existing.save();
    }
    return existing;
  }
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

export interface SessionLock {
  taskListId: string;
  performedByUserId: string;
  performedByName: string;
}

// One open (in_progress) session's lock info per task list, for whichever of
// taskListIds currently have one — used by TaskListCard's "Start Tasks"
// button to show "In progress by <name>" and gate the unlock icon. A
// session a manager has already unlocked (performedByUserId: null) reports
// no lock — it behaves like no open session for claiming purposes.
export async function getOpenSessionLocks(companyId: string, locationId: string | null, taskListIds: string[], date: string): Promise<SessionLock[]> {
  if (taskListIds.length === 0) return [];
  const sessions = await TaskListSession.find({
    companyId,
    locationId,
    taskListId: { $in: taskListIds },
    date,
    status: "in_progress",
    performedByUserId: { $ne: null },
  }).lean();
  if (sessions.length === 0) return [];

  // performedByUserId isn't always a real User _id — SKIP_AUTH's local dev
  // user (see lib/session.ts's DEV_USER_ID) is a plain sentinel string, not
  // a Mongo ObjectId, and would otherwise make this $in query throw a cast
  // error instead of just not matching. Filter those out before querying;
  // they fall through to the "someone else" fallback below like any other
  // unresolved id.
  const validIds = sessions.map((s) => s.performedByUserId as string).filter((id) => mongoose.isValidObjectId(id));
  const users = validIds.length > 0 ? await User.find({ _id: { $in: validIds } }, "name").lean() : [];
  const nameById = new Map(users.map((u) => [u._id.toString(), u.name as string | undefined]));

  return sessions.map((s) => ({
    taskListId: s.taskListId.toString(),
    performedByUserId: s.performedByUserId as string,
    performedByName: nameById.get(s.performedByUserId as string) ?? "someone else",
  }));
}

// Manager-only unlock (role checked by the caller, e.g. the unlock API
// route) — clears performedByUserId back to null on the OPEN session for
// this list/date. Nothing else about the session changes: not closed, not
// duplicated, no reassignment step, already-completed tasks in it stay
// exactly as they are. A no-op if there's no open session to unlock.
export async function unlockSession(companyId: string, locationId: string | null, taskListId: string, date: string) {
  await TaskListSession.updateOne(
    { companyId, locationId, taskListId, date, status: "in_progress" },
    { $set: { performedByUserId: null } }
  );
}

// Called after a manager Undo (DELETE /api/task-logs) removes a TaskLog —
// Undo only ever deletes the log itself, it never touches TaskListSession,
// so undoing the one log that had ever anchored a list's session leaves
// that session stuck: isTaskListFullyResolved can never become true again
// (nothing left to have a terminal log), so it never auto-closes, and
// nothing releases performedByUserId short of a manager's manual unlock —
// "In progress by <name>" persists even though nothing is actually running.
// If literally no TaskLog remains for any of this list's active tasks on
// date, the session no longer represents anything that actually happened —
// delete it outright (whatever its status) so the list is claimable again,
// exactly as if it had never been started. A no-op whenever some other
// task in the list still has a log (something's still genuinely in play).
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

// Decides what a FAB "scan to open" hit on taskId should do — see
// docs/features/nfc.md's "FAB 'scan to open' shortcut". Read-only: never
// creates or mutates a session itself. A physical tag identifies exactly one
// task, permanently — it never redirects to, or substitutes, a different
// task, so the very first check is always "does this specific task already
// have a log today," regardless of list type. Only a genuinely untouched
// task falls through to the anytime/session/locked branches below.
export type FabScanResolution =
  | { kind: "already-logged"; taskId: string; state: LogState }
  | { kind: "anytime"; taskId: string }
  | { kind: "session"; taskId: string; taskListId: string }
  | { kind: "locked"; taskId: string; taskListId: string; lockedByName: string };

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
  const list = await TaskList.findOne({ _id: taskListId, companyId }).select("startTime").lean();
  const isShiftWindow = !!list?.startTime;

  const existingLog = await TaskLog.findOne({ companyId, locationId, taskId, date }).select("state").lean();

  // A task mid-run (in_progress/paused) inside a shift-window list's open
  // session isn't a dead end the way a terminal log is — the list's session
  // is what carries lock state, not the tag, so rescanning the same tag
  // while its session is active must jump straight back into that session
  // at that task (same as tapping into an already-open session's row),
  // locked out only if someone ELSE holds it. Never spawns a second
  // start/duplicate. See docs/features/nfc.md.
  if (existingLog && isShiftWindow && (existingLog.state === "in_progress" || existingLog.state === "paused")) {
    const [lock] = await getOpenSessionLocks(companyId, locationId, [taskListId], date);
    if (lock && lock.performedByUserId !== performedByUserId) {
      return { kind: "locked", taskId, taskListId, lockedByName: lock.performedByName };
    }
    return { kind: "session", taskId, taskListId };
  }

  // Any other existing log (done/missed/rest, or in_progress/paused on an
  // anytime task, which has no session/lock concept) is a dead end — a tag
  // identifies exactly one task, permanently, and rescanning it is only
  // ever a status check, never a way to reopen or advance into it.
  if (existingLog) return { kind: "already-logged", taskId, state: existingLog.state as LogState };

  if (!isShiftWindow) return { kind: "anytime", taskId };

  const [lock] = await getOpenSessionLocks(companyId, locationId, [taskListId], date);
  if (lock && lock.performedByUserId !== performedByUserId) {
    return { kind: "locked", taskId, taskListId, lockedByName: lock.performedByName };
  }
  return { kind: "session", taskId, taskListId };
}
