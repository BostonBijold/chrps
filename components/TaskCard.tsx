"use client";

import { useState } from "react";
import { ClipboardList } from "lucide-react";
import AppIcon from "@/components/AppIcon";
import StreakDots from "@/components/StreakDots";
import TaskInstructionsSheet from "@/components/TaskInstructionsSheet";
import type { RowItem } from "@/components/TaskRow";
import type { TaskLogEntry } from "@/components/TasksView";
import type { LogState } from "@/models/TaskLog";
import type { FormFieldValue } from "@/models/TaskDefinition";

interface Props {
  item: RowItem;
  log?: TaskLogEntry;
  weekLogs: Array<{ date: string; state: LogState; actualMinutes: number | null }>;
  weekDates: string[]; // Sunday→Saturday, fixed calendar week
  today: string; // YYYY-MM-DD, real — what counts as "future" in StreakDots
  selectedDate: string; // YYYY-MM-DD — the date being browsed; gets the StreakDots ring
  isBackEntry: boolean;
  // Manager-only, everywhere — see docs/features/task-lists.md's "Task List
  // Locking" section. An employee who logs a wrong value asks a manager to
  // undo it rather than fixing it themselves.
  canUndo: boolean;
  onStartTimer: () => void;
  onStateChange: (
    state: LogState | null,
    opts?: { actualMinutes?: number; isBackEntry?: boolean; formData?: Record<string, FormFieldValue> }
  ) => void;
}

