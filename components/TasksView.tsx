"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Settings } from "lucide-react";
import Header from "@/components/Header";
import DateNav from "@/components/DateNav";
import TaskListCard, { type TaskListCardTaskList, type TaskListSessionSummary } from "@/components/TaskListCard";
import TimerScreen, { type TimerItem } from "@/components/TimerScreen";
import TaskFormScreen, { type InventoryCountEntry } from "@/components/TaskFormScreen";
import type { NotificationSound } from "@/lib/notification-sound";
import TaskListSessionView from "@/components/TaskListSessionView";
import AddTaskSheet from "@/components/AddTaskSheet";
import TodoSection, { type TodoEntry } from "@/components/TodoSection";
import EditTodoSheet from "@/components/EditTodoSheet";
import FABTodoSheet from "@/components/FABTodoSheet";
import type { LogState } from "@/models/TaskLog";
import type { FormFieldDef, FormFieldValue } from "@/models/TaskDefinition";
import { isTaskVisibleOn } from "@/lib/task-visibility";
import { isManagerOrAbove, isOwner } from "@/lib/roles";
import { useTodoActions } from "@/lib/useTodoActions";
import { emitTaskLogChanged, TASK_LOG_CHANGED_EVENT } from "@/lib/task-log-events";
import { startRoutineActivity, endRoutineActivity } from "@/lib/native/routine-activity";
import { TASK_TRANSITION_MS } from "@/lib/task-transition";
import { Capacitor } from "@capacitor/core";
import { useNetworkStatus } from "@/components/NetworkStatusProvider";
import { queueTaskLogMutation, pullSync, flushQueue } from "@/lib/offline-sync";

const LOG_POLL_MS = 2000;
// Ceiling for the adaptive backoff below — an idle foregrounded tab settles
// here after enough consecutive no-change poll-check ticks, rather than
// polling every LOG_POLL_MS forever. See the combined poll-check effect.
const MAX_POLL_MS = 30000;

export interface TaskLogEntry {
  _id: string;
  taskId: string;
  date: string;
  actualMinutes?: number;
  startedAt?: string;   // ISO string — set when timer starts; null/unset while paused
  completedAt?: string; // ISO string — set when timer finishes
  pausedSeconds?: number; // elapsed seconds banked from an earlier running segment (see models/TaskLog)
  state: LogState;
  sessionTaskListId?: string | null; // set when this in_progress timer is anchored inside a Task List Session
  formData?: Record<string, FormFieldValue> | null; // captured readings for a form task — see TaskRow.tsx's view-only shift-list rows
  photoUrl?: string | null; // Blob URL of the completion photo, if this task's TaskDefinition.requiresPhoto was set — see docs/features/task-completion-photo.md
  performedByUserId?: string | null; // who started/completed this log — drives TaskRow's/TaskCard's claim pill (in_progress/paused) and "by <name>" attribution (done/missed), see docs/features/task-lists.md
  performedByName?: string | null; // resolved server-side (GET /api/task-logs) for any log with a performedByUserId — this user's display name, visible to every teammate regardless of role
}

export type WeekLog = { taskId: string; date: string; state: LogState; actualMinutes: number | null };

interface Props {
  taskLists: TaskListCardTaskList[];
  initialLogs: TaskLogEntry[];
  // One TaskListSession summary per taskList (its most recent run today) —
  // powers TaskListCard's "✓ Done" pill (start/end time + session owner).
  // See lib/task-list-session-actions.ts's getSessionSummariesForDate.
  initialSessions: Array<TaskListSessionSummary & { taskListId: string }>;
  initialTodos: TodoEntry[];
  weekLogs: WeekLog[];
  weekDates: string[];
  today: string;
  userName: string;
  userId: string;
  userRole: "manager" | "employee" | "owner" | "developer";
  companyId: string; // scopes the offline SQLite cache/queue — see docs/features/offline.md
  // The location this page's data is scoped to (already resolved server-
  // side via pickActiveLocationId) — passed through only so the header's
  // location switcher can show the current selection; not used for any
  // fetch/mutation here, since every /api/task-logs call already resolves
  // this itself server-side.
  activeLocationId: string | null;
  // This signed-in user's own primary location (User.locationId) — see
  // Header.tsx's LocationContext.locationId.
  locationId: string | null;
  skipAuth?: boolean;
  autoStartNext?: boolean;
  autoAddTask?: boolean;
  autoResumeTimer?: boolean;
  autoOpenTaskId?: string | null; // set by BottomNav.tsx's FAB "scan to open" shortcut
  autoOpenVerifiedNfcUid?: string | null; // the UID that scan already read — pre-satisfies that task's own Scan NFC step, see TaskFormScreen.tsx
  notificationSound: NotificationSound; // which chirp to play on an NFC scan-to-complete save — see lib/notification-sound.ts
}

interface ActiveSession {
  taskList: TaskListCardTaskList;
  startIndex: number;
}

