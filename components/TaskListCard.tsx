"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { Play } from "lucide-react";
import AppIcon from "@/components/AppIcon";
import TaskRow, { type RowItem } from "@/components/TaskRow";
import TaskCard from "@/components/TaskCard";
import ShiftLeadPicker from "@/components/ShiftLeadPicker";
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
// getSessionSummariesForDate. status "assigned" means nobody's actually
// started the list yet (a manager just pre-named its shift lead — see
// docs/features/shift-lead-preassignment.md); startedAt/completedAt/
// ownerName are only ever populated once status moves past that.
export interface TaskListSessionSummary {
  status: "assigned" | "in_progress" | "completed";
  startedAt: string | null; // ISO
  completedAt: string | null; // ISO
  ownerName: string | null; // whoever started the session first — see TaskListSession.performedByUserId
  assignedUserId: string | null;
  assignedUserName: string | null; // the pre-assigned shift lead, if any — see TaskListSession.assignedUserId
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
  // Called after a successful shift-lead assign/clear/reassign (see
  // docs/features/shift-lead-preassignment.md) so the caller can
  // re-fetch sessions immediately rather than waiting on TasksView's own
  // poll cycle. Omitted for the anytime-list call site, which never
  // renders the shift-lead row in the first place.
  onSessionsChanged?: () => void;
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
  currentUserId, userRole, onSessionsChanged,
}: Props) {
  const [shiftLeadPickerOpen, setShiftLeadPickerOpen] = useState(false);
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

  // Shift lead — same header-row slot regardless of session status, so a
  // finished list reads the same way an unstarted one does (previously the
  // pre-assignment lived in its own row below the title while a finished
  // list's owner name showed a different way, inline in the "✓ Done" pill —
  // inconsistent depending on state). assignedUserName wins when a manager
  // actually pre-assigned someone; ownerName is the fallback once a session
  // exists but was never pre-assigned (whoever happened to run it).
  // canPreAssign mirrors the write path's own rule (assignShiftLead rejects
  // once a real run exists) — only pre-start is tappable/editable.
  const canPreAssign = !session || session.status === "assigned";
  const leadName = session?.assignedUserName ?? session?.ownerName ?? null;

  // Status row — the list's own "starts/by/done range" state, now a
  // full-width bar below the title instead of a right-aligned badge
  // sharing the title row with the shift-lead slot above.
  const timeLabel = isComplete
    ? session?.startedAt && session?.completedAt
      ? `${fmtClock(session.startedAt)}–${fmtClock(session.completedAt)}`
      : null
    : beforeWindow && taskList.startTime
      ? `starts ${fmtTime(taskList.startTime)}`
      : pastTimeframe
        ? (collapseAfter ? `by ${fmtTime(collapseAfter)}` : "window passed")
        : null;

  return (
    <section>
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2 mb-1 min-h-[44px]">
        <button className="flex-1 min-w-0 text-left" onClick={toggle}>
          <h2 className="font-heading text-lg text-text truncate">{taskList.name}</h2>
        </button>

        {/* Shift lead — same slot regardless of session status, so a
            finished list reads the same way an unstarted one does (this
            used to live in its own row below the title pre-session, while
            a finished list's name showed a different way, inline in the
            "✓ Done" pill — inconsistent depending on state). Not tappable
            once a real session exists — pre-assignment is pre-start only,
            same rule the write path itself enforces. See
            docs/features/shift-lead-preassignment.md. */}
        {!isAnytimeList && !isPastDate && (
          canPreAssign && canManage(userRole) ? (
            <div className="relative shrink-0">
              <button
                onClick={() => setShiftLeadPickerOpen((v) => !v)}
                className="font-mono text-xs whitespace-nowrap"
              >
                <span className="text-muted">Shift lead: </span>
                {leadName ? (
                  <span className="text-text">{leadName}</span>
                ) : (
                  <span className="text-dim">+</span>
                )}
              </button>
              {shiftLeadPickerOpen && (
                <ShiftLeadPicker
                  taskListId={taskList._id}
                  date={selectedDate}
                  currentAssignedUserId={session?.assignedUserId ?? null}
                  onClose={() => setShiftLeadPickerOpen(false)}
                  onChanged={() => {
                    setShiftLeadPickerOpen(false);
                    onSessionsChanged?.();
                  }}
                />
              )}
            </div>
          ) : leadName ? (
            <span className="shrink-0 font-mono text-xs text-muted whitespace-nowrap">
              Shift lead: <span className="text-text">{leadName}</span>
            </span>
          ) : null
        )}
      </div>

      {/* ── Status row — full-width, fills the list's own width (was a
          right-aligned badge sharing the title row with the shift-lead
          slot above, plus a separate doneCount stat beside it — now one
          bar, so it doesn't crowd the title row or the shift-lead slot). */}
      {(timeLabel || !isComplete) && (
        <div
          className={`w-full flex items-center justify-between gap-2 px-3 py-1 mb-3 rounded-pill font-mono text-[10px] ${
            isComplete ? "text-done bg-done/10" : "text-dim border border-border"
          }`}
        >
          <span>{timeLabel}</span>
          {!isComplete && (
            <span>
              <span className="text-gold">{doneCount}/{visibleTasks.length}</span>
              <span className="text-dim"> · {fmtMins(projectedMins)}</span>
            </span>
          )}
        </div>
      )}

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

          {/* "Start Tasks" — an optional guided walkthrough alongside each
              row's own Start/Resume button (see docs/features/task-lists.md's
              "Per-task claiming"); anyone can launch it any time, and it
              skips over a task someone else already claimed rather than
              blocking on it (TaskListSessionView.tsx's own logic). */}
          {visibleTasks.length > 0 && !isComplete && !isPastDate && taskList.timeOfDay !== "anytime" && (() => {
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
        </div>
      )}
    </section>
  );
}
