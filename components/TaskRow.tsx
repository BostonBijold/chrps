"use client";

import { useState, useEffect } from "react";
import { ClipboardList, Image as ImageIcon } from "lucide-react";
import StreakDots from "@/components/StreakDots";
import AppIcon from "@/components/AppIcon";
import TaskInstructionsSheet, { type TaskInstructionStep } from "@/components/TaskInstructionsSheet";
import TaskPhotoViewSheet from "@/components/TaskPhotoViewSheet";
import TaskPhotoCaptureButton from "@/components/TaskPhotoCaptureButton";
import type { TaskLogEntry } from "@/components/TasksView";
import type { LogState } from "@/models/TaskLog";
import type { FormFieldDef, FormFieldValue } from "@/models/TaskDefinition";

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
  // Manager-only escape hatch — see docs/features/task-lists.md's
  // "Manager-only Undo" section. Same gating as TaskCard.tsx's Undo.
  canUndo: boolean;
  onUndo: () => void;
  // Per-task claiming (see docs/features/task-lists.md's "Per-task
  // claiming on shift lists") — a shift-list row now works exactly like
  // TaskCard's anytime row: any teammate can claim any pending task
  // independently, instead of the whole list being held by one session.
  isBackEntry: boolean;
  currentUserId: string;
  onStartTimer: () => void;
  onStateChange: (
    state: LogState | null,
    opts?: { actualMinutes?: number; isBackEntry?: boolean; formData?: Record<string, FormFieldValue>; photoUrl?: string | null }
  ) => void;
}

