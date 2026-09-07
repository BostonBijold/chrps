"use client";

import { useState } from "react";
import { ClipboardList } from "lucide-react";
import StreakDots from "@/components/StreakDots";
import AppIcon from "@/components/AppIcon";
import TaskInstructionsSheet, { type TaskInstructionStep } from "@/components/TaskInstructionsSheet";
import type { TaskLogEntry } from "@/components/TasksView";
import type { LogState } from "@/models/TaskLog";
import type { FormFieldDef } from "@/models/TaskDefinition";

export interface RowItem {
  _id: string;
  name: string;
  icon: string;
  projectedMinutes: number;
  order: number;
  taskType?: "standard" | "stopwatch" | "checkbox" | "form";
  scheduledDays: number[];   // 0=Sun..6=Sat — which days this item is expected
  successThreshold: number;  // how many of this week's scheduled days = 100%
  formFields?: FormFieldDef[]; // only meaningful when taskType === "form"
  nfcTagUid?: string | null; // bound physical tag's UID — see docs/features/nfc.md
  // Manager-authored "what this should look like when done" steps — see
  // docs/features/task-completion-instructions.md (authoring) and
  // docs/features/task-instructions-employee-view.md (this read-only
  // view). Undefined/empty = no Instructions button renders at all.
  instructionSteps?: TaskInstructionStep[];
  // Gates whether an employee must attach a completion photo before this
  // task can be marked done — see docs/features/task-completion-photo.md.
  requiresPhoto?: boolean;
}

interface Props {
  item: RowItem;
  log?: TaskLogEntry;
  weekLogs: Array<{ date: string; state: LogState; actualMinutes: number | null }>;
  weekDates: string[]; // Sunday→Saturday, fixed calendar week
  isExpanded: boolean;
  selectedDate: string;
  today: string; // YYYY-MM-DD — marks today's dot and what counts as "future" in StreakDots
  onToggleExpand: () => void;
  // Manager-only escape hatch — a shift-list row otherwise has no actions
  // at all (see the note above), but a mistake still needs to be
  // correctable. Same manager-only gating as TaskCard.tsx's Undo — see
  // docs/features/task-lists.md's "Manager-only Undo" section.
  canUndo: boolean;
  onUndo: () => void;
}

