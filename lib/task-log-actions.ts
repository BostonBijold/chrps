import TaskLog from "@/models/TaskLog";
import type { LogState } from "@/models/TaskLog";
import Task from "@/models/Task";
import TaskDefinition from "@/models/TaskDefinition";
import type { FormFieldValue } from "@/models/TaskDefinition";
import { ensureOpenSession, incrementSessionPauseOrJump, recordSessionCompletion } from "@/lib/task-list-session-actions";
import NfcTag from "@/models/NfcTag";
import { stampNfcTagUsage } from "@/lib/nfc-tags";

// Used by app/api/task-logs (internal, session-authenticated) — the only
// caller left once tap-to-trigger (lib/task-trigger.ts's triggerTask(),
// the NFC Universal Link tap) and the API-key-authenticated external
// endpoint were both removed, see docs/features/nfc.md's "History:
// Tap-to-trigger (removed)" and docs/project-structure.md's "iOS Native
// Shell" section.

// Thrown by assertNfcVerified below — every route that can reach a `done`
// write must catch this and turn it into a clean 4xx rather than letting it
// bubble up as an unhandled 500.
export class NfcTagRequiredError extends Error {
  constructor() {
    super("This task requires scanning its linked NFC tag to complete — use Scan NFC in the app.");
    this.name = "NfcTagRequiredError";
  }
}

// Blocks a `done` write for a task bound to a physical tag (Task.nfcTagUid
// — see docs/features/nfc.md's "In-app scan-to-complete binding") unless
// the caller already produced a matching scan. The ONLY caller that can
// ever supply a matching verifiedNfcUid is components/TaskFormScreen.tsx's
// Scan NFC flow, which threads the UID it just scanned through
// PATCH /api/task-logs. Every other completion path — manual back-entry,
// the stray-timer auto-close sweep — has no way to prove a scan happened,
// so it always calls this with verifiedNfcUid omitted and is
// unconditionally blocked for a bound task.
// NFC binding lives on the TaskDefinition (the saved check), one layer
// above any single list placement — see models/TaskDefinition.ts — so this
// always resolves through the placement's definitionId rather than reading
// a field off Task itself.
// locationId is threaded as a parameter alongside companyId through every
// function below (same convention as performedByUserId) — see
// docs/features/locations.md. Every TaskLog lookup/write is now keyed by
// companyId+locationId+taskId+date, not just companyId+taskId+date, so two
// locations both running the same shared-catalog task on the same day each
// get their own log rather than colliding into one.

export async function assertNfcVerified(taskId: string, verifiedNfcUid?: string | null, performedByUserId?: string) {
  const task = await Task.findById(taskId).select("definitionId").lean();
  if (!task) return;
  const definition = await TaskDefinition.findById(task.definitionId).select("nfcTagUid").lean();
  if (!definition?.nfcTagUid) return;
  if (definition.nfcTagUid !== verifiedNfcUid) {
    throw new NfcTagRequiredError();
  }
  // A matched UID must also still be an active claim, not `retired` — see
  // docs/features/nfc.md's "Retiring a tag". A lost/decommissioned tag
  // can't complete tasks anymore even though it's still bound; the manager
  // has to reactivate it first (Manage Ch'rps) or bind a different tag.
  const registryTag = await NfcTag.findOne({ uid: definition.nfcTagUid }).select("status").lean();
  if (registryTag?.status === "retired") {
    throw new NfcTagRequiredError();
  }
  // A real, matched, active scan just verified this task's completion —
  // stamp the registry so "when was this tag last actually seen" has an
  // answer, see lib/nfc-tags.ts's stampNfcTagUsage. Fire-and-forget-
  // adjacent: awaited, but never blocks or fails the completion it's
  // confirming.
  if (performedByUserId) {
    await stampNfcTagUsage(definition.nfcTagUid, performedByUserId);
  }
}

// Thrown by assertPhotoProvided below — every route that can reach a `done`
// write must catch this and turn it into a clean 400.
export class PhotoRequiredError extends Error {
  constructor() {
    super("This task requires a photo before it can be completed");
    this.name = "PhotoRequiredError";
  }
}

