"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { X, ChevronRight, CheckCircle2 } from "lucide-react";
import AppIcon from "@/components/AppIcon";
import TimelineBar from "@/components/TimelineBar";
import TaskFormScreen, { type InventoryCountEntry } from "@/components/TaskFormScreen";
import type { NotificationSound } from "@/lib/notification-sound";
import type { RowItem } from "@/components/TaskRow";
import type { LogState } from "@/models/TaskLog";
import type { FormFieldValue } from "@/models/TaskDefinition";
import { emitTaskLogChanged } from "@/lib/task-log-events";
import { updateRoutineActivity, endRoutineActivity } from "@/lib/native/routine-activity";
import { projectedFinishTime, staticBaselineFinish, type TaskProjection } from "@/lib/projected-finish";
import { computeTimeline, type TimelineColorState } from "@/lib/task-timeline";
import { TASK_TRANSITION_MS } from "@/lib/task-transition";
import { useNetworkStatus } from "@/components/NetworkStatusProvider";
import { queueTaskLogMutation } from "@/lib/offline-sync";

interface SessionLog {
  taskId: string;
  state: LogState;
  actualMinutes: number;
}

interface DayLogRecord {
  taskId: string;
  state: LogState;
  actualMinutes: number;
  startedAt: string | null;
  pausedSeconds: number;
}

// Subset of TaskLogEntry (see TasksView) needed to resume a timer that was
// started outside this session (e.g. tapped "Start" on a single task, then
// entered "Start Tasks") and to reflect tasks already logged before the
// session began.
export interface ExternalLog {
  state: LogState;
  startedAt?: string;
  actualMinutes?: number;
  pausedSeconds?: number;
}

interface Props {
  taskListId: string;
  taskListName: string;
  taskListStartTime?: string | null; // 'HH:MM' — only used for the optional on-track/behind indicator (see lib/projected-finish.ts)
  tasks: RowItem[];
  logs?: Record<string, ExternalLog>;
  today: string;
  startIndex?: number;
  // Set only when this session was auto-started/joined by the FAB's "scan
  // to open" shortcut (see TasksView.tsx's autoOpenSessionTaskId effect and
  // docs/features/nfc.md) — pre-satisfies the Scan NFC step for that one
  // scanned task specifically. Keyed by taskId, not a bare uid, so jumping
  // to any other task in this free-jump session never inherits it.
  preVerifiedTaskId?: string | null;
  preVerifiedNfcUid?: string | null;
  notificationSound: NotificationSound; // which chirp to play on an NFC scan-to-complete save — see lib/notification-sound.ts
  companyId: string; // scopes the offline SQLite cache/queue — see docs/features/offline.md
  userId: string;
  onClose: () => void;
  onFinish: () => void;
}

function pad(n: number) {
  return Math.max(0, n).toString().padStart(2, "0");
}

function fmtMins(secs: number) {
  const m = Math.floor(Math.abs(secs) / 60);
  const s = Math.abs(secs) % 60;
  return `${pad(m)}:${pad(s)}`;
}

// Finds the next task that isn't done/missed yet, starting just after
// afterIndex and wrapping back to the start if nothing remains going
// forward — so a session never reaches the summary screen just because it
// ran off the end of the list. A task that's paused (jumped away from) or
// was never touched (jumped over) still needs resolving, however far back
// in the list it sits. Returns -1 only when every task is finished.
function nextUnfinishedIndex(tasks: RowItem[], finishedIds: Set<string>, afterIndex: number): number {
  for (let i = afterIndex + 1; i < tasks.length; i++) {
    if (!finishedIds.has(tasks[i]._id)) return i;
  }
  for (let i = 0; i <= afterIndex; i++) {
    if (!finishedIds.has(tasks[i]._id)) return i;
  }
  return -1;
}

const RING_R = 70;
const RING_CIRC = 2 * Math.PI * RING_R;
const STOPWATCH_SOFT_CAP = 30 * 60;

// Timeline segment fill colors — done and on-track-active both read as
// olive (success/in-hand, same convention TaskRow uses for the done badge
// regardless of variance), pending as a dim neutral fill (not yet decided),
// and only a running-over active segment shifts to amber — the one state
// this bar is actually meant to draw the eye to.
const TIMELINE_COLOR: Record<TimelineColorState, string> = {
  done: "#1f63b6",        // olive
  active: "#1f63b6",      // olive
  "active-over": "#d97706", // amber
  pending: "#c7d1dc",     // border-light
};