function fmtMins(mins: number) {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// Exported so other views can render a log's state with the same
// color/label convention instead of redefining it — see
// components/reports/LogsTab.tsx.
export const BORDER: Record<LogState, string> = {
  in_progress: "border-l-[3px] border-l-amber",
  paused:      "border-l-[3px] border-l-amber",
  done:        "border-l-[3px] border-l-done",
  missed:      "border-l-[3px] border-l-burgundy",
  rest:        "border-l-[3px] border-l-blue-muted",
};

export const BADGE: Record<LogState, string> = {
  in_progress: "text-amber bg-amber/10",
  paused:      "text-amber bg-amber/10",
  done:        "text-done bg-done/10",
  missed:      "text-burgundy-light bg-burgundy/10",
  rest:        "text-blue-muted bg-blue-muted/10",
};

export const LABEL: Record<LogState, string> = {
  in_progress: "Active",
  paused:      "Paused",
  done:        "Done",
  missed:      "Missed",
  rest:        "Rest",
};

// Every task list this row can ever be used for has a startTime (see
// TaskListCard, which only renders TaskRow for its non-"anytime" branch) —
// a shift-window list, whose tasks can only move forward through that
// list's own "Start Tasks"/"Continue Tasks" session, never tapped and
// changed here directly. So this row is tap-to-expand-and-view only: no
// Start/Missed/Rest/Edit-time actions, just the task's current state and
// (for a form task) whatever readings were captured when it was completed
// through the session. The one exception is Undo, which stays available
// but manager-only (canUndo) — the escape hatch for a logged mistake, same
// gating as TaskCard.tsx's Undo. See docs/features/task-lists.md's "Task
// list locking" and "Manager-only Undo" sections.
export default function TaskRow({
  item, log, weekLogs, weekDates,
  isExpanded, selectedDate, today,
  onToggleExpand, canUndo, onUndo,
}: Props) {
  const state = log?.state ?? null;
  const isCheckbox = item.taskType === "checkbox";
  const isStopwatch = item.taskType === "stopwatch";
  const isForm = item.taskType === "form";
  const formFields = item.formFields ?? [];
  const [showInstructions, setShowInstructions] = useState(false);
  const instructionSteps = item.instructionSteps ?? [];

  const variance =
    !isCheckbox && !isStopwatch && state === "done" && log?.actualMinutes != null
      ? log.actualMinutes - item.projectedMinutes
      : null;

  return (
    <div className={state ? BORDER[state] : ""}>
      {/* Tap row — a div playing the role of a button (not a real <button>)
          so the "Instructions" control below can be a genuine nested
          <button> without violating HTML's no-nested-buttons rule. */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggleExpand}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggleExpand();
          }
        }}
        className={`w-full flex items-center gap-3 px-4 py-3.5 text-left min-h-[54px] transition-colors cursor-pointer ${
          isExpanded ? "bg-card-hover" : ""
        }`}
      >
        <div className="w-7 flex items-center justify-center flex-shrink-0">
          <AppIcon name={item.icon} size={18} className="text-muted" />
        </div>

        <div className="flex-1 min-w-0">
          <p
            className={`font-body text-sm leading-tight ${
              state === "done"
                ? "text-dim line-through"
                : state === "missed"
                ? "text-dim"
                : "text-text"
            }`}
          >
            {item.name}
          </p>
          {instructionSteps.length > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowInstructions(true);
              }}
              className="mt-1.5 inline-flex items-center gap-1 font-mono text-[10px] text-olive border border-olive/30 bg-olive/10 px-2 py-1 rounded-pill"
            >
              <ClipboardList size={11} strokeWidth={1.75} />
              Instructions
            </button>
          )}
          <div className="mt-1.5">
            <StreakDots
              logs={weekLogs}
              dates={weekDates}
              today={today}
              viewingDate={selectedDate}
              scheduledDays={item.scheduledDays}
              successThreshold={item.successThreshold}
              targetMinutes={!isCheckbox && !isStopwatch ? item.projectedMinutes : null}
            />
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          {state ? (
            <>
              {variance !== null && (
                <span
                  className={`font-mono text-xs ${
                    variance > 0 ? "text-tobacco" : "text-olive-light"
                  }`}
                >
                  {variance > 0 ? `+${variance}m` : `${variance}m`}
                </span>
              )}
              <span className={`font-mono text-xs px-2 py-0.5 rounded-pill ${BADGE[state]}`}>
                {LABEL[state]}
              </span>
            </>
          ) : isCheckbox ? (
            <span className="font-mono text-dim text-xs">✓</span>
          ) : isStopwatch ? (
            <span className="font-mono text-dim text-xs">⏱</span>
          ) : (
            <span className="font-mono text-dim text-xs">{fmtMins(item.projectedMinutes)}</span>
          )}
          <span className="text-dim text-[10px] ml-1">{isExpanded ? "▾" : "▸"}</span>
        </div>
      </div>

      {showInstructions && (
        <TaskInstructionsSheet
          taskName={item.name}
          taskIcon={item.icon}
          steps={instructionSteps}
          onClose={() => setShowInstructions(false)}
        />
      )}

      {/* View-only detail panel — no actions, see the note above */}
      {isExpanded && (
        <div className="px-4 pb-4">
          {!state ? (
            <p className="font-mono text-[11px] text-dim">
              Not started yet — use Start Tasks / Continue Tasks below.
            </p>
          ) : isForm && log?.formData && formFields.length > 0 ? (
            <div className="space-y-1.5">
              {formFields.map((f) => {
                const v = log.formData?.[f.key];
                let display: string;
                if (v === undefined) {
                  display = "—";
                } else if (f.type === "checklist") {
                  const items = f.items && f.items.length > 0 ? f.items : [f.label];
                  const checked = v as Record<string, boolean>;
                  const checkedCount = items.filter((label) => checked?.[label] === true).length;
                  display = items.length === 1 ? "✓ Done" : `${checkedCount}/${items.length} checked`;
                } else if (typeof v === "boolean") {
                  display = v ? "Yes" : "No";
                } else if (f.type === "temperature") {
                  display = `${v}°${f.unit === "C" ? "C" : "F"}`;
                } else {
                  display = String(v);
                }
                const outOfRange =
                  f.type === "temperature" &&
                  typeof v === "number" &&
                  ((f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max));
                return (
                  <div key={f.key} className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[10px] text-dim uppercase tracking-widest">
                      {f.label}{f.type === "number" && f.unit ? ` (${f.unit})` : ""}
                    </span>
                    <span className={`font-mono text-xs ${outOfRange ? "text-burgundy-light" : "text-text"}`}>{display}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="font-mono text-[11px] text-dim">
              {LABEL[state]}
              {log?.actualMinutes != null ? ` · ${fmtMins(log.actualMinutes)}` : ""}
            </p>
          )}

          {state && canUndo && (
            <button
              onClick={onUndo}
              className="mt-2 font-mono text-[9px] text-dim uppercase tracking-widest"
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}