function fmtMins(mins: number) {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export default function TaskCard({
  item, log, weekLogs, weekDates, today, selectedDate, isBackEntry, canUndo,
  onStartTimer, onStateChange,
}: Props) {
  const state = log?.state ?? null;
  const isCheckbox = item.taskType === "checkbox";
  const isStopwatch = item.taskType === "stopwatch";
  const isForm = item.taskType === "form";
  const isTimed = !isCheckbox && !isStopwatch;
  // A task bound to a physical tag (see docs/features/nfc.md) can only be
  // completed via the in-app Scan NFC flow — the server rejects a "done"
  // write from any of these quick/back-entry paths, so disable them here
  // instead of letting the tap silently fail.
  const nfcBound = !!item.nfcTagUid;
  const hasDuration = item.projectedMinutes > 0;
  const actual = log?.actualMinutes ?? null;
  const variance = state === "done" && isTimed && actual != null && hasDuration
    ? actual - item.projectedMinutes
    : null;
  const [showInstructions, setShowInstructions] = useState(false);
  const instructionSteps = item.instructionSteps ?? [];
  const instructionsButton = instructionSteps.length > 0 && (
    <button
      type="button"
      onClick={() => setShowInstructions(true)}
      className="mt-1 flex items-center gap-1 font-mono text-[10px] text-olive"
    >
      <ClipboardList size={11} strokeWidth={1.75} />
      Instructions
    </button>
  );
  const instructionsSheet = showInstructions && (
    <TaskInstructionsSheet
      taskName={item.name}
      taskIcon={item.icon}
      steps={instructionSteps}
      onClose={() => setShowInstructions(false)}
    />
  );

  const [backMins, setBackMins] = useState(
    isStopwatch ? "30" : String(item.projectedMinutes || 15)
  );
  const [showSkips, setShowSkips] = useState(false);
  // Back-entry field capture for a form task — see TaskRow.tsx
  // for the same pattern in the timed-groups row.
  const [backFormValues, setBackFormValues] = useState<Record<string, FormFieldValue>>({});
  const formFields = item.formFields ?? [];
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

  // ── Completed state ────────────────────────────────────────────────────────
  if (state === "done") {
    return (
      <>
      <div className="bg-card rounded-card border-l-[3px] border-l-done px-4 py-3.5">
        <div className="flex items-center gap-3">
          <div className="w-7 flex items-center justify-center flex-shrink-0">
            <AppIcon name={item.icon} size={17} className="text-done/60" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-body text-sm text-dim line-through leading-tight">{item.name}</p>
            {instructionsButton}
            <div className="mt-1.5">
              <StreakDots
              logs={weekLogs}
              dates={weekDates}
              today={today}
              viewingDate={selectedDate}
              scheduledDays={item.scheduledDays}
              successThreshold={item.successThreshold}
              targetMinutes={isTimed ? item.projectedMinutes : null}
            />
            </div>
          </div>
          <div className="flex flex-col items-end gap-0.5 flex-shrink-0">
            <span className="font-mono text-xs text-done bg-done/10 px-2 py-0.5 rounded-pill">
              ✓ Done
            </span>
            {isTimed && actual != null && hasDuration && (
              <span className="font-mono text-[10px] text-dim">
                {fmtMins(actual)}
                {variance !== null && variance !== 0 && (
                  <span className={variance > 0 ? " text-tobacco" : " text-gold"}>
                    {" "}{variance > 0 ? `+${variance}m` : `${variance}m`}
                  </span>
                )}
              </span>
            )}
            {isStopwatch && actual != null && actual > 0 && (
              <span className="font-mono text-[10px] text-dim">{fmtMins(actual)}</span>
            )}
          </div>
        </div>
        {/* Undo — manager-only */}
        {canUndo && (
          <button
            onClick={() => onStateChange(null)}
            className="mt-2 ml-10 font-mono text-[9px] text-dim uppercase tracking-widest"
          >
            Undo
          </button>
        )}
      </div>
      {instructionsSheet}
      </>
    );
  }

  // ── Missed state ───────────────────────────────────────────────────────────
  if (state === "missed") {
    return (
      <>
      <div className="bg-card rounded-card border-l-[3px] border-l-burgundy px-4 py-3.5">
        <div className="flex items-center gap-3">
          <div className="w-7 flex items-center justify-center flex-shrink-0">
            <AppIcon name={item.icon} size={17} className="text-dim" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-body text-sm text-dim leading-tight">{item.name}</p>
            {instructionsButton}
            <div className="mt-1.5">
              <StreakDots
              logs={weekLogs}
              dates={weekDates}
              today={today}
              viewingDate={selectedDate}
              scheduledDays={item.scheduledDays}
              successThreshold={item.successThreshold}
              targetMinutes={isTimed ? item.projectedMinutes : null}
            />
            </div>
          </div>
          <span className="font-mono text-xs text-burgundy-light bg-burgundy/10 px-2 py-0.5 rounded-pill flex-shrink-0">
            ✗ Missed
          </span>
        </div>
        {canUndo && (
          <button
            onClick={() => onStateChange(null)}
            className="mt-2 ml-10 font-mono text-[9px] text-dim uppercase tracking-widest"
          >
            Undo
          </button>
        )}
      </div>
      {instructionsSheet}
      </>
    );
  }

  // ── Rest state ─────────────────────────────────────────────────────────────
  if (state === "rest") {
    return (
      <>
      <div className="bg-card rounded-card border-l-[3px] border-l-blue-muted px-4 py-3.5">
        <div className="flex items-center gap-3">
          <div className="w-7 flex items-center justify-center flex-shrink-0">
            <AppIcon name={item.icon} size={17} className="text-dim" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-body text-sm text-dim leading-tight">{item.name}</p>
            {instructionsButton}
            <div className="mt-1.5">
              <StreakDots
              logs={weekLogs}
              dates={weekDates}
              today={today}
              viewingDate={selectedDate}
              scheduledDays={item.scheduledDays}
              successThreshold={item.successThreshold}
              targetMinutes={isTimed ? item.projectedMinutes : null}
            />
            </div>
          </div>
          <span className="font-mono text-xs text-blue-muted bg-blue-muted/10 px-2 py-0.5 rounded-pill flex-shrink-0">
            ~ Rest
          </span>
        </div>
        {canUndo && (
          <button
            onClick={() => onStateChange(null)}
            className="mt-2 ml-10 font-mono text-[9px] text-dim uppercase tracking-widest"
          >
            Undo
          </button>
        )}
      </div>
      {instructionsSheet}
      </>
    );
  }

  // ── Pending state ──────────────────────────────────────────────────────────
  return (
    <>
    <div className="bg-card rounded-card px-4 py-3.5 space-y-3">
      {/* Top row: icon + name + primary action */}
      <div className="flex items-center gap-3">
        <div className="w-7 flex items-center justify-center flex-shrink-0">
          <AppIcon name={item.icon} size={17} className="text-muted" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-body text-sm text-text leading-tight">{item.name}</p>
          {instructionsButton}
          <div className="mt-1.5">
            <StreakDots
              logs={weekLogs}
              dates={weekDates}
              today={today}
              viewingDate={selectedDate}
              scheduledDays={item.scheduledDays}
              successThreshold={item.successThreshold}
              targetMinutes={isTimed ? item.projectedMinutes : null}
            />
          </div>
        </div>

        {/* Primary action — always visible, no tap to reveal */}
        {isCheckbox && (
          <button
            onClick={() => onStateChange("done", { isBackEntry })}
            disabled={nfcBound}
            aria-label={nfcBound ? "Requires scanning the linked NFC tag" : "Mark done"}
            className="flex items-center justify-center w-10 h-10 rounded-full border-2 border-olive/30 text-transparent hover:border-olive/60 transition-colors flex-shrink-0 disabled:opacity-40 disabled:hover:border-olive/30"
          >
            <span className="text-base leading-none">✓</span>
          </button>
        )}

        {!isCheckbox && !isBackEntry && (
          <button
            onClick={onStartTimer}
            className="flex items-center gap-1.5 bg-olive/10 border border-olive/30 text-olive font-mono text-xs px-3 py-2 rounded-card min-h-[40px] flex-shrink-0 hover:bg-olive/20 transition-colors"
          >
            <span>▶</span>
            {hasDuration && !isStopwatch && (
              <span>{fmtMins(item.projectedMinutes)}</span>
            )}
            {isStopwatch && <span>Start</span>}
          </button>
        )}

        {!isCheckbox && isBackEntry && !isForm && (
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() =>
                onStateChange("done", {
                  actualMinutes: Math.max(1, parseInt(backMins) || item.projectedMinutes || 1),
                  isBackEntry: true,
                })
              }
              disabled={nfcBound}
              className="flex items-center gap-1.5 bg-olive/10 border border-olive/30 text-olive font-mono text-xs px-3 py-2 rounded-card min-h-[40px] hover:bg-olive/20 transition-colors disabled:opacity-40"
            >
              {nfcBound ? "Scan NFC to complete" : "✓ Done"}
            </button>
            {hasDuration && (
              <div className="flex items-center gap-0.5 border border-border rounded-card px-2 py-2 min-h-[40px]">
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
        )}
      </div>

      {/* Form check back-entry: fields replace the plain minutes input above —
          a retroactive check still needs its readings, not just a duration. */}
      {isForm && isBackEntry && (
        <div className="ml-10 space-y-2">
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
                    // No inputMode override — iOS's plain number keypad
                    // includes a minus key, unlike inputMode="decimal"
                    // (needed for negative freezer readings).
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
          <button
            onClick={() =>
              onStateChange("done", {
                actualMinutes: Math.max(1, item.projectedMinutes || 1),
                isBackEntry: true,
                formData: backFormValues,
              })
            }
            disabled={!backFormComplete || nfcBound}
            className="w-full flex items-center justify-center gap-1.5 bg-olive/10 border border-olive/30 text-olive font-mono text-xs px-3 py-2 rounded-card min-h-[40px] hover:bg-olive/20 transition-colors disabled:opacity-40"
          >
            {nfcBound ? "Scan NFC to complete" : "✓ Done"}
          </button>
          {nfcBound && (
            <p className="font-mono text-[10px] text-dim">
              Bound to a physical tag — open this task normally and use Scan NFC instead.
            </p>
          )}
        </div>
      )}

      {/* Skip options — shown inline when toggled */}
      {!showSkips ? (
        <button
          onClick={() => setShowSkips(true)}
          className="ml-10 font-mono text-[9px] text-dim uppercase tracking-widest"
        >
          Skip…
        </button>
      ) : (
        <div className="ml-10 flex gap-2">
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
      )}
    </div>
    {instructionsSheet}
    </>
  );
}
