"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { Play } from "lucide-react";
import AppIcon from "@/components/AppIcon";
import TaskRow, { type RowItem } from "@/components/TaskRow";
import TaskCard from "@/components/TaskCard";
import type { TaskLogEntry } from "@/components/TasksView";
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

// Client-facing shape of a taskList's most recent TaskListSession run for
// the date being viewed — see lib/task-list-session-actions.ts's
// getSessionSummariesForDate. completedAt/ownerName are null when the
// session hasn't closed (or its owner couldn't be resolved) — the "✓ Done"
// pill below falls back to plain text in that case rather than showing a
// half-filled time range.
export interface TaskListSessionSummary {
  startedAt: string; // ISO
  completedAt: string | null; // ISO
  ownerName: string | null; // whoever started the session first — see TaskListSession.performedByUserId
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
  // This list's most recent TaskListSession run for selectedDate, if any —
  // undefined when no one ever opened the guided "Start Tasks" walkthrough
  // for it that day (e.g. every task was completed via its own row's Start
  // button instead). Only ever passed for shift-window lists — anytime
  // lists have no "Start Tasks" flow to anchor a session to.
  session?: TaskListSessionSummary;
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
  // currentUserId drives TaskRow's per-task claim pill (see
  // docs/features/task-lists.md's "Per-task claiming") — optional so the
  // anytime-list call site (TaskCard already has its own claim-free
  // rendering) doesn't need it.
  currentUserId?: string;
  userRole?: "manager" | "employee" | "owner" | "developer";
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

// Same 12-hour/no-leading-zero/lowercase-suffix style as fmtTime above, just
// starting from a full timestamp (a TaskListSession's startedAt/completedAt)
// instead of an "HH:MM" TaskList.startTime string.
function fmtClock(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours();
  const m = d.getMinutes();
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
  taskList, logs, session, weekLogs, weekDates,
  isPastDate = false, selectedDate, today,
  onStateChange, onStartTimer, onStartTaskList,
  currentUserId, userRole,
}: Props) {
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

  // ── Row-box header/footer text (shift-window lists only) ─────────────────
  // See docs/features/task-list-row-box.md — a bordered box wraps just the
  // task row list (the title line and "Start Tasks" button stay outside it)
  // with two fixed strips baked into its own top/bottom edges, so the box's
  // shape never changes across "not started"/"running"/"done" — only the
  // two strips' text does. Session data always wins once a TaskListSession
  // exists for this list/date (persists through and past completion — the
  // footer adds the finish time on top, it doesn't replace this); the
  // scheduled startTime is only a placeholder before anyone's claimed the
  // list. Task count/projected minutes stay in the header strip
  // unconditionally, alongside whichever of those two — a static "how big
  // is this list" fact, deliberately distinct from the title line's own
  // live done-count stat below. Both strips fall back to blank (not a
  // stale/misleading guess) for a list completed without ever opening a
  // session.
  const taskCountLabel = `${visibleTasks.length} task${visibleTasks.length === 1 ? "" : "s"} · ${fmtMins(projectedMins)}`;
  const headerStripText = session
    ? `${fmtClock(session.startedAt)} · ${session.ownerName ?? "someone"} · ${taskCountLabel}`
    : isComplete
    ? null
    : taskList.startTime
    ? `Starts ${fmtTime(taskList.startTime)} · ${taskCountLabel}`
    : taskCountLabel;
  const footerStripText = session?.completedAt ? fmtClock(session.completedAt) : null;

  if (isAnytimeList) {
    // Anytime lists never get a TaskListSession (the guided "Start Tasks"
    // walkthrough that creates one is shift-window-only), so the row-box's
    // session-driven header/footer strips have nothing to show here — keep
    // the simpler bare-title + "✓ Done" pill this always had. See
    // docs/features/task-list-status-box.md's "Scoping" section (unchanged
    // by the row-box follow-up).
    return (
      <section>
        <div className="flex items-center gap-2 mb-3 min-h-[44px]">
          <h2 className="font-heading text-lg text-text">{taskList.name}</h2>
          {isComplete && (
            <span className="font-mono text-[10px] text-done bg-done/10 px-2 py-0.5 rounded-pill">
              ✓ Done
            </span>
          )}
        </div>
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
      </section>
    );
  }

  return (
    <section>
      {/* ── Title line (outside the row-outline) ──────────────────────────── */}
      {/* No live X/Y stat here anymore — it duplicated the header strip's own
          static task-count/minutes below, and docs/features/task-list-row-outline.md
          resolves that redundancy by dropping this copy, not the strip's. */}
      <div className="flex items-center mb-3 min-h-[44px]">
        <button className="flex items-center gap-2 text-left flex-1" onClick={toggle}>
          <h2 className="font-heading text-lg text-text">{taskList.name}</h2>
        </button>
      </div>

      {/* ── Row-outline: header strip + task rows + footer strip ─────────── */}
      {/* See docs/features/task-list-row-outline.md — the outline's own
          stroke stays neutral in every state (an earlier pass tried a
          done-green stroke and walked it back); only the header/footer
          section backgrounds tint gray → light green on completion. No
          padding gutter between the outline and the row list it wraps —
          flush on all sides. TaskRow.tsx's own row height is untouched —
          it's already above CLAUDE.md's 44px tap-target floor, and
          "tighter" here only means this component's own chrome. */}
      <div className="rounded-card border-[3px] border-border overflow-hidden">
        <button
          onClick={toggle}
          className={`w-full text-left px-3 py-1.5 font-mono text-[10px] text-dim min-h-[20px] flex items-center ${isComplete ? "bg-done/10" : "bg-card"}`}
        >
          {headerStripText}
        </button>

        <div className="border-t border-border">
          {effectivelyCollapsed && isComplete && (
            <button
              onClick={toggle}
              className="w-full text-left bg-card px-3 py-2.5 hover:bg-card-hover transition-colors"
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

          {effectivelyCollapsed && !isComplete && (
            <button
              onClick={toggle}
              className="w-full text-left bg-card px-3 py-2.5 flex items-center gap-2 hover:bg-card-hover transition-colors"
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

          {!effectivelyCollapsed && (
            // Flush against the outline on all sides — no padding gutter.
            // No rounded-card here either: this sits between the header/
            // footer strips' dividers, not at the outline's own rounded
            // corners, so its own rounding would just float oddly once
            // there's no gutter left to contain it.
            <div className="bg-card overflow-hidden divide-y divide-border">
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
                  isBackEntry={isBackEntry}
                  currentUserId={currentUserId ?? ""}
                  onStartTimer={() => onStartTimer(task)}
                  onStateChange={(s, opts) => onStateChange(task._id, s, opts)}
                  onToggleExpand={() =>
                    setExpandedTaskId((prev) => (prev === task._id ? null : task._id))
                  }
                  canUndo={canManage(userRole)}
                  onUndo={() => onStateChange(task._id, null)}
                />
              ))}
            </div>
          )}
        </div>

        {/* ── Footer strip ──────────────────────────────────────────────── */}
        <div
          className={`border-t border-border px-3 py-1.5 font-mono text-[10px] text-dim min-h-[20px] flex items-center ${isComplete ? "bg-done/10" : "bg-card"}`}
        >
          {footerStripText}
        </div>
      </div>

      {/* "Start Tasks" — outside the row-box, same as the title line above
          it. An optional guided walkthrough alongside each row's own
          Start/Resume button (see docs/features/task-lists.md's "Per-task
          claiming"); anyone can launch it any time, and it skips over a
          task someone else already claimed rather than blocking on it
          (TaskListSessionView.tsx's own logic). */}
      {!effectivelyCollapsed && visibleTasks.length > 0 && !isComplete && !isPastDate && (() => {
        const hasStarted = visibleTasks.some((t) => !!logs[t._id]);
        // Skip past both a finished task AND one someone ELSE already
        // has claimed — landing "Continue Tasks" directly on a task in
        // progress under a different performedByUserId was the bug:
        // TaskListSessionView's own reactive skip logic only runs
        // AFTER something changes, never validates its very first
        // currentIndex, so the first tap needs to pick a genuinely
        // available task itself. (TaskListSessionView's own
        // resolveInitialIndex re-validates this against live data at
        // mount too, so this is a best-guess landing spot, not the
        // only guard — see docs/features/task-lists.md's "Per-task
        // claiming".) Falls back to 0 if nothing qualifies (every
        // remaining task is done or claimed elsewhere).
        const firstIncompleteIdx = Math.max(
          0,
          visibleTasks.findIndex((t) => {
            const log = logs[t._id];
            if (!log || log.state === "missed") return true;
            if (log.state === "done") return false;
            if (
              (log.state === "in_progress" || log.state === "paused") &&
              log.performedByUserId &&
              log.performedByUserId !== currentUserId
            ) {
              return false;
            }
            return true;
          })
        );
        return (
          <button
            onClick={() => onStartTaskList(taskList, firstIncompleteIdx)}
            className="mt-3 w-full flex items-center justify-center gap-2 bg-olive text-text font-body font-medium py-3.5 rounded-card min-h-[48px] active:opacity-90 transition-opacity"
          >
            <Play size={15} fill="currentColor" />
            {hasStarted ? "Continue Tasks" : "Start Tasks"}
          </button>
        );
      })()}
    </section>
  );
}