// Blocks a `done` write for a task whose resolved TaskDefinition has
// requiresPhoto set (see docs/features/task-completion-photo.md) unless the
// caller already produced an uploaded photo URL. Mirrors assertNfcVerified
// exactly, one layer up: requiresPhoto lives on TaskDefinition (the saved
// check), not any one list placement, so this always resolves through the
// placement's definitionId. Every completion path that can reach a `done`
// write — the standalone timer/form screens, back-entry — calls this the
// same way it calls assertNfcVerified.
export async function assertPhotoProvided(taskId: string, photoUrl?: string | null) {
  const task = await Task.findById(taskId).select("definitionId").lean();
  if (!task) return;
  const definition = await TaskDefinition.findById(task.definitionId).select("requiresPhoto").lean();
  if (definition?.requiresPhoto && !photoUrl) {
    throw new PhotoRequiredError();
  }
}

// bankedSeconds is elapsed time already accumulated in an earlier running
// segment of this same log (see pausedSeconds on the model) — added on top
// of the time since startedAt so resuming a paused task and later finishing
// it credits the full total, not just the final segment.
export function minutesSince(startedAt: Date, bankedSeconds = 0): number {
  return Math.max(1, Math.round((bankedSeconds * 1000 + (Date.now() - startedAt.getTime())) / 60000));
}

export function serializeLog(l: {
  _id: { toString(): string };
  taskId: { toString(): string };
  date: string;
  actualMinutes?: number | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  pausedSeconds?: number | null;
  state: LogState;
  sessionTaskListId?: { toString(): string } | null;
  formData?: Record<string, FormFieldValue> | null;
  photoUrl?: string | null;
  tagId?: string | null;
  performedByUserId?: string | null;
  updatedAt?: Date | null;
}) {
  return {
    _id: l._id.toString(),
    taskId: l.taskId.toString(),
    date: l.date,
    actualMinutes: l.actualMinutes ?? null,
    startedAt: l.startedAt ? new Date(l.startedAt).toISOString() : null,
    completedAt: l.completedAt ? new Date(l.completedAt).toISOString() : null,
    pausedSeconds: l.pausedSeconds ?? 0,
    state: l.state,
    sessionTaskListId: l.sessionTaskListId ? l.sessionTaskListId.toString() : null,
    formData: l.formData ?? null,
    photoUrl: l.photoUrl ?? null,
    tagId: l.tagId ?? null,
    // Offline-cache fields (see docs/features/offline.md) — informational
    // only, not read by any online consumer. updatedAt drives the offline
    // cache's last-write-wins conflict resolution.
    performedByUserId: l.performedByUserId ?? null,
    updatedAt: l.updatedAt ? new Date(l.updatedAt).toISOString() : null,
  };
}

// Auto-completes any dangling in_progress log for this specific person
// (performedByUserId) other than exceptTaskId — on any date, any task —
// crediting elapsed time + banked pausedSeconds, minimum 1 minute. Scoped
// per-person, not per-company: a company's staff can run several tasks
// concurrently, but one physical person can't be running two timers at
// once. Extracted out of startInProgressLog so the external trigger-task
// endpoint's immediate-done path (checkbox tasks, which never go through
// startInProgressLog at all) still enforces the same single-active-timer
// invariant before writing its own log.
export async function completeStrayInProgressLogs(companyId: string, performedByUserId: string, exceptTaskId: string) {
  const stray = await TaskLog.find({
    companyId,
    performedByUserId,
    state: "in_progress",
    taskId: { $ne: exceptTaskId },
  }).lean();

  for (const s of stray) {
    // A stray log for a tag-bound task was never scanned — silently
    // crediting it "done" here would be exactly the bypass the scan
    // requirement exists to prevent. Record it honestly as missed instead;
    // see docs/features/nfc.md's "In-app scan-to-complete binding".
    const strayTask = await Task.findById(s.taskId).select("definitionId").lean();
    const strayDefinition = strayTask
      ? await TaskDefinition.findById(strayTask.definitionId).select("nfcTagUid").lean()
      : null;
    if (strayDefinition?.nfcTagUid) {
      await TaskLog.updateOne(
        { _id: s._id },
        { $set: { state: "missed", startedAt: null, completedAt: null, actualMinutes: null, pausedSeconds: 0, sessionTaskListId: null } }
      );
      continue;
    }

    const startedAt = s.startedAt ? new Date(s.startedAt) : null;
    await TaskLog.updateOne(
      { _id: s._id },
      {
        $set: {
          state: "done",
          completedAt: new Date(),
          actualMinutes: startedAt ? minutesSince(startedAt, s.pausedSeconds ?? 0) : 1,
          pausedSeconds: 0,
          sessionTaskListId: null,
        },
      }
    );
  }
}

