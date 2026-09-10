"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { Play, Unlock } from "lucide-react";
import AppIcon from "@/components/AppIcon";
import TaskRow, { type RowItem } from "@/components/TaskRow";
import TaskCard from "@/components/TaskCard";
import type { TaskLogEntry, SessionLockInfo } from "@/components/TasksView";
import type { LogState } from "@/models/TaskLog";
import { isTaskVisibleOn } from "@/lib/task-visibility";
import {
  deriveCollapseAfter,
  isPastWindow as isPastWindowAt,
  isBeforeWindow as isBeforeWindowAt,
} from "@/lib/task-list-window";
import { isManagerOrAbove } from "@/lib/roles";

// userRole is optional here (see the Task List Locking note below), so
// every call site guards the undefined case before deferring to the shared
// role-tier check.
function canManage(userRole: "manager" | "employee" | "owner" | "developer" | undefined) {
  return !!userRole && isManagerOrAbove(userRole);
}

export interface TaskListCardTaskList {
  _id: string;
  name: string;
  timeOfDay: "morning" | "evening" | "custom" | "anytime";
  startTime: string | null;
  order: number;
  tasks: RowItem[];
}

interface Props {
  taskList: TaskListCardTaskList;
  logs: Record<string, TaskLogEntry>;
  weekLogs: Record<string, Array<{ date: string; state: LogState; actualMinutes: number | null }>>;
  weekDates: string[]; // Sunday→Saturday, fixed calendar week (see lib/week-dates.ts)
  isPastDate?: boolean;
  selectedDate: string;
  today: string; // YYYY-MM-DD — marks today's dot and what counts as "future" in StreakDots
  onStateChange: (
    taskId: string,
    state: LogState | null,
    opts?: { actualMinutes?: number; isBackEntry?: boolean; startedAt?: string; completedAt?: string }
  ) => void;
  onStartTimer: (task: RowItem) => void;
  onStartTaskList: (taskList: TaskListCardTaskList, startIndex: number) => void;
  // Task List Locking — see docs/features/task-lists.md. All optional so the
  // anytime-list call site (no session concept there) doesn't need them.
  currentUserId?: string;
  userRole?: "manager" | "employee" | "owner" | "developer";
  sessionLock?: SessionLockInfo | null; // who currently holds this list's open session, if anyone
  onUnlockSession?: () => void; // manager-only — clears the lock so someone else can pick it up
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function minutesNow(): number {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

// deriveCollapseAfter/isPastWindow/isBeforeWindow themselves live in
// lib/task-list-window.ts, shared with the server-side missed-list alert
// sweep (see docs/features/notifications.md) — these two wrappers just
// supply the browser's own "now," matching this file's previous signature.
function isPastWindow(collapseAfter: string | null): boolean {
  return isPastWindowAt(minutesNow(), collapseAfter);
}

function isBeforeWindow(startTime: string | null): boolean {
  return isBeforeWindowAt(minutesNow(), startTime);
}

function isInWindow(startTime: string | null, collapseAfter: string | null): boolean {
  return !isBeforeWindow(startTime) && !isPastWindow(collapseAfter);
}

function fmtTime(t: string): string {
  const [h, m] = t.split(":").map(Number);
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, "0")}${suffix}` : `${h12}${suffix}`;
}

function fmtMins(mins: number) {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

const STATE_COLOR: Record<LogState, string> = {
  in_progress: "text-amber",
  paused:      "text-amber",
  done:        "text-done",
  missed:      "text-burgundy-light",
  rest:        "text-blue-muted",
};
const STATE_SYMBOL: Record<LogState, string> = {
  in_progress: "▶",
  paused:      "❚❚",
  done:        "✓",
  missed:      "✗",
  rest:        "~",
};

// ── Main component ────────────────────────────────────────────────────────────

export default function TaskListCard({
  taskList, logs, weekLogs, weekDates,
  isPastDate = false, selectedDate, today,
  onStateChange, onStartTimer, onStartTaskList,
  currentUserId, userRole, sessionLock = null, onUnlockSession,
}: Props) {
  const [confirmingUnlock, setConfirmingUnlock] = useState(false);
  // Derive end time once we know what tasks are in this list
  const timedTasksAll = taskList.tasks.filter((t) => t.taskType !== "checkbox");
  const totalProjectedMins = timedTasksAll.reduce((s, t) => s + t.projectedMinutes, 0);
  const collapseAfter = deriveCollapseAfter(taskList.startTime, totalProjectedMins);

  const beforeWindow = useMemo(
    () => !isPastDate && isBeforeWindow(taskList.startTime),
    [taskList.startTime, isPastDate]
  );
  const pastTimeframe = useMemo(
    () => !isPastDate && isPastWindow(collapseAfter),
    [collapseAfter, isPastDate]
  );
  const inWindow = useMemo(
    () => !isPastDate && isInWindow(taskList.startTime, collapseAfter),
    [taskList.startTime, collapseAfter, isPastDate]
  );

  const visibleTasks = useMemo(
    () => taskList.tasks.filter((t) => isTaskVisibleOn(t, selectedDate)),
    [taskList.tasks, selectedDate]
  );

  // in_progress doesn't count as complete — the task is actively being timed
  const isComplete = visibleTasks.length > 0 && visibleTasks.every((t) => {
    const s = logs[t._id]?.state;
    return s === "done" || s === "missed" || s === "rest";
  });

  // Past dates: always start expanded so history is visible
  // Today: expand while inside the time window, collapse before it opens or after it closes
  const [isCollapsed, setIsCollapsed] = useState(() => {
    if (isPastDate) return false;
    if (isComplete) return true;
    if (inWindow || beforeWindow) return false; // active or upcoming → start open
    return true; // past window → start collapsed
  });
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);

  // Snap to complete summary only on today's view
  useEffect(() => {
    if (isComplete && !isPastDate) {
      const t = setTimeout(() => {
        setIsCollapsed(true);
        setExpandedTaskId(null);
      }, 600);
      return () => clearTimeout(t);
    }
  }, [isComplete, isPastDate]);

  // Undoing the last completed task in a list flips isComplete back to
  // false — re-expand out of the collapsed summary strip so the now-pending
  // task is visible again, mirroring the collapse effect above.
  const wasComplete = useRef(isComplete);
  useEffect(() => {
    if (wasComplete.current && !isComplete && !isPastDate) {
      setIsCollapsed(false);
    }
    wasComplete.current = isComplete;
  }, [isComplete, isPastDate]);

  const doneCount = visibleTasks.filter((t) => logs[t._id]?.state === "done").length;
  const timedTasks = visibleTasks.filter((t) => t.taskType !== "checkbox");
  const projectedMins = timedTasks.reduce((s, t) => s + t.projectedMinutes, 0);
  const actualMins = timedTasks.reduce((s, t) => s + (logs[t._id]?.actualMinutes ?? 0), 0);
  const variance = actualMins - projectedMins;
  const actualColor =
    variance > 5 ? "text-tobacco" : variance < -5 ? "text-olive-light" : "text-muted";

  const isAnytimeList = taskList.timeOfDay === "anytime";
  // Anytime lists never collapse — each card shows its own state directly
  const effectivelyCollapsed = isCollapsed && !isAnytimeList;
  const toggle = () => { if (!isAnytimeList) setIsCollapsed((c) => !c); setExpandedTaskId(null); };

  // Back-entry UX (Done + minutes input instead of timer) applies when:
  // - it's a different calendar day, OR
  // - it's today but the scheduled timeframe has passed
  const isBackEntry = isPastDate || pastTimeframe;

  return (
    <section>
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-3 min-h-[44px]">
        <button className="flex items-center gap-2 text-left flex-1" onClick={toggle}>
          <h2 className="font-heading text-lg text-text">{taskList.name}</h2>
          {isComplete && !isPastDate ? (
            <span className="font-mono text-[10px] text-done bg-done/10 px-2 py-0.5 rounded-pill">
              ✓ Done
            </span>
          ) : beforeWindow && taskList.startTime ? (
            <span className="font-mono text-[10px] text-dim px-2 py-0.5 rounded-pill border border-border">
              starts {fmtTime(taskList.startTime)}
            </span>
          ) : pastTimeframe && !isComplete ? (
            <span className="font-mono text-[10px] text-dim px-2 py-0.5 rounded-pill border border-border">
              {collapseAfter ? `by ${fmtTime(collapseAfter)}` : "window passed"}
            </span>
          ) : null}
        </button>

        {!isComplete && (
          <span className="font-mono text-xs">
            <span className="text-gold">{doneCount}/{visibleTasks.length}</span>
            <span className="text-dim"> · {fmtMins(projectedMins)}</span>
          </span>
        )}
      </div>

      {/* ── Collapsed: complete summary ──────────────────────────────────── */}
      {effectivelyCollapsed && isComplete && (
        <button
          onClick={toggle}
          className="w-full text-left bg-card rounded-card border-l-[3px] border-done px-4 py-3.5 hover:bg-card-hover transition-colors"
        >
          {projectedMins > 0 && (
            <div className="flex items-center gap-3 mb-3">
              <span className="font-mono text-xs text-dim">
                {fmtMins(projectedMins)} projected
              </span>
              <span className="font-mono text-dim text-xs">→</span>
              <span className={`font-mono text-xs font-medium ${actualColor}`}>
                {fmtMins(actualMins)} actual
              </span>
              {variance !== 0 && actualMins > 0 && (
                <span className={`font-mono text-[10px] ${actualColor} ml-auto`}>
                  {variance > 0 ? `+${fmtMins(variance)}` : `-${fmtMins(Math.abs(variance))}`}
                </span>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-x-3 gap-y-2">
            {visibleTasks.map((task) => {
              const log = logs[task._id];
              return (
                <span key={task._id} className="flex items-center gap-1">
                  <AppIcon
                    name={task.icon}
                    size={14}
                    strokeWidth={1.75}
                    className={log ? STATE_COLOR[log.state] : "text-dim"}
                  />
                  <span
                    className={`font-mono text-[10px] leading-none font-semibold ${
                      log ? STATE_COLOR[log.state] : "text-dim"
                    }`}
                  >
                    {log ? STATE_SYMBOL[log.state] : "·"}
                  </span>
                </span>
              );
            })}
          </div>
        </button>
      )}

      {/* ── Collapsed: incomplete icon summary (today, timeframe elapsed) ── */}
      {effectivelyCollapsed && !isComplete && (
        <button
          onClick={toggle}
          className="w-full text-left bg-card rounded-card px-4 py-3.5 flex items-center gap-2 hover:bg-card-hover transition-colors"
        >
          <div className="flex flex-wrap gap-x-3 gap-y-2 flex-1">
            {visibleTasks.map((task) => {
              const log = logs[task._id];
              return (
                <span key={task._id} className="flex items-center gap-1">
                  <AppIcon
                    name={task.icon}
                    size={14}
                    strokeWidth={1.75}
                    className={log ? STATE_COLOR[log.state] : "text-dim opacity-40"}
                  />
                  {log && (
                    <span className={`font-mono text-[10px] leading-none font-semibold ${STATE_COLOR[log.state]}`}>
                      {STATE_SYMBOL[log.state]}
                    </span>
                  )}
                </span>
              );
            })}
          </div>
          {beforeWindow && taskList.startTime ? (
            <span className="ml-auto font-mono text-dim text-xs flex-shrink-0">
              starts {fmtTime(taskList.startTime)}
            </span>
          ) : collapseAfter ? (
            <span className="ml-auto font-mono text-dim text-xs flex-shrink-0">
              by {fmtTime(collapseAfter)}
            </span>
          ) : null}
        </button>
      )}

      {/* ── Expanded ────────────────────────────────────────────────────── */}
      {!effectivelyCollapsed && (
        <div>
          {taskList.timeOfDay === "anytime" ? (
            <div className="space-y-2">
              {visibleTasks.map((task) => (
                <TaskCard
                  key={task._id}
                  item={task}
                  log={logs[task._id]}
                  weekLogs={weekLogs[task._id] ?? []}
                  weekDates={weekDates}
                  today={today}
                  selectedDate={selectedDate}
                  isBackEntry={isBackEntry}
                  onStartTimer={() => onStartTimer(task)}
                  onStateChange={(s, opts) => onStateChange(task._id, s, opts)}
                  canUndo={canManage(userRole)}
                />
              ))}
            </div>
          ) : (
            <div className="bg-card rounded-card overflow-hidden divide-y divide-border">
              {visibleTasks.map((task) => (
                <TaskRow
                  key={task._id}
                  item={task}
                  log={logs[task._id]}
                  weekLogs={weekLogs[task._id] ?? []}
                  weekDates={weekDates}
                  today={today}
                  isExpanded={expandedTaskId === task._id}
                  selectedDate={selectedDate}
                  onToggleExpand={() =>
                    setExpandedTaskId((prev) => (prev === task._id ? null : task._id))
                  }
                  canUndo={canManage(userRole)}
                  onUndo={() => onStateChange(task._id, null)}
                />
              ))}
            </div>
          )}

          {/* "Start Tasks", three states — see the "Task List Locking" design
              in docs/features/task-lists.md: no open session (or it's your
              own) → the normal tappable button; someone else's open session
              → "In progress by <name>", not tappable; a manager viewing
              someone else's open session also gets the unlock icon. */}
          {visibleTasks.length > 0 && !isComplete && !isPastDate && taskList.timeOfDay !== "anytime" && (() => {
            const hasStarted = visibleTasks.some((t) => !!logs[t._id]);
            const firstIncompleteIdx = Math.max(0, visibleTasks.findIndex((t) => logs[t._id]?.state !== "done"));
            const lockedByOther = !!sessionLock && sessionLock.performedByUserId !== currentUserId;

            if (!lockedByOther) {
              return (
                <button
                  onClick={() => onStartTaskList(taskList, firstIncompleteIdx)}
                  className="mt-3 w-full flex items-center justify-center gap-2 bg-olive text-text font-body font-medium py-3.5 rounded-card min-h-[48px] active:opacity-90 transition-opacity"
                >
                  <Play size={15} fill="currentColor" />
                  {hasStarted ? "Continue Tasks" : "Start Tasks"}
                </button>
              );
            }

            if (confirmingUnlock) {
              return (
                <div className="mt-3 bg-card border border-border-light rounded-card p-3 space-y-2">
                  <p className="font-mono text-xs text-dim">
                    Remove {sessionLock!.performedByName} from this task list so someone else can continue?
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setConfirmingUnlock(false)}
                      className="flex-1 border border-border-light text-dim py-2.5 rounded-card text-sm font-body min-h-[40px]"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => { onUnlockSession?.(); setConfirmingUnlock(false); }}
                      className="flex-1 border border-burgundy/40 text-burgundy-light py-2.5 rounded-card text-sm font-body min-h-[40px]"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              );
            }

            return (
              <div className="mt-3 flex items-center gap-2">
                <div className="flex-1 flex items-center justify-center gap-2 bg-card-hover border border-border-light text-dim font-body text-sm py-3.5 rounded-card min-h-[48px]">
                  In progress by {sessionLock!.performedByName}
                </div>
                {canManage(userRole) && (
                  <button
                    onClick={() => setConfirmingUnlock(true)}
                    aria-label={`Remove ${sessionLock!.performedByName} from this task list`}
                    className="flex-shrink-0 w-12 h-12 flex items-center justify-center border border-border-light rounded-card text-dim hover:text-olive hover:border-olive/40 transition-colors"
                  >
                    <Unlock size={16} strokeWidth={1.75} />
                  </button>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </section>
  );
}