export default function TaskListSessionView({ taskListId, taskListName, taskListStartTime = null, tasks, logs: externalLogs, today, startIndex = 0, preVerifiedTaskId = null, preVerifiedNfcUid = null, notificationSound, companyId, userId, onClose, onFinish }: Props) {
  const { isOnline, refreshPendingCount } = useNetworkStatus();
  const [currentIndex, setCurrentIndex] = useState(startIndex);
  const [elapsed, setElapsed] = useState(0);
  const [isRunning, setIsRunning] = useState(true);
  const [sessionLogs, setSessionLogs] = useState<SessionLog[]>([]);
  const [phase, setPhase] = useState<"running" | "summary">("running");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Latest known state of every task's log today, from any source — this
  // session's own actions, an external API call, or a manual tap elsewhere.
  // Kept fresh by advance(), the foreground-revalidation effect, and the
  // jump-to-task handler, all of which re-fetch rather than trust stale state.
  const [latestLogs, setLatestLogs] = useState<Record<string, DayLogRecord>>({});
  const [jumpNotice, setJumpNotice] = useState<string | null>(null);
  // True for the TASK_TRANSITION_MS window between a completion actually
  // saving and the task list moving on to whatever's next — holds the
  // just-finished task's card on screen playing its exit animation instead
  // of instantly cutting to the next one. See advance() below.
  const [transitioning, setTransitioning] = useState(false);

  const currentTask = tasks[currentIndex];
  const isCheckbox = currentTask?.taskType === "checkbox";
  const isStopwatch = currentTask?.taskType === "stopwatch";
  const isForm = currentTask?.taskType === "form";
  const isCountdown = !isCheckbox && !isStopwatch && !isForm;

  const target = isCountdown ? (currentTask?.projectedMinutes ?? 0) * 60 : 0;
  const isOver = isCountdown && target > 0 && elapsed >= target;

  // elapsed is derived from real wall-clock time, not from counting interval ticks —
  // ticks get throttled/suspended when the PWA is backgrounded or the screen locks,
  // so a naive "+1 every 1000ms" counter silently loses however long you were away.
  // baseElapsedRef = seconds banked before the current running segment started.
  // runStartRef = Date.now() when the current running segment began (null if paused).
  const baseElapsedRef = useRef(0);
  const runStartRef = useRef<number | null>(null);

  const recompute = useCallback(() => {
    if (runStartRef.current != null) {
      const delta = Math.floor((Date.now() - runStartRef.current) / 1000);
      setElapsed(baseElapsedRef.current + delta);
    }
  }, []);

  // Don't run this clock for checkbox tasks (no timer) or form tasks
  // (TaskFormScreen below owns its own elapsed clock and takes over the
  // whole screen for that step).
  useEffect(() => {
    if (isRunning && phase === "running" && !isCheckbox && !isForm) {
      runStartRef.current = Date.now();
      recompute();
      intervalRef.current = setInterval(recompute, 1000);
    } else {
      if (runStartRef.current != null) {
        baseElapsedRef.current += Math.floor((Date.now() - runStartRef.current) / 1000);
        runStartRef.current = null;
      }
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [isRunning, phase, isCheckbox, isForm, recompute]);

  // Force an immediate resync the moment the app comes back to the foreground —
  // don't wait for the next 1s tick to correct the frozen display.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") recompute();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("pageshow", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("pageshow", onVisible);
    };
  }, [recompute]);

  useEffect(() => {
    if (!jumpNotice) return;
    const t = setTimeout(() => setJumpNotice(null), 2500);
    return () => clearTimeout(t);
  }, [jumpNotice]);

  // Fetches today's full log list (not just ids) and folds it into latestLogs,
  // used for skip-forward decisions, foreground revalidation, and the jump
  // safety check below — always the live server truth, never a stale prop.
  const fetchDayLogs = useCallback(async (): Promise<DayLogRecord[]> => {
    try {
      const res = await fetch(`/api/task-logs?date=${today}`);
      if (!res.ok) return [];
      const fresh: Array<{ taskId: string; state: LogState; actualMinutes: number | null; startedAt: string | null; pausedSeconds?: number }> = await res.json();
      const records: DayLogRecord[] = fresh.map((l) => ({
        taskId: l.taskId,
        state: l.state,
        actualMinutes: l.actualMinutes ?? 0,
        startedAt: l.startedAt ?? null,
        pausedSeconds: l.pausedSeconds ?? 0,
      }));
      setLatestLogs((prev) => {
        const next = { ...prev };
        for (const r of records) next[r.taskId] = r;
        return next;
      });
      return records;
    } catch {
      return [];
    }
  }, [today]);

  // Detects whether the current task was auto-completed out from under this
  // session by something outside it — e.g. the external API starting a
  // different task while this session was backgrounded, which the single-
  // active-timer invariant resolves by auto-completing whatever this session
  // had running. Without this, tapping Done on the now-stale UI would
  // silently overwrite the server's correct completion with a fabricated one
  // from the frozen local clock.
  useEffect(() => {
    const revalidate = async () => {
      if (document.visibilityState !== "visible") return;
      if (phase !== "running" || !currentTask) return;
      const records = await fetchDayLogs();
      const currentLog = records.find((r) => r.taskId === currentTask._id);
      // No log yet, or still legitimately running/paused (presumably ours,
      // or another tab/device paused it and it's still resumable) — nothing to do.
      if (!currentLog || currentLog.state === "in_progress" || currentLog.state === "paused") return;

      setSessionLogs((prev) =>
        prev.some((l) => l.taskId === currentTask._id)
          ? prev
          : [...prev, { taskId: currentTask._id, state: currentLog.state, actualMinutes: currentLog.actualMinutes }]
      );

      const finishedIds = new Set(
        records.filter((r) => r.state === "done" || r.state === "missed").map((r) => r.taskId)
      );
      const nextIndex = nextUnfinishedIndex(tasks, finishedIds, currentIndex);
      if (nextIndex !== -1) {
        setCurrentIndex(nextIndex);
      } else {
        setPhase("summary");
        setIsRunning(false);
        endRoutineActivity();
      }
    };

    document.addEventListener("visibilitychange", revalidate);
    window.addEventListener("focus", revalidate);
    window.addEventListener("pageshow", revalidate);

    // Also poll on a short interval so an external trigger (App Intent /
    // Siri / Shortcuts) is caught even if this tab stays foregrounded the
    // whole time. Only actually runs while a task is genuinely running —
    // revalidate() already no-oped otherwise, but that left an idle
    // full-fetch interval ticking even in the "form"/"summary" phases.
    // Each tick hits the same cheap GET /api/task-logs/poll-check
    // fingerprint TasksView.tsx's own combined poll uses, and only calls
    // the real fetchDayLogs when today's logsVersion actually differs —
    // most ticks during a normal walkthrough are the user's own action
    // (which already re-fetches directly, see advance() below), not an
    // external trigger, so this is almost always a no-op check.
    if (phase !== "running") return () => {
      document.removeEventListener("visibilitychange", revalidate);
      window.removeEventListener("focus", revalidate);
      window.removeEventListener("pageshow", revalidate);
    };

    let lastLogsVersion: string | undefined;
    const poll = setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch(`/api/task-logs/poll-check?date=${today}`);
        if (!res.ok) return;
        const { logsVersion }: { logsVersion: string } = await res.json();
        if (lastLogsVersion !== undefined && lastLogsVersion !== logsVersion) {
          revalidate();
        }
        lastLogsVersion = logsVersion;
      } catch {
        // next tick retries
      }
    }, 2000);
    return () => {
      document.removeEventListener("visibilitychange", revalidate);
      window.removeEventListener("focus", revalidate);
      window.removeEventListener("pageshow", revalidate);
      clearInterval(poll);
    };
  }, [phase, currentTask, currentIndex, tasks, fetchDayLogs, today]);

  // Move to a new task — advancing sequentially, or jumping. Only one timer
  // is ever actively running: switching to a new current task pauses
  // whatever was running before (banking its elapsed time server-side via
  // switchActiveLog / sessionNav: true) rather than leaving it ticking
  // alongside the new one or marking it done. If this task was itself
  // paused earlier (jumped away and back), the server resumes it from its
  // banked time instead of restarting the clock. Nothing here ever sets a
  // terminal state — only an explicit Done/Missed (or the external API)
  // does that. Re-fetching afterwards (rather than trusting the POST
  // response alone) keeps latestLogs correct for every task, including
  // whichever one was just paused.
  useEffect(() => {
    if (!currentTask) return;
    let cancelled = false;
    const task = currentTask;
    const isCheckboxTask = task.taskType === "checkbox";
    const isFormTask = task.taskType === "form";

    // Blank the display immediately so it doesn't show the previous task's
    // leftover elapsed value while the switch is in flight.
    baseElapsedRef.current = 0;
    runStartRef.current = null;
    setElapsed(0);
    setIsRunning(false);

    (async () => {
      // Stamp the task list id too, not just startedAt — this is what lets
      // closing the app mid-task (without tapping X) resume straight back
      // into this session on reopen, instead of falling back to the
      // standalone timer. Mirrors the external API's routineGroupId param;
      // openInProgressTimer already branches on sessionTaskListId either way.
      const switchBody = {
        taskId: task._id,
        date: today,
        state: "in_progress" as const,
        sessionTaskListId: taskListId,
        sessionNav: true,
      };
      if (!isOnline) {
        // See docs/features/offline.md — queued instead of sent, and
        // fetchDayLogs (below) already degrades to [] on a network failure,
        // which is exactly the right fallback here: nothing else this
        // session doesn't already know about could have finished elsewhere.
        await queueTaskLogMutation({
          method: "POST",
          companyId,
          taskId: task._id,
          performedByUserId: userId,
          date: today,
          state: "in_progress",
          startedAt: new Date().toISOString(),
          body: switchBody,
        });
        refreshPendingCount();
      } else {
        await fetch("/api/task-logs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(switchBody),
        });
      }
      emitTaskLogChanged();
      if (cancelled) return;

      const records = await fetchDayLogs();
      if (cancelled) return;

      const own = records.find((r) => r.taskId === task._id);
      const seeded =
        !isCheckboxTask && !isFormTask && own?.startedAt
          ? (own.pausedSeconds ?? 0) + Math.max(0, Math.floor((Date.now() - new Date(own.startedAt).getTime()) / 1000))
          : 0;
      baseElapsedRef.current = seeded;
      runStartRef.current = Date.now();
      setElapsed(seeded);
      setIsRunning(true);

      // Checkbox/form tasks have no ring-based Live Activity — end rather
      // than show a stale one; update() falls back to starting fresh, so
      // the very first timed task in a session (nothing to update yet) is
      // handled the same call as switching between two timed tasks
      // mid-session.
      if (isCheckboxTask || isFormTask) {
        endRoutineActivity();
      } else {
        // Same projection/timeline math the in-app view itself uses (see
        // the render-time projectionItems below) — recomputed here from
        // `records` (the fresh fetch just above) rather than reusing
        // component state, since this runs inside an async effect and
        // `records` is already the live truth for exactly this moment.
        // Only ever refreshed on a task switch, not per-second — see
        // docs/features/live-activity.md's note on this being
        // "eventually consistent," same as the countdown/color already are.
        const virtualStartedAt = Date.now() - seeded * 1000;
        const projectionItems: TaskProjection[] = tasks.map((t) => {
          if (t._id === task._id) {
            return {
              projectedMinutes: t.projectedMinutes,
              state: "active",
              targetInstant: virtualStartedAt + t.projectedMinutes * 60000,
            };
          }
          const rec = records.find((r) => r.taskId === t._id);
          if (rec && (rec.state === "done" || rec.state === "missed")) {
            return {
              projectedMinutes: t.projectedMinutes,
              state: rec.state,
              actualMinutes: rec.state === "done" ? rec.actualMinutes : undefined,
            };
          }
          return { projectedMinutes: t.projectedMinutes, state: "pending" };
        });
        const nowMs = Date.now();
        const timeline = computeTimeline(
          tasks.map((t, i) => ({ id: t._id, ...projectionItems[i] })),
          nowMs
        );
        const routineFinishAt = projectedFinishTime(projectionItems, new Date(nowMs));

        // Live-Activity-only override: computeTimeline deliberately reports
        // "done" as olive regardless of variance (matching TaskRow's done
        // badge convention — see lib/task-timeline.ts), and that in-app
        // behavior is unchanged here. But on the Lock Screen, a task that
        // finished well over its target reverting straight to green loses
        // information the user asked to keep visible — so this payload
        // specifically re-labels a *done-but-over-target* segment as
        // "activeOver" (amber), same color an over-target *active* segment
        // already uses. Looked up by id since computeTimeline drops
        // zero-width (missed) segments, so segment order can't be
        // zipped against `tasks`/`projectionItems` positionally.
        const projectionById = new Map(tasks.map((t, i) => [t._id, projectionItems[i]]));

        // NOTE: routineItemId/routineGroupId/habitName/routineLabel below
        // are wire-contract keys for the un-renamed iOS RoutineActivity
        // target (see lib/native/routine-activity.ts) — not leftover
        // vocabulary, kept exactly as the native side expects.
        updateRoutineActivity({
          routineItemId: task._id,
          routineGroupId: taskListId,
          routineLabel: taskListName,
          habitName: task.name,
          startedAt: new Date(virtualStartedAt).toISOString(),
          projectedMinutes: task.taskType === "stopwatch" ? 0 : task.projectedMinutes,
          timelineSegments: timeline.segments.map((seg) => {
            const proj = projectionById.get(seg.id);
            const doneOverTarget =
              proj?.state === "done" && proj.actualMinutes != null && proj.actualMinutes > proj.projectedMinutes;
            return {
              pct: seg.pct,
              colorState: doneOverTarget || seg.colorState === "active-over" ? "activeOver" : seg.colorState,
            };
          }),
          routineStartedAt: new Date(timeline.startInstant).toISOString(),
          routineFinishAt: routineFinishAt.toISOString(),
        });
      }
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex]);

  const saveLog = useCallback(
    async (
      taskId: string,
      state: LogState,
      actualMinutes: number,
      formData?: Record<string, FormFieldValue>,
      verifiedNfcUid?: string | null,
      inventoryCounts?: InventoryCountEntry[],
      photoUrl?: string | null
    ) => {
      // A form-task completion carries captured field values — route
      // through PATCH (completeInProgressLog) the same way TasksView's
      // standalone handleTaskFormComplete does, so formData actually gets
      // persisted instead of just a bare actualMinutes.
      const method = formData ? "PATCH" : "POST";
      const body = formData
        ? { taskId, date: today, state, actualMinutes, formData, verifiedNfcUid, inventoryCounts, photoUrl }
        : { taskId, date: today, state, actualMinutes };

      if (!isOnline) {
        // See docs/features/offline.md — same trust-then-reconcile approach
        // as TasksView's handleTaskFormComplete: a bound task's
        // verifiedNfcUid is accepted optimistically and only actually
        // re-checked (assertNfcVerified) when this mutation syncs.
        await queueTaskLogMutation({
          method,
          companyId,
          taskId,
          performedByUserId: userId,
          date: today,
          state,
          completedAt: new Date().toISOString(),
          formValues: formData ?? null,
          body,
        });
        refreshPendingCount();
        emitTaskLogChanged();
        return;
      }

      const res = await fetch("/api/task-logs", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // e.g. a task bound to an NFC tag (see docs/features/nfc.md) with no
        // matching verifiedNfcUid — the caller must not treat this as saved.
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || "Failed to save — please try again.");
      }
      emitTaskLogChanged();
    },
    [today, isOnline, companyId, userId, refreshPendingCount]
  );

  const advance = useCallback(
    async (
      state: LogState,
      actualMinutes: number,
      formData?: Record<string, FormFieldValue>,
      verifiedNfcUid?: string | null,
      inventoryCounts?: InventoryCountEntry[],
      photoUrl?: string | null
    ) => {
      if (!currentTask) return;
      const log: SessionLog = { taskId: currentTask._id, state, actualMinutes };
      setSessionLogs((prev) => [...prev, log]);
      try {
        await saveLog(currentTask._id, state, actualMinutes, formData, verifiedNfcUid, inventoryCounts, photoUrl);
      } catch (err) {
        // Roll back the optimistic append and stay on the current task
        // instead of silently advancing past a completion the server
        // actually rejected.
        setSessionLogs((prev) => prev.filter((l) => l !== log));
        throw err;
      }

      // The save is confirmed good — hold the just-finished task's card on
      // screen playing its exit animation (task-advance-out, via
      // `transitioning`) for TASK_TRANSITION_MS before actually moving on,
      // instead of cutting to the next task the instant the network call
      // resolves. Overlaps with fetchDayLogs rather than stacking after it,
      // so this never adds latency beyond what the fetch already takes.
      setTransitioning(true);
      const [records] = await Promise.all([
        // Skip past anything already FINISHED today (done/missed), from
        // ANY source — an earlier API call, a manual tap elsewhere, or this
        // session itself. An in_progress or paused task is deliberately NOT
        // skipped — it becomes current instead, resuming from its real banked
        // time, since it's just something you (or another source) started
        // earlier and haven't finished yet, not something to bypass. The walk
        // below wraps back to the start of the list rather than stopping at
        // the end, so a paused/pending task earlier in the list (jumped away
        // from or jumped over) still gets revisited instead of silently
        // ending the session. Re-fetch rather than trust sessionLogs/
        // externalLogs, since either can be stale relative to an out-of-band
        // completion that just happened.
        fetchDayLogs(),
        new Promise<void>((resolve) => setTimeout(resolve, TASK_TRANSITION_MS)),
      ]);
      const finishedIds = new Set(sessionLogs.map((l) => l.taskId));
      finishedIds.add(currentTask._id);
      for (const r of records) {
        if (r.state === "done" || r.state === "missed") finishedIds.add(r.taskId);
      }

      const nextIndex = nextUnfinishedIndex(tasks, finishedIds, currentIndex);
      if (nextIndex !== -1) {
        setCurrentIndex(nextIndex);
      } else {
        setPhase("summary");
        setIsRunning(false);
        endRoutineActivity();
      }
      setTransitioning(false);
    },
    [currentTask, currentIndex, tasks, saveLog, sessionLogs, fetchDayLogs]
  );

  // Jump directly to a different task — pending (never started), in_progress
  // (rare: started earlier via another tab/device and still actively running),
  // or paused (started earlier in this session, left when you jumped away) —
  // without marking the current one done or missed. The task you're
  // leaving is paused, not completed: the per-task effect above switches the
  // active timer via switchActiveLog (sessionNav: true), which banks its
  // elapsed time and marks it paused. Only an explicit Done/Missed (or
  // the external API) ever marks a task. Only a FINISHED task (done/missed)
  // can't be jumped to — that's what Undo is for, not a jump.
  const handleJumpTo = useCallback(
    async (index: number) => {
      if (phase !== "running" || index === currentIndex) return;
      const targetTask = tasks[index];
      if (!targetTask) return;
      // Re-check freshness right before jumping — the row's own displayed
      // state could be a moment stale if something finished it since the last render.
      const records = await fetchDayLogs();
      const targetLog = records.find((r) => r.taskId === targetTask._id);
      if (targetLog && (targetLog.state === "done" || targetLog.state === "missed")) {
        setJumpNotice(`${targetTask.name} was already logged — refreshed.`);
        return;
      }
      setCurrentIndex(index);
    },
    [phase, currentIndex, tasks, fetchDayLogs]
  );

  // Closing mid-task (the X button) just dismisses this view — the current
  // task's log is already in_progress server-side (see the per-task effect
  // above) and keeps running untouched, same as backgrounding the app. The
  // Live Activity keeps tracking it on the Lock Screen too (deliberately
  // not ended here — see docs/features/live-activity.md). The user resumes
  // via the FAB's active-timer indicator (BottomNav.tsx) or by reopening
  // this list's "Start Tasks."
  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleDone = () => {
    if (isCheckbox) {
      advance("done", 0);
    } else {
      advance("done", Math.max(1, Math.round(elapsed / 60)));
    }
  };
  const handleMissed = () => advance("missed", 0);
  const handleTaskFormDone = (
    formData: Record<string, FormFieldValue>,
    actualMinutes: number,
    verifiedNfcUid?: string | null,
    inventoryCounts?: InventoryCountEntry[],
    photoUrl?: string | null
  ) => advance("done", actualMinutes, formData, verifiedNfcUid, inventoryCounts, photoUrl);

  // ── Form task: full-screen takeover, same component/shape TasksView uses
  // for the standalone timer path — a form task has no ring of its own, so
  // it steps outside this screen's normal chrome for the duration of
  // filling in its fields, then returns to the session view for the next
  // task once advance() moves currentIndex forward. ──
  if (phase === "running" && isForm && currentTask) {
    return (
      // Keyed by task id so advancing from one form task straight into
      // another (e.g. two NFC-bound checklist tasks back to back) actually
      // remounts this screen — resetting its field values/elapsed clock, and
      // replaying TaskFormScreen's own entrance animation — instead of
      // silently reusing the previous task's component instance with only
      // its props swapped. `exiting` flips true (same instance, same key —
      // currentTask/currentIndex hasn't moved yet) for the hold described at
      // advance()'s `transitioning` above, then this instance unmounts as
      // the key changes to whichever task comes next.
      <TaskFormScreen
        key={currentTask._id}
        item={currentTask}
        initialElapsed={elapsed}
        taskListName={taskListName}
        preVerifiedNfcUid={currentTask._id === preVerifiedTaskId ? preVerifiedNfcUid : null}
        notificationSound={notificationSound}
        onComplete={handleTaskFormDone}
        onMissed={handleMissed}
        onClose={handleClose}
        exiting={transitioning}
      />
    );
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  if (phase === "summary") {
    // Anything this session itself walked through and logged, PLUS anything
    // else that ended up logged today by another source (an external call,
    // e.g.) — without this fallback those tasks would silently vanish from
    // the summary instead of being shown, and the completed count would be
    // wrong relative to tasks.length.
    const logMap: Record<string, SessionLog> = {};
    for (const [id, l] of Object.entries(latestLogs)) {
      if (l.state === "done" || l.state === "missed") {
        logMap[id] = { taskId: id, state: l.state, actualMinutes: l.actualMinutes };
      }
    }
    for (const l of sessionLogs) logMap[l.taskId] = l; // this session's own record wins if both exist

    const allLogs = Object.values(logMap);
    const totalActual = allLogs.reduce((s, l) => s + l.actualMinutes, 0);
    const timedTasks = tasks.filter((t) => t.taskType !== "checkbox");
    const totalProjected = timedTasks.reduce((s, t) => s + t.projectedMinutes, 0);
    const doneCount = allLogs.filter((l) => l.state === "done").length;

    return (
      // Same blue-backdrop + bordered-card treatment as the running view's
      // current-task card and TaskFormScreen — the last task's card exits
      // into this same blue field (see advance()'s transitioning hold right
      // before setPhase("summary")), so the receipt reads as one more card
      // in the same stack, not a different kind of screen.
      <div
        className="fixed inset-0 z-50 flex items-stretch justify-center"
        style={{
          background: "#1f63b6",
          paddingTop: "calc(env(safe-area-inset-top) + 14px)",
          paddingBottom: "calc(env(safe-area-inset-bottom) + 14px)",
          paddingLeft: "14px",
          paddingRight: "14px",
        }}
      >
        <div className="w-full max-w-mobile rounded-[28px] border-2 border-white/25 bg-bg shadow-2xl overflow-hidden flex flex-col task-advance-in">
          <div className="flex-1 overflow-y-auto px-4 pb-4">
            <div className="text-center pt-16 pb-10">
              <div className="flex justify-center mb-4">
                <CheckCircle2 size={48} strokeWidth={1.5} className="text-olive" />
              </div>
              <h2 className="font-heading text-2xl text-text">{taskListName}</h2>
              <p className="font-mono text-olive text-sm mt-1 tracking-wide">Complete</p>
              <div className="flex justify-center gap-10 mt-8">
                <div>
                  <p className="font-mono text-2xl text-text">{totalActual}m</p>
                  <p className="font-mono text-dim text-[10px] uppercase tracking-widest mt-1">actual</p>
                </div>
                {totalProjected > 0 && (
                  <div>
                    <p className="font-mono text-2xl text-muted">{totalProjected}m</p>
                    <p className="font-mono text-dim text-[10px] uppercase tracking-widest mt-1">projected</p>
                  </div>
                )}
                <div>
                  <p className="font-mono text-2xl text-text">{doneCount}/{tasks.length}</p>
                  <p className="font-mono text-dim text-[10px] uppercase tracking-widest mt-1">completed</p>
                </div>
              </div>
            </div>

            <div className="bg-card rounded-card overflow-hidden divide-y divide-border">
              {tasks.map((task) => {
                const log = logMap[task._id];
                if (!log) return null;
                const isTaskCheckbox = task.taskType === "checkbox";
                const isTaskStopwatch = task.taskType === "stopwatch";
                const isTaskForm = task.taskType === "form";
                const variance =
                  log.state === "done" && !isTaskCheckbox && !isTaskStopwatch && !isTaskForm
                    ? log.actualMinutes - task.projectedMinutes
                    : null;
                return (
                  <div key={task._id} className="flex items-center gap-3 px-4 py-3">
                    <div className="w-7 flex items-center justify-center flex-shrink-0">
                      <AppIcon name={task.icon} size={16} className="text-muted" />
                    </div>
                    <span className="flex-1 font-body text-sm text-text truncate">{task.name}</span>
                    {log.state === "done" && log.actualMinutes > 0 && (
                      <span className="font-mono text-xs text-muted mr-1">{log.actualMinutes}m</span>
                    )}
                    {variance !== null && (
                      <span className={`font-mono text-xs ${variance > 0 ? "text-tobacco" : variance < 0 ? "text-olive-light" : "text-dim"}`}>
                        {variance > 0 ? `+${variance}m` : variance < 0 ? `${variance}m` : "on target"}
                      </span>
                    )}
                    <span className={`font-mono text-xs ml-1 ${log.state === "done" ? "text-done" : log.state === "missed" ? "text-burgundy-light" : "text-blue-muted"}`}>
                      {log.state === "done" ? "✓" : log.state === "missed" ? "✗" : "~"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="px-4 py-4 flex-shrink-0 border-t border-border">
            <button onClick={onFinish} className="w-full py-4 rounded-card bg-olive text-text font-body font-medium">
              Finish
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Running ──────────────────────────────────────────────────────────────────
  // Tasks already logged before this session started (e.g. completed earlier
  // today outside "Start Tasks") count as done too, so they don't render as
  // "upcoming".
  const externalDoneIds = new Set(
    Object.entries(externalLogs ?? {})
      .filter(([, l]) => l.state === "done" || l.state === "missed")
      .map(([id]) => id)
  );
  // Same, but from live server state rather than the static prop — covers
  // anything completed mid-session by another source (a jump, an external call).
  const liveDoneIds = new Set(
    Object.entries(latestLogs)
      .filter(([, l]) => l.state === "done" || l.state === "missed")
      .map(([id]) => id)
  );
  const loggedIds = new Set([
    ...sessionLogs.map((l) => l.taskId),
    ...Array.from(externalDoneIds),
    ...Array.from(liveDoneIds),
  ]);

  // Live projected finish time — see lib/projected-finish.ts. The active
  // task's targetInstant is derived from the stable baseElapsedRef/
  // runStartRef pair (only mutated on pause/resume/switch/drag), not from
  // `elapsed` + a fresh Date.now() — so it stays bit-exact across ticks
  // instead of merely canceling out algebraically each render. While
  // actually running: effective start = runStartRef - bankedSeconds, same
  // math the ring's own elapsed display uses. While paused (no interval
  // ticking, so no repeated renders to stay in sync across anyway), falls
  // back to deriving it from the frozen `elapsed` state.
  const activeTargetInstant =
    (runStartRef.current != null
      ? runStartRef.current - baseElapsedRef.current * 1000
      : Date.now() - elapsed * 1000) + (currentTask?.projectedMinutes ?? 0) * 60000;

  // Resolves each task to one of the four projection states using the same
  // sessionLogs > latestLogs > externalLogs > pending precedence the task
  // list below uses for its own per-row log lookup, generalized to include
  // the current task (always "active", never looked up from a log) and to
  // return the exact terminal state (done vs. missed) rather than a single
  // boolean, since only "done" and "active" carry a nonzero contribution.
  // Recomputed on every render — including the once-a-second tick that
  // updates `elapsed` — so it's live without a second interval.
  const projectionItems: TaskProjection[] = tasks.map((task, i) => {
    if (i === currentIndex) {
      return { projectedMinutes: task.projectedMinutes, state: "active", targetInstant: activeTargetInstant };
    }
    const sessionLog = sessionLogs.find((l) => l.taskId === task._id);
    if (sessionLog && (sessionLog.state === "done" || sessionLog.state === "missed")) {
      return {
        projectedMinutes: task.projectedMinutes,
        state: sessionLog.state,
        actualMinutes: sessionLog.state === "done" ? sessionLog.actualMinutes : undefined,
      };
    }
    const live = latestLogs[task._id];
    if (live && (live.state === "done" || live.state === "missed")) {
      return {
        projectedMinutes: task.projectedMinutes,
        state: live.state,
        actualMinutes: live.state === "done" ? live.actualMinutes : undefined,
      };
    }
    const ext = externalLogs?.[task._id];
    if (ext && (ext.state === "done" || ext.state === "missed")) {
      return {
        projectedMinutes: task.projectedMinutes,
        state: ext.state,
        actualMinutes: ext.state === "done" ? (ext.actualMinutes ?? 0) : undefined,
      };
    }
    return { projectedMinutes: task.projectedMinutes, state: "pending" };
  });
  // Single "now" sample shared by both the projected-finish label and the
  // timeline below, so the two never disagree by even the few ms between
  // two separately-read Date.now() calls in the same render.
  const nowMs = Date.now();
  const projectedFinish = projectedFinishTime(projectionItems, new Date(nowMs));
  const projectedFinishLabel = projectedFinish.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });

  // Live task list timeline — see lib/task-timeline.ts. Same per-task data
  // as the projection above, just turned into proportional segment widths
  // instead of a single remaining-minutes total.
  const timeline = computeTimeline(
    tasks.map((task, i) => ({ id: task._id, ...projectionItems[i] })),
    nowMs
  );
  const timelineStartLabel = new Date(timeline.startInstant).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  // Optional on-track/behind indicator — compares the live projection above
  // against a static baseline (startTime + total projected minutes across
  // the list's timed tasks, same "checkbox excluded" convention
  // TaskListCard already uses for a list's collapse time). null when the
  // list has no startTime (custom lists), in which case no color/verdict is
  // shown, just the plain projected time.
  const timedTasks = tasks.filter((t) => t.taskType !== "checkbox");
  const totalProjectedForBaseline = timedTasks.reduce((s, t) => s + t.projectedMinutes, 0);
  const baselineFinish = staticBaselineFinish(today, taskListStartTime, totalProjectedForBaseline);
  const isBehindSchedule = baselineFinish ? projectedFinish.getTime() > baselineFinish.getTime() : null;

  // Countdown ring values
  const countdownRatio = isCountdown && target > 0 ? Math.min(elapsed / target, 1) : 0;
  const countdownColor = isOver ? "#dc2626" : countdownRatio >= 0.75 ? "#d97706" : "#1f63b6";
  const countdownOffset = RING_CIRC * (1 - countdownRatio);
  const countdownDisplay = isOver ? `+${fmtMins(elapsed - target)}` : fmtMins(target - elapsed);

  // Stopwatch ring values
  const stopwatchRatio = isStopwatch ? Math.min(elapsed / STOPWATCH_SOFT_CAP, 1) : 0;
  const stopwatchOffset = RING_CIRC * (1 - stopwatchRatio);

  return (
    <div className="fixed inset-0 bg-bg z-50 flex flex-col max-w-mobile mx-auto">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 pt-10 pb-2 flex-shrink-0">
        <button onClick={handleClose} className="flex items-center justify-center w-9 h-9 rounded-full bg-card text-dim">
          <X size={16} />
        </button>
        <span className="font-mono text-muted text-sm">{currentIndex + 1} of {tasks.length}</span>
      </div>

      {/* Which shift/list is running — otherwise nothing on this screen says
          so once you're past the initial "Start Tasks" tap. */}
      <div className="px-4 pb-1 flex-shrink-0 text-center">
        <span className="font-mono text-[10px] uppercase tracking-widest text-olive">{taskListName}</span>
      </div>

      {/* Live projected finish time — see lib/projected-finish.ts. Amber
          once the live projection is later than the static startTime +
          total-projected-minutes baseline — same "running behind" color the
          timeline bar below uses for an over-target active segment, so the
          two stay one consistent signal instead of two different colors
          meaning the same thing. */}
      <div className="px-4 pb-1 flex-shrink-0 text-center">
        <span
          className={`font-mono text-xs ${
            isBehindSchedule === true ? "text-amber" : isBehindSchedule === false ? "text-olive-light" : "text-dim"
          }`}
        >
          Projected finish: {projectedFinishLabel}
        </span>
      </div>

      {/* Live task list timeline — see lib/task-timeline.ts. One segment
          per task, left to right in list order, width = that task's
          current share of the list's running total (not a fixed original
          total) — so the active task visibly eats into the others' share of
          the bar as it runs over, instead of just growing off the end. */}
      <div className="px-4 pb-3 flex-shrink-0">
        <TimelineBar
          segments={timeline.segments.map((seg) => ({ id: seg.id, pct: seg.pct, color: TIMELINE_COLOR[seg.colorState] }))}
          startLabel={timelineStartLabel}
          endLabel={projectedFinishLabel}
        />
      </div>

      {/* Persistent, non-animated blue backdrop around the current-task
          card — same reasoning as TaskFormScreen's own outer layer: with
          Reduce Motion off, the card underneath used to visibly flash the
          page's white background mid-swap since nothing was there to cover
          it; this panel is always present regardless of `transitioning`, so
          the swap only ever shows blue behind the outgoing/incoming card,
          never the page. The card itself (bordered, ring/checkbox content
          swapped by taskType) plays task-advance-in/-out, same as
          TaskFormScreen's. */}
      <div className="mx-4 mt-1 mb-3 rounded-[26px] p-3" style={{ background: "#1f63b6" }}>
        <div
          key={currentTask._id}
          className={`rounded-[20px] border-2 border-white/25 bg-bg shadow-lg overflow-hidden select-none ${
            transitioning ? "task-advance-out pointer-events-none" : "task-advance-in"
          }`}
        >
          <div className="text-center px-4 pt-4 pb-3">
            <div className="flex justify-center mb-3">
              <AppIcon name={currentTask.icon} size={44} strokeWidth={1.25} className="text-text" />
            </div>
            <h2 className="font-heading text-xl text-text leading-tight">{currentTask.name}</h2>
            {isCountdown && (
              <p className="font-mono text-dim text-xs mt-1">{currentTask.projectedMinutes}m target</p>
            )}
            {isStopwatch && (
              <p className="font-mono text-dim text-xs mt-1">stopwatch · no target</p>
            )}
            {isCheckbox && (
              <p className="font-mono text-dim text-xs mt-1">mark when done</p>
            )}
          </div>

          {/* ── Countdown ring ── */}
          {isCountdown && (
            <div className="flex justify-center pb-5">
              <div className="relative w-44 h-44">
                <svg className="w-full h-full -rotate-90" viewBox="0 0 160 160">
                  <circle cx="80" cy="80" r={RING_R} fill="none" stroke="#dbe2ea" strokeWidth="9" />
                  <circle
                    cx="80" cy="80" r={RING_R}
                    fill="none"
                    stroke={countdownColor}
                    strokeWidth="9"
                    strokeLinecap="round"
                    strokeDasharray={RING_CIRC}
                    strokeDashoffset={countdownOffset}
                    style={{ transition: "stroke-dashoffset 0.95s linear, stroke 0.4s ease" }}
                  />
                  {/* Handle at the arc's tip — purely visual */}
                  <circle
                    cx={80 + RING_R * Math.cos(countdownRatio * 2 * Math.PI)}
                    cy={80 + RING_R * Math.sin(countdownRatio * 2 * Math.PI)}
                    r={8}
                    fill={countdownColor}
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="font-mono text-3xl font-semibold leading-none" style={{ color: isOver ? "#ef4444" : "#0f172a" }}>
                    {countdownDisplay}
                  </span>
                  <span className="font-mono text-[10px] text-dim mt-1">{isOver ? "over" : "remaining"}</span>
                </div>
              </div>
            </div>
          )}

          {/* ── Stopwatch ring ── */}
          {isStopwatch && (
            <div className="flex justify-center pb-5">
              <div className="relative w-44 h-44">
                <svg className="w-full h-full -rotate-90" viewBox="0 0 160 160">
                  <circle cx="80" cy="80" r={RING_R} fill="none" stroke="#dbe2ea" strokeWidth="9" />
                  <circle
                    cx="80" cy="80" r={RING_R}
                    fill="none"
                    stroke="#1f63b6"
                    strokeWidth="9"
                    strokeLinecap="round"
                    strokeDasharray={RING_CIRC}
                    strokeDashoffset={stopwatchOffset}
                    style={{ transition: "stroke-dashoffset 0.95s linear" }}
                  />
                  {/* Handle at the arc's tip — purely visual */}
                  <circle
                    cx={80 + RING_R * Math.cos(stopwatchRatio * 2 * Math.PI)}
                    cy={80 + RING_R * Math.sin(stopwatchRatio * 2 * Math.PI)}
                    r={8}
                    fill="#1f63b6"
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="font-mono text-3xl font-semibold leading-none text-text">
                    {fmtMins(elapsed)}
                  </span>
                  <span className="font-mono text-[10px] text-dim mt-1">elapsed</span>
                </div>
              </div>
            </div>
          )}

          {/* ── Checkbox: big done button instead of ring ── */}
          {isCheckbox && (
            <div className="flex items-center justify-center px-4 py-8">
              <button
                onClick={handleDone}
                className="w-44 h-44 rounded-full bg-olive/10 border-2 border-olive/40 flex flex-col items-center justify-center gap-2 active:bg-olive/20 transition-colors"
              >
                <span className="text-4xl text-olive">✓</span>
                <span className="font-body text-sm text-olive font-medium">Done</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Action buttons */}
      <div className="px-4 pb-4 flex-shrink-0 space-y-2">
        {/* Checkbox: just missed (done is the big button/modal above) */}
        {isCheckbox ? (
          <button onClick={handleMissed} className="w-full py-2.5 rounded-card border border-burgundy/30 text-burgundy-light font-body text-sm min-h-[44px]">
            ✗ Missed
          </button>
        ) : (
          <>
            <button onClick={handleDone} className="w-full py-3 rounded-card bg-olive text-text font-body font-medium">
              Done · log {Math.max(1, Math.round(elapsed / 60))}m
            </button>
            <div className="flex gap-2">
              <button
                onClick={() => setIsRunning((r) => !r)}
                className="flex-1 py-2.5 rounded-card border border-border-light text-muted font-body text-sm min-h-[44px]"
              >
                {isRunning ? "Pause" : "Resume"}
              </button>
              <button onClick={handleMissed} className="flex-1 py-2.5 rounded-card border border-burgundy/30 text-burgundy-light font-body text-sm min-h-[44px]">
                ✗ Missed
              </button>
            </div>
          </>
        )}
      </div>

      {/* Divider */}
      <div className="h-px bg-border mx-4 flex-shrink-0" />

      {/* Task list */}
      <div className="flex-1 overflow-y-auto px-4 pt-3 pb-4">
        {jumpNotice && (
          <p className="font-mono text-[10px] text-burgundy-light text-center mb-2">{jumpNotice}</p>
        )}
        <div className="space-y-1">
          {tasks.map((task, i) => {
            const isCurrent = i === currentIndex;
            const sessionLog = sessionLogs.find((l) => l.taskId === task._id);
            const live = !isCurrent ? latestLogs[task._id] : undefined;
            const ext = !isCurrent ? externalLogs?.[task._id] : undefined;
            const log: SessionLog | undefined =
              sessionLog ??
              (live && (live.state === "done" || live.state === "missed")
                ? { taskId: task._id, state: live.state, actualMinutes: live.actualMinutes }
                : ext && (ext.state === "done" || ext.state === "missed")
                  ? { taskId: task._id, state: ext.state, actualMinutes: ext.actualMinutes ?? 0 }
                  : undefined);
            const isDone = loggedIds.has(task._id);
            // Paused: started earlier in this session, left when you jumped
            // away — its elapsed time is banked, not lost, and resumes when
            // you jump back. Distinct from "upcoming" (never started): it
            // shouldn't render dimmed the way a never-started task does.
            const isPausedElsewhere = !isCurrent && !isDone && live?.state === "paused";
            // Rare: genuinely still ticking from another tab/device.
            const isRunningElsewhere = !isCurrent && !isDone && live?.state === "in_progress";
            const isUpcoming = !isDone && !isCurrent && !isPausedElsewhere && !isRunningElsewhere;
            const isTaskCheckbox = task.taskType === "checkbox";
            const isTaskStopwatch = task.taskType === "stopwatch";
            const isTaskForm = task.taskType === "form";
            // Anything not current and not finished can be jumped to —
            // pending tasks start fresh, paused/in_progress tasks resume.
            const canJump = (isUpcoming || isPausedElsewhere || isRunningElsewhere) && phase === "running";
            const isActiveElsewhere = isPausedElsewhere || isRunningElsewhere;

            return (
              <div
                key={task._id}
                role={canJump ? "button" : undefined}
                onClick={canJump ? () => handleJumpTo(i) : undefined}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-card transition-colors ${
                  isCurrent
                    ? "bg-olive/10 border border-olive/20"
                    : isActiveElsewhere
                      ? "bg-amber/10 border border-amber/20"
                      : isDone
                        ? "opacity-60"
                        : isUpcoming
                          ? "opacity-40"
                          : ""
                } ${canJump ? "cursor-pointer active:opacity-70 active:bg-card-hover" : ""}`}
              >
                <div className="w-6 flex items-center justify-center flex-shrink-0">
                  <AppIcon name={task.icon} size={15} strokeWidth={1.75} className={isCurrent ? "text-olive" : isActiveElsewhere ? "text-amber" : "text-dim"} />
                </div>
                <span className={`flex-1 font-body text-sm ${isCurrent ? "text-text font-medium" : isActiveElsewhere ? "text-text" : "text-muted"} ${log ? "line-through" : ""}`}>
                  {task.name}
                </span>
                <span className="font-mono text-dim text-xs flex-shrink-0">
                  {isTaskCheckbox
                    ? "✓"
                    : isTaskStopwatch
                      ? "⏱"
                      : isTaskForm
                        ? `${(task.formFields ?? []).length} fields`
                        : `${task.projectedMinutes}m`}
                </span>
                {log && (
                  <span className={`font-mono text-xs flex-shrink-0 ml-1 ${log.state === "done" ? "text-done" : log.state === "missed" ? "text-burgundy-light" : "text-blue-muted"}`}>
                    {log.state === "done" ? "✓" : log.state === "missed" ? "✗" : "~"}
                  </span>
                )}
                {isPausedElsewhere && (
                  <span className="font-mono text-amber text-[9px] flex-shrink-0">paused</span>
                )}
                {isRunningElsewhere && (
                  <span className="font-mono text-amber text-[9px] flex-shrink-0">running</span>
                )}
                {isCurrent && !log && <ChevronRight size={14} className="text-olive flex-shrink-0" />}
                {canJump && <span className="font-mono text-dim text-[9px] flex-shrink-0">jump</span>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