// Starts (or restarts) a timer for taskId on date, enforcing a single
// active timer per person: any other in_progress log for performedByUserId
// — on any task, any date — is auto-completed first, crediting it with the
// elapsed time since its own startedAt, rather than being left dangling.
// Used by the external API and by starting a task's standalone timer — both
// mean "I've actually moved on to doing something else," unlike navigating
// inside an already-open Task List Session (see switchActiveLog below).
// Callers must have already called connectDB().
//
// The TaskLog itself is looked up by companyId + taskId + date — one shared
// record per task per day for the whole company (any employee on shift
// might complete a given task) — with performedByUserId stamped as whoever
// is starting it right now.
//
// sessionTaskListId, when set, marks this timer as anchored inside a Task
// List Session for that list — see models/TaskLog.ts.
export async function startInProgressLog(
  companyId: string,
  locationId: string | null,
  performedByUserId: string,
  taskId: string,
  date: string,
  sessionTaskListId: string | null = null
) {
  await completeStrayInProgressLogs(companyId, performedByUserId, taskId);
  // A TaskListSession exists per list/date the moment its first task
  // actually starts running — see lib/task-list-session-actions.ts. No-op
  // when sessionTaskListId is null (a bare standalone-timer start, not
  // anchored to any list/session).
  if (sessionTaskListId) await ensureOpenSession(companyId, locationId, performedByUserId, sessionTaskListId, date);

  const existing = await TaskLog.findOne({ companyId, locationId, taskId, date }).lean();

  const log = await TaskLog.findOneAndUpdate(
    { companyId, locationId, taskId, date },
    {
      $set: {
        state: "in_progress",
        startedAt: new Date(),
        completedAt: null,
        actualMinutes: null,
        isBackEntry: false,
        sessionTaskListId,
        performedByUserId,
        // TODO: tagId — once the NFC reader lands, a tag-triggered start
        // (external API) will pass the resolved tag identifier through to
        // here and it should be stamped on the log alongside
        // sessionTaskListId. Resuming something that was paused (e.g. left
        // mid-session earlier today) keeps its banked time; a genuinely
        // fresh start has none.
        pausedSeconds: existing?.state === "paused" ? (existing.pausedSeconds ?? 0) : 0,
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  ).lean();

  // Reconcile AGAIN now that this task's own write has committed — closes
  // the check-then-act race between the completeStrayInProgressLogs call
  // above and this upsert: two rapid taps on two DIFFERENT rows (much more
  // reachable now that a shift list surfaces several independent Start
  // Task buttons at once — see docs/features/task-lists.md's "Per-task
  // claiming") can each run their own stray-check before either write has
  // committed, so both see "nothing to complete" and both end up
  // in_progress. This second pass runs against the now-committed state, so
  // whichever of the two calls finishes last is the one that observes (and
  // completes) the other — the single-active-timer invariant converges to
  // exactly one in_progress log per person even when the first check
  // raced. See docs/features/timer.md's "Single-active-timer race".
  await completeStrayInProgressLogs(companyId, performedByUserId, taskId);

  return log;
}

// Pauses every OTHER in_progress log for performedByUserId (any task, any
// date) — banking each one's elapsed time into pausedSeconds, same math
// switchActiveLog always used inline before this was extracted. Shared by
// switchActiveLog's pre-write check AND its post-write reconciliation pass
// below (see the race-condition note there); returns how many were paused
// so the pauseOrJumpCount increment only fires off the first (pre-write)
// call, matching the existing "a genuine jump happened" semantics.
async function pauseOtherInProgressLogs(companyId: string, performedByUserId: string, exceptTaskId: string) {
  const others = await TaskLog.find({
    companyId,
    performedByUserId,
    state: "in_progress",
    taskId: { $ne: exceptTaskId },
  }).lean();

  for (const o of others) {
    const startedAt = o.startedAt ? new Date(o.startedAt) : null;
    const ranSeconds = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000)) : 0;
    await TaskLog.updateOne(
      { _id: o._id },
      {
        $set: {
          state: "paused",
          startedAt: null,
          pausedSeconds: (o.pausedSeconds ?? 0) + ranSeconds,
        },
      }
    );
  }
  return others.length;
}