function fmtMins(mins: number) {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// "m:ss" — same convention as BottomNav.tsx's own active-timer clock, used
// here for the claim pill's live elapsed time.
function fmtClock(totalSeconds: number) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
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

// A shift-window task now claims and completes exactly like an anytime task
// (TaskCard.tsx) — any teammate can tap Start on any pending row
// independently, instead of the whole list being held by one person's
// "Start Tasks" session. The one thing that stays list-shaped is claim
// VISIBILITY: the moment someone starts a timer, every other viewer of this
// row sees a pill with their name and a live elapsed clock in place of the
// usual minutes badge, and can't start it themselves until it's released
// (done/missed) — see docs/features/task-lists.md's "Per-task claiming."
// `done`/`missed` stay exactly as before (Undo only) — there's no "Edit
// time"/retry action actually built anywhere in the app to reuse yet.
export default function TaskRow({
  item, log, weekLogs, weekDates,
  isExpanded, selectedDate, today,
  onToggleExpand, canUndo, onUndo,
  isBackEntry, currentUserId, onStartTimer, onStateChange,
}: Props) {
  const state = log?.state ?? null;
  const isCheckbox = item.taskType === "checkbox";
  const isStopwatch = item.taskType === "stopwatch";
  const isForm = item.taskType === "form";
  const formFields = item.formFields ?? [];
  const [showInstructions, setShowInstructions] = useState(false);
  const instructionSteps = item.instructionSteps ?? [];
  const [showPhoto, setShowPhoto] = useState(false);
  const nfcBound = !!item.nfcTagUid;
  const hasDuration = item.projectedMinutes > 0;

  const isClaimed = state === "in_progress" || state === "paused";
  const isMine = isClaimed && log?.performedByUserId === currentUserId;
  const claimedByOther = isClaimed && !isMine;
  const claimName = log?.performedByName ?? "Someone";

  // Live elapsed clock for the claim pill — only ticks while genuinely
  // running; a paused claim shows its frozen banked time (pausedSeconds),
  // same "no live tick while paused" convention TaskListSessionView uses.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (state !== "in_progress") return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [state]);
  const claimSeconds = isClaimed
    ? (log?.pausedSeconds ?? 0) +
      (state === "in_progress" && log?.startedAt
        ? Math.max(0, Math.floor((nowTick - new Date(log.startedAt).getTime()) / 1000))
        : 0)
    : 0;

  const variance =
    !isCheckbox && !isStopwatch && state === "done" && log?.actualMinutes != null
      ? log.actualMinutes - item.projectedMinutes
      : null;

  // ── Back-entry field capture for a form task's retroactive Done — same
  // pattern as TaskCard.tsx's own back-entry fields. ──
  const [backMins, setBackMins] = useState(isStopwatch ? "30" : String(item.projectedMinutes || 15));
  const [showSkips, setShowSkips] = useState(false);
  const requiresPhoto = !!item.requiresPhoto;
  const [backPhotoUrl, setBackPhotoUrl] = useState<string | null>(null);
  const backPhotoCapture = requiresPhoto && (
    <TaskPhotoCaptureButton taskId={item._id} photoUrl={backPhotoUrl} onChange={setBackPhotoUrl} />
  );
  const [backFormValues, setBackFormValues] = useState<Record<string, FormFieldValue>>({});
  const backFormComplete =
    !isForm || formFields.every((f) => {
      const v = backFormValues[f.key];
      if (f.type === "boolean") return v !== undefined;
      if (f.type === "checklist") {
        const items = f.items && f.items.length > 0 ? f.items : [f.label];
        const checked = (v as Record<string, boolean> | undefined) ?? {};
        return items.every((label) => checked[label] === true);
      }
      return v !== undefined && v !== "";
    });

  function setBackField(key: string, value: FormFieldValue) {
    setBackFormValues((v) => ({ ...v, [key]: value }));
  }

  const skipToggle = (
    !showSkips ? (
      <button
        onClick={() => setShowSkips(true)}
        className="font-mono text-[9px] text-dim uppercase tracking-widest"
      >
        Skip…
      </button>
    ) : (
      <div className="flex gap-2">
        <button
          onClick={() => { onStateChange("missed", { isBackEntry }); setShowSkips(false); }}
          className="flex-1 border border-burgundy/30 text-burgundy-light font-body text-xs py-2 rounded-card min-h-[36px]"
        >
          ✗ Missed
        </button>
        <button
          onClick={() => setShowSkips(false)}
          className="px-3 text-dim font-mono text-[10px] min-h-[36px]"
        >
          ✕
        </button>
      </div>
    )
  );

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
          {/* Who completed/missed it — visible to every teammate, not just
              managers, see docs/features/task-lists.md's "Per-task claiming". */}
          {(state === "done" || state === "missed") && log?.performedByName && (
            <p className="font-mono text-[10px] text-dim">
              {LABEL[state]} by {log.performedByName}
            </p>
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
          {isClaimed ? (
            // Claimed — visible to every viewer, not just the claimant (see
            // docs/features/task-lists.md's "Per-task claiming"). Replaces
            // the plain minutes badge in the same position; row height is
            // unaffected either way.
            <span className={`font-mono text-xs px-2 py-0.5 rounded-pill ${BADGE[state as "in_progress" | "paused"]}`}>
              {state === "paused" ? "❚❚" : "▶"} {claimName} · {fmtClock(claimSeconds)}
            </span>
          ) : state ? (
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

      {showPhoto && log?.photoUrl && (
        <TaskPhotoViewSheet
          taskName={item.name}
          taskIcon={item.icon}
          photoUrl={log.photoUrl}
          onClose={() => setShowPhoto(false)}
        />
      )}

      {isExpanded && (
        <div className="px-4 pb-4 space-y-2.5">
          {(instructionSteps.length > 0 || (canUndo && log?.photoUrl)) && (
          <div className="flex flex-wrap gap-2">
            {instructionSteps.length > 0 && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowInstructions(true);
                }}
                className="inline-flex items-center gap-1 font-mono text-[10px] text-olive border border-olive/30 bg-olive/10 px-2 py-1 rounded-pill"
              >
                <ClipboardList size={11} strokeWidth={1.75} />
                Instructions
              </button>
            )}
            {/* Manager-facing review surface for the employee-captured
                completion photo — same canUndo gating as the Undo button
                below, see docs/features/task-completion-photo.md. */}
            {canUndo && log?.photoUrl && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowPhoto(true);
                }}
                className="inline-flex items-center gap-1 font-mono text-[10px] text-olive border border-olive/30 bg-olive/10 px-2 py-1 rounded-pill"
              >
                <ImageIcon size={11} strokeWidth={1.75} />
                View Image
              </button>
            )}
          </div>
          )}

          {/* ── Pending — Start/Missed, same actions TaskCard.tsx offers an
              anytime task ── */}
          {!state && (
            <div className="space-y-2.5">
              {isCheckbox ? (
                <button
                  onClick={() => onStateChange("done", { isBackEntry })}
                  disabled={nfcBound}
                  className="w-full flex items-center justify-center gap-1.5 bg-olive/10 border border-olive/30 text-olive font-mono text-xs px-3 py-2 rounded-card min-h-[40px] hover:bg-olive/20 transition-colors disabled:opacity-40"
                >
                  {nfcBound ? "Requires scanning the linked NFC tag" : "✓ Mark Done"}
                </button>
              ) : !isBackEntry ? (
                <button
                  onClick={onStartTimer}
                  className="w-full flex items-center justify-center gap-1.5 bg-olive/10 border border-olive/30 text-olive font-mono text-xs px-3 py-2 rounded-card min-h-[40px] hover:bg-olive/20 transition-colors"
                >
                  <span>▶</span>
                  <span>{isStopwatch ? "Start Task" : hasDuration ? `Start Task · ${fmtMins(item.projectedMinutes)}` : "Start Task"}</span>
                </button>
              ) : !isForm ? (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() =>
                      onStateChange("done", {
                        actualMinutes: Math.max(1, parseInt(backMins) || item.projectedMinutes || 1),
                        isBackEntry: true,
                        photoUrl: backPhotoUrl,
                      })
                    }
                    disabled={nfcBound || (requiresPhoto && !backPhotoUrl)}
                    className="flex-1 flex items-center justify-center gap-1.5 bg-olive/10 border border-olive/30 text-olive font-mono text-xs px-3 py-2 rounded-card min-h-[40px] hover:bg-olive/20 transition-colors disabled:opacity-40"
                  >
                    {nfcBound ? "Scan NFC to complete" : "✓ Done"}
                  </button>
                  {hasDuration && (
                    <div className="flex items-center gap-0.5 border border-border rounded-card px-2 py-2 min-h-[40px] flex-shrink-0">
                      <input
                        type="number"
                        min={1}
                        value={backMins}
                        onChange={(e) => setBackMins(e.target.value)}
                        className="w-8 bg-transparent font-mono text-xs text-text outline-none text-right"
                      />
                      <span className="font-mono text-dim text-[10px]">m</span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  {formFields.map((f) => {
                    if (f.type === "checklist") {
                      const items = f.items && f.items.length > 0 ? f.items : [f.label];
                      const isSingle = items.length === 1;
                      const checked = (backFormValues[f.key] as Record<string, boolean> | undefined) ?? {};
                      const toggleItem = (label: string) => setBackField(f.key, { ...checked, [label]: !checked[label] });
                      return (
                        <div key={f.key} className="space-y-1">
                          {!isSingle && (
                            <span className="font-mono text-[10px] text-dim uppercase tracking-widest">{f.label}</span>
                          )}
                          {items.map((label) => {
                            const isChecked = checked[label] === true;
                            return (
                              <button
                                key={label}
                                type="button"
                                onClick={() => toggleItem(label)}
                                className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-card border font-mono text-xs ${
                                  isChecked ? "bg-olive/10 border-olive text-text" : "border-border-light text-muted"
                                }`}
                              >
                                <span
                                  className={`flex-shrink-0 w-4 h-4 rounded border flex items-center justify-center ${
                                    isChecked ? "bg-olive border-olive" : "border-border-light"
                                  }`}
                                >
                                  {isChecked && <span className="text-bg text-[9px] leading-none">✓</span>}
                                </span>
                                <span className="flex-1 text-left">{isSingle ? f.label : label}</span>
                              </button>
                            );
                          })}
                        </div>
                      );
                    }
                    const backVal = backFormValues[f.key];
                    const backOutOfRange =
                      f.type === "temperature" &&
                      typeof backVal === "number" &&
                      ((f.min !== undefined && backVal < f.min) || (f.max !== undefined && backVal > f.max));
                    return (
                      <div key={f.key} className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[10px] text-dim uppercase tracking-widest">
                          {f.label}{f.type === "number" && f.unit ? ` (${f.unit})` : ""}
                        </span>
                        {f.type === "boolean" ? (
                          <div className="flex gap-1 flex-shrink-0">
                            <button
                              type="button"
                              onClick={() => setBackField(f.key, true)}
                              className={`px-3 py-1.5 rounded-card border font-mono text-xs ${
                                backFormValues[f.key] === true ? "bg-olive/10 border-olive text-text" : "border-border-light text-muted"
                              }`}
                            >
                              Yes
                            </button>
                            <button
                              type="button"
                              onClick={() => setBackField(f.key, false)}
                              className={`px-3 py-1.5 rounded-card border font-mono text-xs ${
                                backFormValues[f.key] === false ? "bg-olive/10 border-olive text-text" : "border-border-light text-muted"
                              }`}
                            >
                              No
                            </button>
                          </div>
                        ) : f.type === "temperature" ? (
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            <input
                              type="number"
                              value={(backVal as number | string) ?? ""}
                              onChange={(e) => setBackField(f.key, e.target.value === "" ? "" : Number(e.target.value))}
                              className={`w-16 bg-bg border rounded-card px-2 py-1.5 font-mono text-xs text-text outline-none text-right ${
                                backOutOfRange ? "border-burgundy-light" : "border-border focus:border-olive"
                              }`}
                            />
                            <span className="font-mono text-[10px] text-dim">°{f.unit === "C" ? "C" : "F"}</span>
                          </div>
                        ) : (
                          <input
                            type={f.type === "number" ? "number" : "text"}
                            inputMode={f.type === "number" ? "decimal" : undefined}
                            value={(backFormValues[f.key] as string | number) ?? ""}
                            onChange={(e) =>
                              setBackField(f.key, f.type === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)
                            }
                            className="w-24 flex-shrink-0 bg-bg border border-border rounded-card px-2 py-1.5 font-mono text-xs text-text outline-none focus:border-olive text-right"
                          />
                        )}
                      </div>
                    );
                  })}
                  {requiresPhoto && backPhotoCapture}
                  <button
                    onClick={() =>
                      onStateChange("done", {
                        actualMinutes: Math.max(1, item.projectedMinutes || 1),
                        isBackEntry: true,
                        formData: backFormValues,
                        photoUrl: backPhotoUrl,
                      })
                    }
                    disabled={!backFormComplete || nfcBound || (requiresPhoto && !backPhotoUrl)}
                    className="w-full flex items-center justify-center gap-1.5 bg-olive/10 border border-olive/30 text-olive font-mono text-xs px-3 py-2 rounded-card min-h-[40px] hover:bg-olive/20 transition-colors disabled:opacity-40"
                  >
                    {nfcBound ? "Scan NFC to complete" : "✓ Done"}
                  </button>
                  {nfcBound && (
                    <p className="font-mono text-[10px] text-dim">
                      Bound to a physical tag — use Scan NFC to complete this task.
                    </p>
                  )}
                </div>
              )}
              {!isCheckbox && skipToggle}
            </div>
          )}

          {/* ── Claimed by me — Resume Timer/Missed ── */}
          {isMine && (
            <div className="space-y-2.5">
              <button
                onClick={onStartTimer}
                className="w-full flex items-center justify-center gap-1.5 bg-olive/10 border border-olive/30 text-olive font-mono text-xs px-3 py-2 rounded-card min-h-[40px] hover:bg-olive/20 transition-colors"
              >
                ▶ Resume Timer
              </button>
              {skipToggle}
            </div>
          )}

          {/* ── Claimed by someone else — read-only, no actions ── */}
          {claimedByOther && (
            <p className="font-mono text-[11px] text-dim">
              {state === "paused" ? "Paused" : "In progress"} by {claimName} — check back once they finish.
            </p>
          )}

          {/* ── Done/missed — unchanged read-only detail (the "by <name>"
              attribution already shows on the collapsed row's header
              above, so it isn't repeated here) ── */}
          {state === "done" && isForm && log?.formData && formFields.length > 0 ? (
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
          ) : (state === "done" || state === "missed") ? (
            <p className="font-mono text-[11px] text-dim">
              {LABEL[state]}
              {log?.actualMinutes != null ? ` · ${fmtMins(log.actualMinutes)}` : ""}
            </p>
          ) : null}

          {(state === "done" || state === "missed") && canUndo && (
            <button
              onClick={onUndo}
              className="font-mono text-[9px] text-dim uppercase tracking-widest"
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}
