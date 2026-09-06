"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { ClipboardList } from "lucide-react";
import AppIcon from "@/components/AppIcon";
import TaskInstructionsSheet, { type TaskInstructionStep } from "@/components/TaskInstructionsSheet";
import type { FormFieldDef } from "@/models/TaskDefinition";

export interface TimerItem {
  _id: string;
  name: string;
  icon: string;
  projectedMinutes: number;
  taskType?: string;
  formFields?: FormFieldDef[]; // only meaningful when taskType === "form" — see TaskFormScreen.tsx
  nfcTagUid?: string | null; // bound physical tag's UID — see docs/features/nfc.md
  // See docs/features/task-instructions-employee-view.md — same field as
  // RowItem (components/TaskRow.tsx), just re-declared here since TimerItem
  // is its own narrower shape.
  instructionSteps?: TaskInstructionStep[];
}

interface Props {
  item: TimerItem;
  initialElapsed?: number; // seconds already elapsed (from server startedAt on resume)
  taskListName?: string | null; // shown as a small kicker above the task name — which shift/list this belongs to
  onComplete: (actualMinutes: number) => void;
  onMissed: () => void;
  onClose: () => void;
}

function pad(n: number) {
  return n.toString().padStart(2, "0");
}

const STOPWATCH_SOFT_CAP = 30 * 60; // ring fills over 30 minutes, stays full after