// Switches which task is the single active timer WITHOUT ever marking the
// one being left behind done or missed — used only for navigating between
// tasks inside an already-open Task List Session (advancing or jumping).
// Moving your attention to a different task in the same session is still
// "only one thing is actually running at a time" (going from cooking to
// getting dressed means cooking's clock stops, it doesn't finish cooking) —
// but it is NOT "I've decided this task is done." So the task you're
// leaving is paused: its elapsed-so-far is banked into pausedSeconds and its
// startedAt is cleared, but its state never becomes done/missed/rest.
// Only an explicit Done/Missed/Rest (app button or API) ever marks a task.
//
// If the target task was previously paused (jumped away and back), its
// banked pausedSeconds carries forward and a fresh startedAt is stamped, so
// total elapsed = pausedSeconds + (now - startedAt) keeps counting up
// correctly instead of resetting. If it's already the active in_progress
// log (e.g. opening straight into it), it's returned untouched.
export async function switchActiveLog(
  companyId: string,
  locationId: string | null,
  performedByUserId: string,
  taskId: string,
  date: string,
  sessionTaskListId: string | null
) {
  // Same creation rule as startInProgressLog: the first call for a list/
  // date (nothing to pause yet, see below) is what actually opens the
  // TaskListSession; every later call for the same list/date just reuses it.
  if (sessionTaskListId) await ensureOpenSession(companyId, locationId, performedByUserId, sessionTaskListId, date);

  const pausedCount = await pauseOtherInProgressLogs(companyId, performedByUserId, taskId);

  // Only counts as a "jump" if something was actually running and got
  // pushed aside — the very first task of a session has nothing to switch
  // away from, so that opening move isn't attention moving away from
  // anything and shouldn't inflate the count.
  if (sessionTaskListId && pausedCount > 0) {
    await incrementSessionPauseOrJump(companyId, locationId, sessionTaskListId, date);
  }

  const existing = await TaskLog.findOne({ companyId, locationId, taskId, date }).lean();
  if (existing?.state === "in_progress") {
    // Still worth a reconciliation pass here too — a second, near-
    // simultaneous switch to a THIRD task from the same person could have
    // slipped its own in_progress log in between the check above and now.
    // See the race-condition note below.
    await pauseOtherInProgressLogs(companyId, performedByUserId, taskId);
    return existing;
  }

  const log = await TaskLog.findOneAndUpdate(
    { companyId, locationId, taskId, date },
    {
      $set: {
        state: "in_progress",
        startedAt: new Date(),
        completedAt: null,
        actualMinutes: null,
        isBackEntry: false,
        sessionTaskListId,
        performedByUserId,
        pausedSeconds: existing?.state === "paused" ? (existing.pausedSeconds ?? 0) : 0,
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  ).lean();

  // Reconcile AGAIN now that this task's own write has committed — closes
  // the check-then-act race between the pauseOtherInProgressLogs call above
  // and this upsert: two rapid taps on two DIFFERENT rows from the same
  // person (much more reachable now that a shift list surfaces several
  // independent Start/Resume buttons at once — see
  // docs/features/task-lists.md's "Per-task claiming") can each run their
  // own stray-check before either write has committed, so both see
  // "nothing to pause" and both end up in_progress. This second pass runs
  // against the now-committed state, so whichever of the two calls
  // finishes last is the one that observes (and pauses) the other — the
  // single-active-timer invariant converges to exactly one in_progress log
  // per person even when the first check raced. See
  // docs/features/timer.md's "Single-active-timer race".
  await pauseOtherInProgressLogs(companyId, performedByUserId, taskId);

  return log;
}

// Writes a terminal `done` log immediately, actualMinutes: 0, no
// intermediate in_progress state — for task types with no timer (checkbox).
// Used by the external trigger-task endpoint's start half when the tapped
// task isn't a standard/stopwatch task. Still enforces the single-active-
// timer invariant via completeStrayInProgressLogs, exactly like
// startInProgressLog does.
//
// taskListId, when given, records this immediate completion against that
// list's open TaskListSession (if one exists) — see
// lib/task-list-session-actions.ts. Note this never *creates* a session: an
// immediate-done task skips the in_progress step entirely, which is the
// only thing that opens one (see startInProgressLog/switchActiveLog), so a
// list whose very first tapped task is a checkbox won't get a session until
// a later, real-timer task starts one.
export async function startImmediateLog(
  companyId: string,
  locationId: string | null,
  performedByUserId: string,
  taskId: string,
  date: string,
  taskListId: string | null = null,
  verifiedNfcUid: string | null = null,
  photoUrl: string | null = null
) {
  await assertNfcVerified(taskId, verifiedNfcUid, performedByUserId);
  await assertPhotoProvided(taskId, photoUrl);
  await completeStrayInProgressLogs(companyId, performedByUserId, taskId);

  const log = await TaskLog.findOneAndUpdate(
    { companyId, locationId, taskId, date },
    {
      $set: {
        state: "done",
        startedAt: null,
        completedAt: new Date(),
        actualMinutes: 0,
        pausedSeconds: 0,
        isBackEntry: false,
        sessionTaskListId: null,
        photoUrl,
        performedByUserId,
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  ).lean();

  if (taskListId) await recordSessionCompletion(companyId, locationId, taskListId, date, taskId, "done", 0);

  return log;
}

// Completes an in_progress timer log, deriving actualMinutes from startedAt
// + banked pausedSeconds (minimum 1 minute) — the same math
// PATCH /api/task-logs's timer-completion branch uses, factored out here so
// it isn't duplicated by the external trigger-task endpoint's
// complete-the-active-task half. fallbackMinutes only applies if the log
// somehow has neither a startedAt nor banked time (shouldn't happen for a
// genuinely in_progress log, but mirrors the PATCH route's existing
// defensiveness). performedByUserId is stamped as whoever completes it,
// which may differ from whoever started it (someone else picked it up).
export async function completeInProgressLog(
  companyId: string,
  locationId: string | null,
  performedByUserId: string,
  taskId: string,
  date: string,
  fallbackMinutes = 1,
  formData: Record<string, FormFieldValue> | null = null,
  verifiedNfcUid: string | null = null,
  photoUrl: string | null = null
) {
  await assertNfcVerified(taskId, verifiedNfcUid, performedByUserId);
  await assertPhotoProvided(taskId, photoUrl);
  const existing = await TaskLog.findOne({ companyId, locationId, taskId, date }).lean();
  const startedAt = existing?.startedAt ? new Date(existing.startedAt) : null;
  const banked = existing?.pausedSeconds ?? 0;
  const actualMinutes = startedAt
    ? minutesSince(startedAt, banked)
    : banked > 0
      ? Math.max(1, Math.round(banked / 60))
      : fallbackMinutes;
  // Captured before the update below clears it — this is the only place
  // that still knows which session (if any) this completion belongs to.
  const sessionTaskListId = existing?.sessionTaskListId ? existing.sessionTaskListId.toString() : null;

  const log = await TaskLog.findOneAndUpdate(
    { companyId, locationId, taskId, date },
    {
      $set: {
        state: "done",
        completedAt: new Date(),
        actualMinutes,
        pausedSeconds: 0,
        sessionTaskListId: null,
        formData,
        photoUrl,
        performedByUserId,
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  ).lean();

  if (sessionTaskListId) await recordSessionCompletion(companyId, locationId, sessionTaskListId, date, taskId, "done", actualMinutes);

  return log;
}