export default function TasksView({
  taskLists, initialLogs, initialSessions, initialTodos, weekLogs, weekDates,
  today, userName, userId, userRole, companyId, activeLocationId, locationId, skipAuth,
  autoStartNext = false,
  autoAddTask = false,
  autoResumeTimer = false,
  autoOpenTaskId = null,
  autoOpenVerifiedNfcUid = null,
  notificationSound,
}: Props) {
  const router = useRouter();
  const [selectedDate, setSelectedDate] = useState(today);
  const prevTodayRef = useRef(today);
  const [logs, setLogs] = useState<Record<string, TaskLogEntry>>(
    Object.fromEntries(initialLogs.map((l) => [l.taskId, l]))
  );
  const [sessions, setSessions] = useState<Record<string, TaskListSessionSummary>>(
    Object.fromEntries(initialSessions.map((s) => [s.taskListId, s]))
  );
  const [liveWeekLogs, setLiveWeekLogs] = useState<WeekLog[]>(weekLogs);
  const [timerItem, setTimerItem] = useState<TimerItem | null>(null);
  // True for the TASK_TRANSITION_MS window between a standalone form task's
  // completion actually saving and this screen closing back to the Tasks
  // list — holds TaskFormScreen mounted just long enough to play its exit
  // animation instead of vanishing the instant the save resolves. See
  // handleTaskFormComplete below.
  const [closingTimerItem, setClosingTimerItem] = useState(false);
  const [timerInitialElapsed, setTimerInitialElapsed] = useState(0);
  // Set alongside timerItem only by the autoOpenTaskId branch below — the
  // FAB's "scan to open" shortcut already read this task's tag on the way
  // in, so TaskFormScreen can skip straight to Save. Keyed by taskId (not
  // just a bare uid) so it can never leak onto a different task opened by
  // any other path (tapping a task directly, resuming, session navigation).
  const [preVerified, setPreVerified] = useState<{ taskId: string; uid: string } | null>(null);
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [addTaskSheetFor, setAddTaskSheetFor] = useState<{ id: string; name: string } | null>(null);
  const [todos, setTodos] = useState<TodoEntry[]>(initialTodos);
  const [addTodoOpen, setAddTodoOpen] = useState(false);
  const [editingTodo, setEditingTodo] = useState<TodoEntry | null>(null);

  const isPastDate = selectedDate !== today;

  // "Task list label" for a standalone (non-session) Live Activity — see
  // lib/native/routine-activity.ts. Session tasks get their list's own name
  // directly from the loop that already has it (openInProgressTimer,
  // TaskListSessionView.tsx); this lookup is only needed here for the
  // standalone TimerScreen path, which doesn't otherwise know which list
  // its task belongs to.
  const findTaskListName = useCallback(
    (taskId: string) => taskLists.find((tl) => tl.tasks.some((t) => t._id === taskId))?.name ?? "Timer",
    [taskLists]
  );

  // Split into scheduled shift task lists and standalone anytime task lists.
  // A shift list with zero tasks scheduled for the selected date (e.g. a
  // manager set the whole list to "Monday only") drops off the Tasks screen
  // entirely that day, rather than rendering as an empty "0/0" card — see
  // lib/task-visibility.ts.
  const scheduledTaskLists = useMemo(
    () =>
      taskLists.filter(
        (tl) => tl.timeOfDay !== "anytime" && tl.tasks.some((t) => isTaskVisibleOn(t, selectedDate))
      ),
    [taskLists, selectedDate]
  );
  const anytimeTaskLists = useMemo(() => taskLists.filter((tl) => tl.timeOfDay === "anytime"), [taskLists]);

  // Handle URL params passed from FAB navigation
  useEffect(() => {
    if (autoStartNext) {
      const logsMap = Object.fromEntries(initialLogs.map((l) => [l.taskId, l]));
      let found: TimerItem | null = null;
      outer: for (const tl of scheduledTaskLists) {
        const visible = tl.tasks.filter((t) => isTaskVisibleOn(t, today));
        for (const task of visible) {
          if (!logsMap[task._id]) { found = task; break outer; }
        }
      }
      if (found) { setTimerInitialElapsed(0); setTimerItem(found); }
      router.replace("/tasks");
    }
    if (autoAddTask) {
      const target = anytimeTaskLists[0];
      if (target) setAddTaskSheetFor({ id: target._id, name: target.name });
      router.replace("/tasks");
    }
    if (autoOpenTaskId) {
      const found = taskLists.flatMap((tl) => tl.tasks).find((t) => t._id === autoOpenTaskId) ?? null;
      if (found) {
        if (autoOpenVerifiedNfcUid) setPreVerified({ taskId: found._id, uid: autoOpenVerifiedNfcUid });
        // A shift-window task now claims exactly like an anytime task — see
        // docs/features/task-lists.md's "Per-task claiming." handleStartTimer
        // already knows how to resume a session-anchored in_progress/paused
        // log into the guided TaskListSessionView (reproducing "tapped Start
        // Tasks and navigated to that task by hand"), resume a plain
        // standalone timer, or claim a fresh task — same three-way branch a
        // tap on TaskRow's own Start/Resume button goes through, so a FAB
        // scan and a per-row tap land in exactly the same place.
        handleStartTimer(found);
      }
      router.replace("/tasks");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStartNext, autoAddTask, autoOpenTaskId, autoOpenVerifiedNfcUid]);

  // Shared by both resume effects below — finds the day's in_progress log.
  // Only one is ever in_progress at a time (jumping to a different task
  // inside a Task List Session pauses whatever was running instead of
  // leaving it in_progress — see switchActiveLog in lib/task-log-actions.ts),
  // but sort defensively in case more than one ever exists transiently.
  // If it carries a sessionTaskListId (set via the session itself, or the
  // external API's routineGroupId param), reopen it inside a
  // TaskListSessionView for that list, anchored at that task, instead of the
  // standalone timer — reproducing "tapped Start Tasks and navigated to
  // that task by hand." Otherwise opens TimerScreen as before, seeded with
  // elapsed time computed from the server-recorded startedAt. Returns
  // whether it found one.
  const openInProgressTimer = useCallback(() => {
    const inProgressLogs = initialLogs.filter((l) => l.state === "in_progress" && l.startedAt);
    const inProgressLog = inProgressLogs.sort(
      (a, b) => new Date(b.startedAt!).getTime() - new Date(a.startedAt!).getTime()
    )[0];
    if (!inProgressLog?.startedAt) return false;

    if (inProgressLog.sessionTaskListId) {
      const taskList = taskLists.find((tl) => tl._id === inProgressLog.sessionTaskListId);
      const startIndex = taskList?.tasks.findIndex((t) => t._id === inProgressLog.taskId) ?? -1;
      if (taskList && startIndex !== -1) {
        setActiveSession({ taskList, startIndex });
        return true;
      }
      // Fall through to the standalone timer if the list/task can't be
      // resolved (e.g. the list was deleted after the anchor was set).
    }

    for (const tl of [...scheduledTaskLists, ...anytimeTaskLists]) {
      const task = tl.tasks.find((t) => t._id === inProgressLog.taskId);
      if (task) {
        const elapsed = (inProgressLog.pausedSeconds ?? 0) + Math.max(0, Math.floor((Date.now() - new Date(inProgressLog.startedAt).getTime()) / 1000));
        setTimerInitialElapsed(elapsed);
        setTimerItem(task as TimerItem);
        // Re-syncs the Live Activity on cold start — idempotent (start()
        // always ends any existing activity first), so this is safe even
        // though the Activity likely already survived the app being closed.
        // NOTE: routineItemId/routineLabel/habitName are wire-contract keys
        // for the un-renamed iOS RoutineActivity target — see
        // lib/native/routine-activity.ts.
        startRoutineActivity({
          routineItemId: task._id,
          routineLabel: tl.name,
          habitName: task.name,
          startedAt: new Date(Date.now() - elapsed * 1000).toISOString(),
          projectedMinutes: task.taskType === "stopwatch" ? 0 : task.projectedMinutes,
        });
        return true;
      }
    }
    return false;
  }, [initialLogs, scheduledTaskLists, anytimeTaskLists, taskLists]);

  // Auto-resume any in_progress timer from a previous session
  useEffect(() => {
    if (autoStartNext) return; // FAB will handle timer open
    openInProgressTimer();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Explicit resume request from the FAB's active-timer indicator (see
  // BottomNav.tsx) — must work even when TasksView was already mounted on
  // this route, unlike the mount-only effect above, since navigating to the
  // same route with a new search param doesn't remount the component.
  useEffect(() => {
    if (!autoResumeTimer) return;
    openInProgressTimer();
    router.replace("/tasks");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoResumeTimer]);

  // Correct for server/client timezone mismatch — server uses UTC, browser knows local date.
  useEffect(() => {
    const localDate = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local tz
    if (localDate !== today) {
      router.replace(`/tasks?date=${localDate}`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-run that same check whenever the app returns to the foreground, not just
  // at mount. A backgrounded/suspended PWA (the normal case on iOS — it isn't
  // killed, just frozen in memory) never remounts on its own, so without this
  // the mount-only check above can't catch the calendar day having rolled over
  // while it was asleep — you'd keep seeing last night's "today" until some
  // other navigation happened to force a reload. Only acts while viewing
  // Today; doesn't yank the user out of intentional history browsing.
  useEffect(() => {
    const recheckDate = () => {
      if (document.visibilityState !== "visible") return;
      if (selectedDate !== today) return;
      const localDate = new Date().toLocaleDateString("en-CA");
      if (localDate !== today) {
        router.replace(`/tasks?date=${localDate}`);
      }
    };
    document.addEventListener("visibilitychange", recheckDate);
    window.addEventListener("focus", recheckDate);
    window.addEventListener("pageshow", recheckDate);
    return () => {
      document.removeEventListener("visibilitychange", recheckDate);
      window.removeEventListener("focus", recheckDate);
      window.removeEventListener("pageshow", recheckDate);
    };
  }, [today, selectedDate, router]);

  // If `today` changes (e.g. timezone redirect delivers a new date from the server),
  // move selectedDate forward so logs sync to the correct day.
  useEffect(() => {
    if (prevTodayRef.current !== today) {
      if (selectedDate === prevTodayRef.current) setSelectedDate(today);
      prevTodayRef.current = today;
    }
  }, [today, selectedDate]);

  const refetchLogs = useCallback(async () => {
    try {
      const res = await fetch(`/api/task-logs?date=${selectedDate}`);
      if (!res.ok) return;
      const data: TaskLogEntry[] = await res.json();
      setLogs(Object.fromEntries(data.map((l) => [l.taskId, l])));
    } catch {
      // keep previous state; next poll/event will retry
    }
  }, [selectedDate]);

  // A TaskListSession only ever changes alongside a TaskLog write (see
  // lib/task-list-session-actions.ts), so this is fetched at exactly the
  // same points refetchLogs is — never on its own separate poll.
  const refetchSessions = useCallback(async () => {
    try {
      const res = await fetch(`/api/task-list-sessions?date=${selectedDate}`);
      if (!res.ok) return;
      const data: Array<TaskListSessionSummary & { taskListId: string }> = await res.json();
      setSessions(Object.fromEntries(data.map((s) => [s.taskListId, s])));
    } catch {
      // keep previous state; next poll/event will retry
    }
  }, [selectedDate]);

  // Re-fetch logs whenever the selected date changes
  useEffect(() => {
    if (selectedDate === today) {
      setLogs(Object.fromEntries(initialLogs.map((l) => [l.taskId, l])));
      setSessions(Object.fromEntries(initialSessions.map((s) => [s.taskListId, s])));
      return;
    }
    let cancelled = false;
    fetch(`/api/task-logs?date=${selectedDate}`)
      .then((r) => r.json())
      .then((data: TaskLogEntry[]) => {
        if (!cancelled) {
          setLogs(Object.fromEntries(data.map((l) => [l.taskId, l])));
        }
      });
    fetch(`/api/task-list-sessions?date=${selectedDate}`)
      .then((r) => r.json())
      .then((data: Array<TaskListSessionSummary & { taskListId: string }>) => {
        if (!cancelled) {
          setSessions(Object.fromEntries(data.map((s) => [s.taskListId, s])));
        }
      });
    return () => { cancelled = true; };
  }, [selectedDate, today, initialLogs, initialSessions]);

  // Keeps today's TaskLogs (external App Intent / Siri / Shortcuts triggers,
  // and — since per-task claiming replaced the list-level session lock, see
  // docs/features/task-lists.md's "Per-task claiming" — any teammate
  // claiming/completing a shift-list task from their own device) live while
  // the Tasks page sits open and visible, without paying for a full fetch
  // every LOG_POLL_MS. Each tick hits GET /api/task-logs/poll-check instead:
  // a cheap {count, maxUpdatedAt} fingerprint (no document bodies), and only
  // calls the real refetch when it actually differs from what was last
  // seen. On top of that, the interval itself backs off geometrically
  // (LOG_POLL_MS -> ... -> MAX_POLL_MS) after consecutive unchanged ticks —
  // a foregrounded idle tab (a kiosk iPad, a tester who left the app open)
  // is the common case, not someone actively working through a list, so
  // most of the time there's nothing to see. Any of the "something
  // happened" signals (same-tab event, tab refocused) resets the backoff
  // back to LOG_POLL_MS immediately, so active use still feels like a flat
  // 2s poll. Only runs while viewing today — nothing external changes a
  // past day.
  useEffect(() => {
    if (selectedDate !== today) return;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout>;
    let consecutiveUnchanged = 0;
    // undefined = "haven't checked yet" — the first tick just seeds this
    // rather than treating "no prior version" as a change, since the
    // mount-time effect above already fetched fresh data.
    let lastLogsVersion: string | undefined;

    const tick = async () => {
      if (document.visibilityState === "visible") {
        try {
          const res = await fetch(`/api/task-logs/poll-check?date=${selectedDate}`);
          if (res.ok) {
            const { logsVersion }: { logsVersion: string } = await res.json();
            let changed = false;
            if (lastLogsVersion !== undefined && lastLogsVersion !== logsVersion) {
              changed = true;
              refetchLogs();
              refetchSessions();
            }
            lastLogsVersion = logsVersion;
            consecutiveUnchanged = changed ? 0 : consecutiveUnchanged + 1;
          }
        } catch {
          // next tick retries
        }
      }
      if (cancelled) return;
      const delay = Math.min(LOG_POLL_MS * 2 ** consecutiveUnchanged, MAX_POLL_MS);
      timeoutId = setTimeout(tick, delay);
    };

    const resetBackoff = () => {
      consecutiveUnchanged = 0;
      clearTimeout(timeoutId);
      timeoutId = setTimeout(tick, LOG_POLL_MS);
    };
    const onChanged = () => {
      refetchLogs();
      refetchSessions();
      resetBackoff();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") resetBackoff();
    };

    window.addEventListener(TASK_LOG_CHANGED_EVENT, onChanged);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    timeoutId = setTimeout(tick, LOG_POLL_MS);

    return () => {
      cancelled = true;
      window.removeEventListener(TASK_LOG_CHANGED_EVENT, onChanged);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      clearTimeout(timeoutId);
    };
  }, [selectedDate, today, refetchLogs, refetchSessions]);

  // Re-fetch to-dos whenever the selected date changes
  useEffect(() => {
    if (selectedDate === today) {
      setTodos(initialTodos);
      return;
    }
    let cancelled = false;
    fetch(`/api/todos?date=${selectedDate}`)
      .then((r) => r.json())
      .then((data: TodoEntry[]) => {
        if (!cancelled) setTodos(data);
      });
    return () => { cancelled = true; };
  }, [selectedDate, today, initialTodos]);

  // A todo stays visible on this (today's) list if it's due today, or if it's
  // an earlier undone item carried forward as overdue.
  const isTodoVisibleToday = useCallback(
    (t: TodoEntry) => t.scheduledDate === selectedDate || (!t.done && t.scheduledDate < selectedDate),
    [selectedDate]
  );
  const { toggle: handleToggleTodo, remove: handleDeleteTodo, update: handleUpdateTodo } =
    useTodoActions(todos, setTodos, isTodoVisibleToday);

  // weekLogs keyed by taskId → array of {date, state, actualMinutes}
  const weekLogsByTask: Record<string, Array<{ date: string; state: LogState; actualMinutes: number | null }>> = {};
  for (const wl of liveWeekLogs) {
    if (!weekLogsByTask[wl.taskId]) weekLogsByTask[wl.taskId] = [];
    weekLogsByTask[wl.taskId].push({ date: wl.date, state: wl.state, actualMinutes: wl.actualMinutes });
  }

  // Offline support — see docs/features/offline.md. Resolved here (not in
  // components/NetworkStatusProvider.tsx) because this is the one place
  // that both knows companyId and cares about sync timing; the provider
  // itself is mounted at the root layout, before any company is resolved.
  const { isOnline, refreshPendingCount } = useNetworkStatus();
  const wasOfflineRef = useRef(!isOnline);
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const wasOffline = wasOfflineRef.current;
    wasOfflineRef.current = !isOnline;
    if (!isOnline) return;
    (async () => {
      // A reconnect (not just the initial online mount) flushes the outbox
      // before pulling — otherwise a pending local mutation could be
      // clobbered by the very sync meant to refresh around it (pull sync
      // already guards against overwriting a 'pending' row regardless, but
      // flushing first gets it acknowledged and out of 'pending' sooner).
      if (wasOffline) await flushQueue();
      await pullSync(companyId, today);
      refreshPendingCount();
    })();
  }, [isOnline, companyId, today, refreshPendingCount]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let removeListener: (() => void) | undefined;
    import("@capacitor/app").then(({ App }) => {
      const handle = App.addListener("resume", () => {
        flushQueue()
          .then(() => pullSync(companyId, today))
          .then(refreshPendingCount);
      });
      handle.then((h) => {
        removeListener = () => h.remove();
      });
    });
    return () => removeListener?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, today]);

  const handleStateChange = useCallback(
    async (
      taskId: string,
      newState: LogState | null,
      opts?: {
        actualMinutes?: number;
        isBackEntry?: boolean;
        startedAt?: string;
        completedAt?: string;
        formData?: Record<string, FormFieldValue>;
        photoUrl?: string | null;
      }
    ) => {
      const prev = logs[taskId];

      // Keep streak dots in sync without a full refresh
      const patchWeekLog = (state: LogState | null, actualMinutes: number | null = null) => {
        setLiveWeekLogs((prev) => {
          const next = prev.filter(
            (w) => !(w.taskId === taskId && w.date === selectedDate)
          );
          if (state && state !== "in_progress") {
            next.push({ taskId, date: selectedDate, state, actualMinutes });
          }
          return next;
        });
      };

      if (newState === null) {
        patchWeekLog(null);
        setLogs((l) => {
          const next = { ...l };
          delete next[taskId];
          return next;
        });
        await fetch("/api/task-logs", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId, date: selectedDate }),
        });
        emitTaskLogChanged();
      } else if (opts?.startedAt && opts?.completedAt) {
        // Manual time edit — use PATCH with explicit timestamps
        const mins = Math.max(1, Math.round(
          (new Date(opts.completedAt).getTime() - new Date(opts.startedAt).getTime()) / 60000
        ));
        patchWeekLog(newState, mins);
        const optimistic: TaskLogEntry = {
          _id: prev?._id ?? "",
          taskId,
          date: selectedDate,
          state: newState,
          actualMinutes: mins,
          startedAt: opts.startedAt,
          completedAt: opts.completedAt,
        };
        setLogs((l) => ({ ...l, [taskId]: optimistic }));
        const patchBody = {
          taskId,
          date: selectedDate,
          state: newState,
          startedAt: opts.startedAt,
          completedAt: opts.completedAt,
          formData: opts.formData,
        };
        if (!isOnline) {
          await queueTaskLogMutation({
            method: "PATCH",
            companyId,
            taskId,
            performedByUserId: userId,
            date: selectedDate,
            state: newState,
            startedAt: opts.startedAt,
            completedAt: opts.completedAt,
            formValues: opts.formData ?? null,
            body: patchBody,
          });
          refreshPendingCount();
          emitTaskLogChanged();
          return;
        }
        const res = await fetch("/api/task-logs", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patchBody),
        });
        if (res.ok) {
          const saved = await res.json();
          setLogs((l) => ({ ...l, [taskId]: saved }));
        }
      } else {
        patchWeekLog(newState, opts?.actualMinutes ?? prev?.actualMinutes ?? null);
        const optimistic: TaskLogEntry = {
          _id: prev?._id ?? "",
          taskId,
          date: selectedDate,
          state: newState,
          actualMinutes: opts?.actualMinutes ?? prev?.actualMinutes,
          photoUrl: opts?.photoUrl ?? prev?.photoUrl,
        };
        setLogs((l) => ({ ...l, [taskId]: optimistic }));

        const postBody = {
          taskId,
          date: selectedDate,
          state: newState,
          actualMinutes: opts?.actualMinutes,
          isBackEntry: opts?.isBackEntry ?? isPastDate,
          photoUrl: opts?.photoUrl,
        };
        if (!isOnline) {
          await queueTaskLogMutation({
            method: "POST",
            companyId,
            taskId,
            performedByUserId: userId,
            date: selectedDate,
            state: newState,
            completedAt: new Date().toISOString(),
            body: postBody,
          });
          refreshPendingCount();
          emitTaskLogChanged();
          return;
        }
        const res = await fetch("/api/task-logs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(postBody),
        });
        if (res.ok) {
          const saved = await res.json();
          setLogs((l) => ({ ...l, [taskId]: saved }));
        }
      }
    },
    [logs, selectedDate, isPastDate, isOnline, companyId, userId, refreshPendingCount]
  );

  // Opens the timer for a task. Creates an in_progress log on first tap;
  // resumes from stored startedAt if one already exists.
  const handleStartTimer = useCallback(
    async (task: TimerItem) => {
      const existingLog = logs[task._id];

      if (existingLog?.state === "in_progress" || existingLog?.state === "paused") {
        // Session-anchored (started via the session itself, or the external
        // API with a list id) — resuming this task means resuming the
        // session, not the standalone timer. A paused task always carries
        // its session anchor (pausing only ever happens from within an open
        // session), and its startedAt is null, so it can't be resumed as a
        // standalone timer anyway.
        if (existingLog.sessionTaskListId) {
          const taskList = taskLists.find((tl) => tl._id === existingLog.sessionTaskListId);
          if (taskList) {
            const startIndex = Math.max(0, taskList.tasks.findIndex((t) => t._id === task._id));
            setActiveSession({ taskList, startIndex });
            return;
          }
        }
        if (existingLog.state === "in_progress" && existingLog.startedAt) {
          const elapsed = (existingLog.pausedSeconds ?? 0) + Math.max(0, Math.floor((Date.now() - new Date(existingLog.startedAt).getTime()) / 1000));
          setTimerInitialElapsed(elapsed);
          setTimerItem(task);
          startRoutineActivity({
            routineItemId: task._id,
            routineLabel: findTaskListName(task._id),
            habitName: task.name,
            startedAt: new Date(Date.now() - elapsed * 1000).toISOString(),
            projectedMinutes: task.taskType === "stopwatch" ? 0 : task.projectedMinutes,
          });
          return;
        }
        // Paused with no resolvable session (e.g. the list was deleted) —
        // fall through to start fresh below; the server still preserves its
        // banked time (see startInProgressLog), only the initial display
        // resets to 0.
      }

      // Create in_progress log immediately so startedAt is server-authoritative
      const optimistic: TaskLogEntry = {
        _id: existingLog?._id ?? "",
        taskId: task._id,
        date: selectedDate,
        state: "in_progress",
        startedAt: new Date().toISOString(),
      };
      setLogs((l) => ({ ...l, [task._id]: optimistic }));

      if (!isOnline) {
        // Offline — the single-active-timer invariant is a server-side
        // check (completeStrayInProgressLogs), so it doesn't run here; the
        // optimistic local state is the best available truth until this
        // syncs. See docs/features/offline.md.
        await queueTaskLogMutation({
          method: "POST",
          companyId,
          taskId: task._id,
          performedByUserId: userId,
          date: selectedDate,
          state: "in_progress",
          startedAt: optimistic.startedAt,
          body: { taskId: task._id, date: selectedDate, state: "in_progress" },
        });
        refreshPendingCount();
      } else {
        await fetch("/api/task-logs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId: task._id, date: selectedDate, state: "in_progress" }),
        });

        // The server also auto-completes any other dangling in_progress log for
        // this user (single-active-timer invariant, enforced in the route
        // handler) — re-fetch the whole day so that gets reflected locally too,
        // not just the task we just started.
        try {
          const res = await fetch(`/api/task-logs?date=${selectedDate}`);
          if (res.ok) {
            const fresh: TaskLogEntry[] = await res.json();
            setLogs(Object.fromEntries(fresh.map((l) => [l.taskId, l])));
          }
        } catch { /* optimistic state already applied; will resync on next refresh */ }
      }

      emitTaskLogChanged();
      setTimerInitialElapsed(0);
      setTimerItem(task);
      startRoutineActivity({
        routineItemId: task._id,
        routineLabel: findTaskListName(task._id),
        habitName: task.name,
        startedAt: optimistic.startedAt!,
        projectedMinutes: task.taskType === "stopwatch" ? 0 : task.projectedMinutes,
      });
    },
    [logs, selectedDate, taskLists, findTaskListName, isOnline, companyId, userId, refreshPendingCount]
  );

  // PATCH the in_progress log to done. Server derives actualMinutes from startedAt.
  // Falls back to client-computed actualMinutes if no server timestamp exists.
  const handleTimerComplete = useCallback(
    async (actualMinutes: number, photoUrl?: string | null) => {
      if (!timerItem) return;
      setLogs((l) => ({
        ...l,
        [timerItem._id]: { ...(l[timerItem._id] ?? { _id: "", taskId: timerItem._id, date: selectedDate }), state: "done", actualMinutes, photoUrl },
      }));
      const patchBody = { taskId: timerItem._id, date: selectedDate, state: "done" as const, actualMinutes, photoUrl };
      if (!isOnline) {
        await queueTaskLogMutation({
          method: "PATCH",
          companyId,
          taskId: timerItem._id,
          performedByUserId: userId,
          date: selectedDate,
          state: "done",
          completedAt: new Date().toISOString(),
          body: patchBody,
        });
        refreshPendingCount();
      } else {
        const res = await fetch("/api/task-logs", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patchBody),
        });
        if (res.ok) {
          const saved: TaskLogEntry = await res.json();
          setLogs((l) => ({ ...l, [timerItem._id]: saved }));
        }
      }
      emitTaskLogChanged();
      setTimerItem(null);
      endRoutineActivity();
    },
    [timerItem, selectedDate, isOnline, companyId, userId, refreshPendingCount]
  );

  // Same PATCH path as handleTimerComplete, plus formData — see
  // components/TaskFormScreen.tsx. actualMinutes is still server-derived
  // from startedAt (see completeInProgressLog); the client-computed value
  // here is only the fallback, same as the standalone timer's Done button.
  const handleTaskFormComplete = useCallback(
    async (
      formData: Record<string, FormFieldValue>,
      actualMinutes: number,
      verifiedNfcUid?: string | null,
      inventoryCounts?: InventoryCountEntry[],
      photoUrl?: string | null
    ) => {
      if (!timerItem) return;
      const taskId = timerItem._id;
      const patchBody = { taskId, date: selectedDate, state: "done" as const, actualMinutes, formData, verifiedNfcUid, inventoryCounts, photoUrl };
      if (!isOnline) {
        // NFC verification (assertNfcVerified) is a server-side check —
        // offline, verifiedNfcUid (if this task is tag-bound) is trusted
        // optimistically and re-validated when the queued PATCH actually
        // syncs; a mismatch then surfaces as a 'conflict' row instead of
        // blocking the completion now. See docs/features/offline.md.
        await queueTaskLogMutation({
          method: "PATCH",
          companyId,
          taskId,
          performedByUserId: userId,
          date: selectedDate,
          state: "done",
          completedAt: new Date().toISOString(),
          formValues: formData,
          body: patchBody,
        });
        refreshPendingCount();
        setLogs((l) => ({
          ...l,
          [taskId]: { ...(l[taskId] ?? { _id: "", taskId, date: selectedDate }), state: "done", actualMinutes, formData, photoUrl },
        }));
      } else {
        const res = await fetch("/api/task-logs", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patchBody),
        });
        if (!res.ok) {
          // e.g. an NFC-bound task with no/mismatched scan (see
          // docs/features/nfc.md) — don't touch logs or close the form; let
          // TaskFormScreen show this inline and let the user retry.
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || "Failed to complete task — please try again.");
        }
        const saved: TaskLogEntry = await res.json();
        setLogs((l) => ({ ...l, [taskId]: saved }));
      }
      emitTaskLogChanged();
      // Saved — hold this screen up playing its exit animation
      // (task-advance-out, via TaskFormScreen's `exiting` prop) before
      // actually closing back to the Tasks list, instead of vanishing the
      // instant the PATCH resolves.
      setClosingTimerItem(true);
      await new Promise((resolve) => setTimeout(resolve, TASK_TRANSITION_MS));
      setTimerItem(null);
      setPreVerified(null);
      setClosingTimerItem(false);
      endRoutineActivity();
    },
    [timerItem, selectedDate, isOnline, companyId, userId, refreshPendingCount]
  );

  const handleTimerMissed = useCallback(async () => {
    if (!timerItem) return;
    setLogs((l) => ({
      ...l,
      [timerItem._id]: { ...(l[timerItem._id] ?? { _id: "", taskId: timerItem._id, date: selectedDate }), state: "missed" },
    }));
    const patchBody = { taskId: timerItem._id, date: selectedDate, state: "missed" as const };
    if (!isOnline) {
      await queueTaskLogMutation({
        method: "PATCH",
        companyId,
        taskId: timerItem._id,
        performedByUserId: userId,
        date: selectedDate,
        state: "missed",
        completedAt: new Date().toISOString(),
        body: patchBody,
      });
      refreshPendingCount();
    } else {
      await fetch("/api/task-logs", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patchBody),
      });
    }
    emitTaskLogChanged();
    setTimerItem(null);
    setPreVerified(null);
    endRoutineActivity();
  }, [timerItem, selectedDate, isOnline, companyId, userId, refreshPendingCount]);

  const handleSessionFinish = useCallback(async () => {
    setActiveSession(null);
    setPreVerified(null);
    // Re-fetch logs immediately so isComplete is accurate before router.refresh() arrives.
    // TaskListSessionView writes directly to the DB without updating the parent
    // logs state, so without this the list would briefly re-open with the
    // Start/Continue button.
    try {
      const res = await fetch(`/api/task-logs?date=${selectedDate}`);
      if (res.ok) {
        const fresh = (await res.json()) as TaskLogEntry[];
        setLogs(Object.fromEntries(fresh.map((l) => [l.taskId, l])));
      }
    } catch { /* silent — router.refresh() below will sync eventually */ }
    router.refresh();
  }, [router, selectedDate]);

  const handleAddTask = useCallback(
    async (
      templateId: string | null,
      name: string,
      icon: string,
      projectedMinutes: number,
      taskType: "standard" | "stopwatch" | "checkbox" | "form" = "form",
      scheduledDays: number[] = [0, 1, 2, 3, 4, 5, 6],
      successThreshold: number = 7,
      formFields: FormFieldDef[] = []
    ) => {
      if (!addTaskSheetFor) return null;
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskListId: addTaskSheetFor.id,
          templateId,
          name,
          icon,
          projectedMinutes,
          taskType,
          scheduledDays,
          successThreshold,
          formFields,
        }),
      });
      router.refresh();
      if (!res.ok) return null;
      const created = await res.json();
      return {
        definitionId: created.definitionId,
        nfcTagUid: created.nfcTagUid ?? null,
        instructionSteps: created.instructionSteps ?? [],
        requiresPhoto: created.requiresPhoto ?? false,
      };
      // AddTaskSheet itself closes the sheet — see its onAdd prop comment;
      // it either closes right away (quick template add) or after the
      // "Task Added" phase-2 panels' Done button (Create custom task).
    },
    [addTaskSheetFor, router]
  );

  const handleAddExistingTask = useCallback(
    async (definitionId: string) => {
      if (!addTaskSheetFor) return;
      await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskListId: addTaskSheetFor.id, definitionId }),
      });
      setAddTaskSheetFor(null);
      router.refresh();
    },
    [addTaskSheetFor, router]
  );

  const handleAddCloneTask = useCallback(
    async (definitionId: string) => {
      if (!addTaskSheetFor) return;
      await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskListId: addTaskSheetFor.id, cloneFromDefinitionId: definitionId }),
      });
      setAddTaskSheetFor(null);
      router.refresh();
    },
    [addTaskSheetFor, router]
  );

  const totalDone = Object.values(logs).filter((l) => l.state === "done").length;
  const totalTasks = taskLists.reduce(
    (acc, tl) => acc + tl.tasks.filter((t) => isTaskVisibleOn(t, selectedDate)).length,
    0
  );

  const sessionTaskList = activeSession
    ? taskLists.find((tl) => tl._id === activeSession.taskList._id) ?? activeSession.taskList
    : null;
  const sessionTasks = sessionTaskList
    ? sessionTaskList.tasks.filter((t) => isTaskVisibleOn(t, selectedDate))
    : [];

  return (
    <div className="min-h-dvh bg-bg">
      {timerItem && (
        timerItem.taskType === "form" ? (
          <TaskFormScreen
            key={timerItem._id}
            item={timerItem}
            initialElapsed={timerInitialElapsed}
            taskListName={findTaskListName(timerItem._id)}
            preVerifiedNfcUid={preVerified?.taskId === timerItem._id ? preVerified.uid : null}
            notificationSound={notificationSound}
            onComplete={handleTaskFormComplete}
            onMissed={handleTimerMissed}
            onClose={() => { setTimerItem(null); setPreVerified(null); }}
            exiting={closingTimerItem}
          />
        ) : (
          <TimerScreen
            item={timerItem}
            initialElapsed={timerInitialElapsed}
            taskListName={findTaskListName(timerItem._id)}
            onComplete={handleTimerComplete}
            onMissed={handleTimerMissed}
            onClose={() => setTimerItem(null)}
          />
        )
      )}

      {sessionTaskList && (
        <TaskListSessionView
          taskListId={sessionTaskList._id}
          taskListName={sessionTaskList.name}
          taskListStartTime={sessionTaskList.startTime}
          tasks={sessionTasks}
          logs={logs}
          today={selectedDate}
          companyId={companyId}
          userId={userId}
          startIndex={activeSession?.startIndex ?? 0}
          preVerifiedTaskId={preVerified?.taskId ?? null}
          preVerifiedNfcUid={preVerified?.uid ?? null}
          notificationSound={notificationSound}
          onClose={handleSessionFinish}
          onFinish={handleSessionFinish}
        />
      )}

      {addTaskSheetFor && (
        <AddTaskSheet
          taskListId={addTaskSheetFor.id}
          taskListName={addTaskSheetFor.name}
          onAdd={handleAddTask}
          onAddExisting={handleAddExistingTask}
          onAddClone={handleAddCloneTask}
          onClose={() => setAddTaskSheetFor(null)}
        />
      )}


      {addTodoOpen && (
        <FABTodoSheet
          date={selectedDate}
          onClose={() => setAddTodoOpen(false)}
        />
      )}

      {editingTodo && (
        <EditTodoSheet
          todo={editingTodo}
          onSave={(updates) => handleUpdateTodo(editingTodo._id, updates)}
          onDelete={() => { handleDeleteTodo(editingTodo._id); setEditingTodo(null); }}
          onClose={() => setEditingTodo(null)}
        />
      )}

      <div className="mx-auto max-w-mobile px-4 pb-28">
        <Header
          userName={userName}
          skipAuth={skipAuth}
          location={{ isOwner: isOwner(userRole), activeLocationId, locationId }}
        />

        <>
          {/* Date navigation */}
            <DateNav
              selectedDate={selectedDate}
              today={today}
              maxDaysBack={7}
              onChange={setSelectedDate}
            />

            {/* Progress bar */}
            <div className="mb-8">
              <div className="flex items-center gap-3">
                <span className="font-mono text-olive text-sm tabular-nums">
                  {totalDone}/{totalTasks}
                </span>
                <div className="flex-1 h-px bg-card relative overflow-hidden rounded-full">
                  <div
                    className="absolute inset-y-0 left-0 bg-olive transition-all duration-500"
                    style={{ width: totalTasks > 0 ? `${(totalDone / totalTasks) * 100}%` : "0%" }}
                  />
                </div>
              </div>
            </div>

            {/* Shift task lists (opening / mid-shift / closing / manager-created) */}
            <div className="space-y-8">
              {scheduledTaskLists.map((taskList) => (
                <TaskListCard
                  key={`${taskList._id}-${selectedDate}`}
                  taskList={taskList}
                  logs={logs}
                  session={sessions[taskList._id]}
                  weekLogs={weekLogsByTask}
                  weekDates={weekDates}
                  isPastDate={isPastDate}
                  selectedDate={selectedDate}
                  today={today}
                  onStateChange={handleStateChange}
                  onStartTimer={handleStartTimer}
                  onStartTaskList={(tl, startIndex) => setActiveSession({ taskList: tl, startIndex })}
                  currentUserId={userId}
                  userRole={userRole}
                />
              ))}
            </div>

            {/* To-dos for the day */}
            <TodoSection
              todos={todos}
              viewingDate={selectedDate}
              onToggle={handleToggleTodo}
              onDelete={handleDeleteTodo}
              onEdit={setEditingTodo}
              onAdd={() => setAddTodoOpen(true)}
            />

            {/* Standalone/anytime tasks section(s) */}
            {(anytimeTaskLists.length > 0) && (
              <div className="mt-10">
                <div className="flex items-center gap-3 mb-4">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-dim">
                    {anytimeTaskLists[0]?.name ?? "Tasks"}
                  </span>
                  <div className="flex-1 h-px bg-border" />
                  <button
                    onClick={() => {
                      const target = anytimeTaskLists[0];
                      if (target) setAddTaskSheetFor({ id: target._id, name: target.name });
                    }}
                    className="font-mono text-[10px] text-olive hover:text-olive-light transition-colors"
                  >
                    + Add
                  </button>
                </div>

                <div className="space-y-8">
                  {anytimeTaskLists.map((taskList) => (
                    <TaskListCard
                      key={`${taskList._id}-${selectedDate}`}
                      taskList={taskList}
                      logs={logs}
                      weekLogs={weekLogsByTask}
                      weekDates={weekDates}
                      isPastDate={isPastDate}
                      selectedDate={selectedDate}
                      today={today}
                      onStateChange={handleStateChange}
                      onStartTimer={handleStartTimer}
                      onStartTaskList={() => {}}
                      userRole={userRole}
                    />
                  ))}
                </div>

                {anytimeTaskLists.every((tl) => tl.tasks.length === 0) && (
                  <button
                    onClick={() => {
                      const target = anytimeTaskLists[0];
                      if (target) setAddTaskSheetFor({ id: target._id, name: target.name });
                    }}
                    className="w-full flex items-center justify-center gap-2 border border-dashed border-border-light text-dim font-body text-sm py-5 rounded-card hover:border-olive/40 hover:text-olive transition-colors min-h-[44px]"
                  >
                    + Add your first task
                  </button>
                )}
              </div>
            )}

            {taskLists.length === 0 && (
              <div className="text-center py-20">
                <p className="text-muted text-sm">No tasks yet.</p>
              </div>
            )}

            {/* Manage Tasks entry point (managers only) — moved down here from
                the top nav so it reads as a deliberate destination rather than
                a small icon competing with the profile avatar. */}
            {isManagerOrAbove(userRole) && (
              <Link
                href="/tasks/manage"
                className="mt-10 w-full flex items-center justify-center gap-2 bg-card border border-border-light text-text font-body text-sm font-medium py-4 rounded-card hover:border-olive/40 hover:text-olive transition-colors min-h-[44px]"
              >
                <Settings size={18} strokeWidth={1.75} />
                Manage
              </Link>
            )}
          </>
      </div>
    </div>
  );
}