export default function TimerScreen({ item, initialElapsed = 0, taskListName = null, onComplete, onMissed, onClose }: Props) {
  const isStopwatch = item.taskType === "stopwatch";
  const [showInstructions, setShowInstructions] = useState(false);
  const instructionSteps = item.instructionSteps ?? [];
  const instructionsButton = instructionSteps.length > 0 && (
    <button
      type="button"
      onClick={() => setShowInstructions(true)}
      className="mt-2.5 inline-flex items-center gap-1 mx-auto font-mono text-[10px] text-olive border border-olive/30 bg-olive/10 px-2.5 py-1.5 rounded-pill"
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

  const [elapsed, setElapsed] = useState(initialElapsed);
  const [isRunning, setIsRunning] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // elapsed is derived from real wall-clock time, not from counting interval ticks —
  // ticks get throttled/suspended when the PWA is backgrounded or the screen locks,
  // so a naive "+1 every 1000ms" counter silently loses however long you were away.
  // baseElapsedRef = seconds banked before the current running segment started.
  // runStartRef = Date.now() when the current running segment began (null if paused).
  const baseElapsedRef = useRef(initialElapsed);
  const runStartRef = useRef<number | null>(null);

  const recompute = useCallback(() => {
    if (runStartRef.current != null) {
      const delta = Math.floor((Date.now() - runStartRef.current) / 1000);
      setElapsed(baseElapsedRef.current + delta);
    }
  }, []);

  useEffect(() => {
    if (isRunning) {
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
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isRunning, recompute]);

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

  const actualMinutes = Math.max(1, Math.round(elapsed / 60));

  // ── Countdown mode ───────────────────────────────────────────────────────────
  if (!isStopwatch) {
    const target = item.projectedMinutes * 60;
    const isOver = elapsed >= target && target > 0;
    const ratio = target > 0 ? elapsed / target : 0;
    const is75 = ratio >= 0.75;
    const r = 88;
    const circumference = 2 * Math.PI * r;
    const dashOffset = circumference * (1 - Math.min(ratio, 1));
    const ringColor = isOver ? "#dc2626" : is75 ? "#d97706" : "#1f63b6";
    const timeColor = isOver ? "#ef4444" : "#0f172a";
    const remaining = Math.max(0, target - elapsed);
    const overAmount = Math.max(0, elapsed - target);
    const timeDisplay = isOver
      ? `+${pad(Math.floor(overAmount / 60))}:${pad(overAmount % 60)}`
      : `${pad(Math.floor(remaining / 60))}:${pad(remaining % 60)}`;

    return (
      <>
      <div className="fixed inset-0 bg-bg z-50 flex flex-col max-w-mobile mx-auto">
        <div className="flex items-center justify-between px-4 pt-10 pb-2">
          <button onClick={onClose} className="font-mono text-dim text-sm min-h-[44px] pr-4 flex items-center">
            ← back
          </button>
          <div className="text-right">
            <p className="font-mono text-dim text-[10px] uppercase tracking-wider">target</p>
            <p className="font-mono text-muted text-sm">{item.projectedMinutes}m</p>
          </div>
        </div>

        <div className="flex-1 flex flex-col select-none">
          <div className="text-center px-4 mt-6">
            {taskListName && (
              <p className="font-mono text-[10px] uppercase tracking-widest text-olive mb-2">{taskListName}</p>
            )}
            <div className="flex justify-center mb-3">
              <AppIcon name={item.icon} size={44} strokeWidth={1.25} className="text-text" />
            </div>
            <h2 className="font-heading text-2xl text-text">{item.name}</h2>
            {instructionsButton}
          </div>

          <div className="flex-1 flex items-center justify-center">
            <div className="relative w-56 h-56">
              <svg className="w-full h-full -rotate-90" viewBox="0 0 200 200">
                <circle cx="100" cy="100" r={r} fill="none" stroke="#dbe2ea" strokeWidth="10" />
                <circle
                  cx="100" cy="100" r={r}
                  fill="none"
                  stroke={ringColor}
                  strokeWidth="10"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  style={{ transition: "stroke-dashoffset 0.95s linear, stroke 0.4s ease" }}
                />
                {/* Handle at the arc's tip — purely visual */}
                <circle
                  cx={100 + r * Math.cos(Math.min(ratio, 1) * 2 * Math.PI)}
                  cy={100 + r * Math.sin(Math.min(ratio, 1) * 2 * Math.PI)}
                  r={9}
                  fill={ringColor}
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
                <span className="font-mono text-[2.5rem] font-semibold leading-none" style={{ color: timeColor }}>
                  {timeDisplay}
                </span>
                <span className="font-mono text-xs text-dim mt-1">
                  {isOver ? "over target" : "remaining"}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="px-4 pb-12 space-y-3 w-full">
          <button
            onClick={() => onComplete(actualMinutes)}
            className="w-full py-4 rounded-card bg-olive text-text font-body font-medium text-base"
          >
            Done · log {actualMinutes}m
          </button>
          <div className="flex gap-3">
            <button
              onClick={() => setIsRunning((r) => !r)}
              className="flex-1 py-3.5 rounded-card border border-border-light text-muted font-body text-sm min-h-[44px]"
            >
              {isRunning ? "Pause" : "Resume"}
            </button>
            <button
              onClick={onMissed}
              className="flex-1 py-3.5 rounded-card border border-burgundy/30 text-burgundy-light font-body text-sm min-h-[44px]"
            >
              Missed it
            </button>
          </div>
        </div>
      </div>
      {instructionsSheet}
      </>
    );
  }

  // ── Stopwatch mode ───────────────────────────────────────────────────────────
  const r = 88;
  const circumference = 2 * Math.PI * r;
  const ratio = Math.min(elapsed / STOPWATCH_SOFT_CAP, 1);
  const dashOffset = circumference * (1 - ratio);
  const timeDisplay = `${pad(Math.floor(elapsed / 60))}:${pad(elapsed % 60)}`;

  return (
    <>
    <div className="fixed inset-0 bg-bg z-50 flex flex-col max-w-mobile mx-auto">
      <div className="flex items-center justify-between px-4 pt-10 pb-2">
        <button onClick={onClose} className="font-mono text-dim text-sm min-h-[44px] pr-4 flex items-center">
          ← back
        </button>
        <div className="text-right">
          <p className="font-mono text-dim text-[10px] uppercase tracking-wider">stopwatch</p>
          <p className="font-mono text-muted text-sm">no target</p>
        </div>
      </div>

      <div className="flex-1 flex flex-col select-none">
        <div className="text-center px-4 mt-6">
          {taskListName && (
            <p className="font-mono text-[10px] uppercase tracking-widest text-olive mb-2">{taskListName}</p>
          )}
          <div className="flex justify-center mb-3">
            <AppIcon name={item.icon} size={44} strokeWidth={1.25} className="text-text" />
          </div>
          <h2 className="font-heading text-2xl text-text">{item.name}</h2>
          {instructionsButton}
        </div>

        <div className="flex-1 flex items-center justify-center">
          <div className="relative w-56 h-56">
            <svg className="w-full h-full -rotate-90" viewBox="0 0 200 200">
              <circle cx="100" cy="100" r={r} fill="none" stroke="#dbe2ea" strokeWidth="10" />
              <circle
                cx="100" cy="100" r={r}
                fill="none"
                stroke="#1f63b6"
                strokeWidth="10"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={dashOffset}
                style={{ transition: "stroke-dashoffset 0.95s linear" }}
              />
              {/* Handle at the arc's tip — purely visual */}
              <circle
                cx={100 + r * Math.cos(ratio * 2 * Math.PI)}
                cy={100 + r * Math.sin(ratio * 2 * Math.PI)}
                r={9}
                fill="#1f63b6"
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
              <span className="font-mono text-[2.5rem] font-semibold leading-none text-text">
                {timeDisplay}
              </span>
              <span className="font-mono text-xs text-dim mt-1">elapsed</span>
            </div>
          </div>
        </div>
      </div>

      <div className="px-4 pb-12 space-y-3 w-full">
        <button
          onClick={() => onComplete(actualMinutes)}
          className="w-full py-4 rounded-card bg-olive text-text font-body font-medium text-base"
        >
          Done · log {actualMinutes}m
        </button>
        <div className="flex gap-3">
          <button
            onClick={() => setIsRunning((r) => !r)}
            className="flex-1 py-3.5 rounded-card border border-border-light text-muted font-body text-sm min-h-[44px]"
          >
            {isRunning ? "Pause" : "Resume"}
          </button>
          <button
            onClick={onMissed}
            className="flex-1 py-3.5 rounded-card border border-burgundy/30 text-burgundy-light font-body text-sm min-h-[44px]"
          >
            Missed it
          </button>
        </div>
      </div>
    </div>
    {instructionsSheet}
    </>
  );
}
