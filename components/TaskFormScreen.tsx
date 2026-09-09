"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Nfc, Check, ClipboardList } from "lucide-react";
import AppIcon from "@/components/AppIcon";
import TaskInstructionsSheet from "@/components/TaskInstructionsSheet";
import TaskPhotoCaptureButton from "@/components/TaskPhotoCaptureButton";
import type { TimerItem } from "@/components/TimerScreen";
import type { FormFieldValue } from "@/models/TaskDefinition";
import { scanNfcTag } from "@/lib/native/nfc-scan";
import { playNotificationSound, type NotificationSound } from "@/lib/notification-sound";
import TemperatureInput from "@/components/TemperatureInput";
import type { TempUnit } from "@/lib/temperature";

type FieldValue = FormFieldValue;

// A count captured for one of this task's linked InventoryItemTypes (see
// docs/features/inventory.md's "Task ↔ Inventory Linking") — only ever
// included when the employee actually typed a value; a blank optional
// field is omitted, never sent as 0.
export interface InventoryCountEntry {
  itemTypeId: string;
  count: number;
  verifiedNfcUid: string | null;
}

interface InventoryLink {
  itemTypeId: string;
  name: string;
  unit: string | null;
  nfcTagUid: string | null;
  nfcRequiredToLog: boolean;
  required: boolean;
}

interface Props {
  item: TimerItem;
  initialElapsed?: number; // seconds already elapsed (from server startedAt on resume)
  taskListName?: string | null; // shown as a small kicker above the task name — which shift/list this belongs to
  // Set when the FAB's "scan to open" shortcut (components/BottomNav.tsx)
  // is what opened this exact task — the user already proved the tag was
  // present on the way in, so Save works immediately instead of demanding a
  // second scan on the way out. Ignored unless it matches item.nfcTagUid —
  // opening any other way (tapping the task directly) leaves this unset and
  // the normal Scan NFC step still applies. See docs/features/nfc.md.
  preVerifiedNfcUid?: string | null;
  // Which chirp to play once an NFC-bound task's completion actually saves
  // (either branch below — a fresh scan or the FAB's pre-verified path) —
  // see lib/notification-sound.ts and models/Company.ts's notificationSound.
  notificationSound: NotificationSound;
  // Rejects if the server refused the completion (e.g. an NFC-bound task
  // with no/mismatched scan — see docs/features/nfc.md) — handleSave below
  // catches that and shows it inline instead of closing this screen.
  onComplete: (
    formData: Record<string, FieldValue>,
    actualMinutes: number,
    verifiedNfcUid?: string | null,
    inventoryCounts?: InventoryCountEntry[],
    photoUrl?: string | null
  ) => Promise<void>;
  onMissed: () => void;
  onClose: () => void;
  // Set by the caller once a completion has actually been saved and it's
  // holding this screen mounted just long enough to play its exit animation
  // (globals.css's task-advance-out) before swapping to the next task or
  // closing back to the list — see TaskListSessionView's `transitioning`
  // state and TasksView's handleTaskFormComplete, both keyed off
  // lib/task-transition.ts's TASK_TRANSITION_MS. Never true on first mount.
  exiting?: boolean;
}

function pad(n: number) {
  return n.toString().padStart(2, "0");
}

// Sibling to TimerScreen.tsx, sharing its same lifecycle (server-stamped
// startedAt already applied before this opens, wall-clock elapsed tracking,
// Done/Missed via the same TasksView callbacks) — just no ring/clock as the
// focal element, since the point of a form task is the data, not the
// duration. See docs/features/timer.md for the elapsed-time convention
// this mirrors.
// A checklist field's sub-items — falls back to the field's own label when
// none were set (the "single check" case, e.g. "Take out garbage" — one
// action, one box, no separate item text needed). See models/TaskDefinition.ts.
function checklistItems(f: { label: string; items?: string[] }): string[] {
  return f.items && f.items.length > 0 ? f.items : [f.label];
}

function isChecklistComplete(f: { label: string; items?: string[] }, value: FieldValue | undefined): boolean {
  const checked = (value as Record<string, boolean> | undefined) ?? {};
  return checklistItems(f).every((label) => checked[label] === true);
}

export default function TaskFormScreen({ item, initialElapsed = 0, taskListName = null, preVerifiedNfcUid = null, notificationSound, onComplete, onMissed, onClose, exiting = false }: Props) {
  const fields = item.formFields ?? [];
  const [showInstructions, setShowInstructions] = useState(false);
  const instructionSteps = item.instructionSteps ?? [];

  const [elapsed, setElapsed] = useState(initialElapsed);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const baseElapsedRef = useRef(initialElapsed);
  const runStartRef = useRef<number | null>(null);

  const recompute = useCallback(() => {
    if (runStartRef.current != null) {
      const delta = Math.floor((Date.now() - runStartRef.current) / 1000);
      setElapsed(baseElapsedRef.current + delta);
    }
  }, []);

  useEffect(() => {
    runStartRef.current = Date.now();
    recompute();
    intervalRef.current = setInterval(recompute, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [recompute]);

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

  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [error, setError] = useState("");

  // Required completion photo — see docs/features/task-completion-photo.md.
  // One more condition on the same Save gate every field already sits
  // behind (handleSave below), not a separate mechanism.
  const requiresPhoto = !!item.requiresPhoto;
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);

  // Linked InventoryItemTypes (see docs/features/inventory.md's "Task ↔
  // Inventory Linking") — self-fetched, same pattern as Header.tsx's own
  // notificationSound fetch, rather than threading through every caller
  // that can open this screen (TasksView.tsx's standalone path,
  // TaskListSessionView.tsx's embedded one). null while loading; treated as
  // "no links yet" everywhere below rather than blocking Save on the fetch.
  const [inventoryLinks, setInventoryLinks] = useState<InventoryLink[] | null>(null);
  const [inventoryValues, setInventoryValues] = useState<Record<string, string>>({});
  useEffect(() => {
    setInventoryLinks(null);
    fetch(`/api/tasks/${item._id}/inventory-links`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setInventoryLinks)
      .catch(() => setInventoryLinks([]));
  }, [item._id]);

  // A task bound to a physical tag (Manage Task List → "Scan to Link" — see
  // docs/features/nfc.md's "In-app scan-to-complete binding") can't be
  // completed by tapping Save alone: the same fill-in flow runs first, but
  // the final step becomes a scan that must match this exact tag — UNLESS
  // the FAB's "scan to open" already proved it on the way in.
  const requiresNfcScan = !!item.nfcTagUid;
  const alreadyVerified = requiresNfcScan && !!preVerifiedNfcUid && preVerifiedNfcUid === item.nfcTagUid;
  const [scanning, setScanning] = useState(false);

  // Can this task's own scan ever verify a given linked item's count? Only
  // when the two share the identical bound tag — see
  // docs/features/inventory.md's "NFC enforcement". A required link that
  // can never be verified this way has no fillable input (see the render
  // below) and so is exempt from the "required" Save-blocking check too.
  const canLinkBeVerifiedByThisTask = (link: InventoryLink) =>
    requiresNfcScan && !!link.nfcTagUid && link.nfcTagUid === item.nfcTagUid;

  const setField = (key: string, value: FieldValue) => {
    setValues((v) => ({ ...v, [key]: value }));
    if (error) setError("");
  };

  const setInventoryValue = (itemTypeId: string, value: string) => {
    setInventoryValues((v) => ({ ...v, [itemTypeId]: value }));
    if (error) setError("");
  };

  // Builds the InventoryLog entries this Save should write, given whichever
  // uid (if any) just verified the TASK's own completion — see
  // docs/features/inventory.md's "NFC binding": the same scan that verifies
  // the task also verifies a linked item ONLY when that item is bound to
  // the identical tag. A blank field (optional, left empty) is omitted
  // entirely rather than sent as 0.
  const buildInventoryCounts = (verifyingUid: string | null): InventoryCountEntry[] =>
    (inventoryLinks ?? []).flatMap((link) => {
      const raw = inventoryValues[link.itemTypeId];
      if (raw === undefined || raw.trim() === "") return [];
      const count = Number(raw);
      if (!Number.isFinite(count)) return [];
      const verifiedNfcUid = !!verifyingUid && !!link.nfcTagUid && verifyingUid === link.nfcTagUid ? verifyingUid : null;
      return [{ itemTypeId: link.itemTypeId, count, verifiedNfcUid }];
    });

  const handleSave = async () => {
    // All fields required for the MVP — no optional-field logic yet.
    for (const f of fields) {
      const v = values[f.key];
      if (f.type === "boolean" && v === undefined) {
        setError(`${f.label} is required`);
        return;
      }
      if (f.type === "checklist" && !isChecklistComplete(f, v)) {
        setError(`Check off everything in ${f.label}`);
        return;
      }
      if (f.type !== "boolean" && f.type !== "checklist" && (v === undefined || v === "")) {
        setError(`${f.label} is required`);
        return;
      }
    }
    for (const link of inventoryLinks ?? []) {
      if (!link.required) continue;
      if (link.nfcRequiredToLog && !canLinkBeVerifiedByThisTask(link)) continue;
      const raw = inventoryValues[link.itemTypeId];
      if (raw === undefined || raw.trim() === "") {
        setError(`${link.name} count is required`);
        return;
      }
    }
    if (requiresPhoto && !photoUrl) {
      setError("Add a photo to complete this task");
      return;
    }
    const actualMinutes = Math.max(1, Math.round(elapsed / 60));

    if (!requiresNfcScan) {
      try {
        await onComplete(values, actualMinutes, undefined, buildInventoryCounts(null), photoUrl);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save — please try again.");
      }
      return;
    }

    if (alreadyVerified) {
      try {
        await onComplete(values, actualMinutes, preVerifiedNfcUid, buildInventoryCounts(preVerifiedNfcUid), photoUrl);
        playNotificationSound(notificationSound);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save — please try again.");
      }
      return;
    }

    setError("");
    setScanning(true);
    const result = await scanNfcTag();
    setScanning(false);

    if (result.status === "unsupported") {
      setError("Open the app on your phone to scan the linked tag.");
      return;
    }
    if (result.status === "cancelled") {
      setError(result.message);
      return;
    }
    if (result.uid !== item.nfcTagUid) {
      setError("That's not the tag linked to this task — scan the correct one.");
      return;
    }
    try {
      await onComplete(values, actualMinutes, result.uid, buildInventoryCounts(result.uid), photoUrl);
      playNotificationSound(notificationSound);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save — please try again.");
    }
  };

  const timeDisplay = `${pad(Math.floor(elapsed / 60))}:${pad(elapsed % 60)}`;

  // The Save/Scan button is a single `position: sticky` element pinned near
  // the bottom of the scroll container, so a long checklist/inventory
  // sublist can genuinely push "Missed it" below the fold while the Save
  // button itself stays reachable without a second, separately-animated
  // FAB (that used to visibly double up with the real button as it faded
  // in/out). atRest tracks whether the true end of the content — the
  // "Missed it" button — is in view: true once nothing's left to scroll to
  // (the Save button is at its natural resting spot, shown full-size),
  // false while there's still content below (Save button shrinks to a
  // docked mini size but keeps working — same element, same onClick).
  const scrollRef = useRef<HTMLDivElement>(null);
  const missedButtonRef = useRef<HTMLButtonElement>(null);
  const [atRest, setAtRest] = useState(true);

  useEffect(() => {
    const root = scrollRef.current;
    const target = missedButtonRef.current;
    if (!root || !target) return;
    const observer = new IntersectionObserver(([entry]) => setAtRest(entry.isIntersecting), {
      root,
      threshold: 0.9,
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  return (
    // Outer layer is a plain, static blue backdrop — never animated, always
    // covering whatever's behind (the Tasks list) so a swap or close never
    // flashes it into view mid-transition. Only the inner card (bordered,
    // inset from the backdrop on all sides so the blue shows as a frame
    // around it) plays task-advance-in/-out: -in on mount (every fresh task,
    // including a remount when TaskListSessionView advances straight from
    // one form task into another — see its key={currentTask._id}), -out
    // once the caller flips `exiting` true, right after a completion
    // actually saved. pointer-events-none while exiting guards against a
    // second tap landing on a card that's already on its way out.
    <>
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
      <div
        className={`relative w-full max-w-mobile rounded-[28px] border-2 border-white/25 bg-bg shadow-2xl overflow-hidden flex flex-col ${
          exiting ? "task-advance-out pointer-events-none" : "task-advance-in"
        }`}
      >
        <div className="flex items-center justify-between px-4 pt-4 pb-2 flex-shrink-0">
          <button onClick={onClose} className="font-mono text-dim text-sm min-h-[44px] pr-4 flex items-center">
            ← back
          </button>
          {/* Unobtrusive elapsed readout — kept for consistency/debugging, not the focal element */}
          <p className="font-mono text-dim text-xs">{timeDisplay}</p>
        </div>

        <div className="text-center px-4 mt-4 mb-6 flex-shrink-0">
          {taskListName && (
            <p className="font-mono text-[10px] uppercase tracking-widest text-olive mb-2">{taskListName}</p>
          )}
          <div className="flex justify-center mb-3">
            <AppIcon name={item.icon} size={40} strokeWidth={1.25} className="text-text" />
          </div>
          <h2 className="font-heading text-2xl text-text">{item.name}</h2>
          {instructionSteps.length > 0 && (
            <button
              type="button"
              onClick={() => setShowInstructions(true)}
              className="mt-2.5 inline-flex items-center gap-1 mx-auto font-mono text-[10px] text-olive border border-olive/30 bg-olive/10 px-2.5 py-1.5 rounded-pill"
            >
              <ClipboardList size={11} strokeWidth={1.75} />
              Instructions
            </button>
          )}
          {requiresNfcScan && (
            <p className={`font-mono text-[10px] uppercase tracking-widest mt-1 ${alreadyVerified ? "text-olive" : "text-dim"}`}>
              {alreadyVerified ? "Tag verified — Save to complete" : "Scan the linked tag to complete"}
            </p>
          )}
        </div>

        {/* flex flex-col + mt-auto on the Save/Missed block below is what
            keeps that block pinned to its original spot at the bottom of
            the card when the fields are short (e.g. a single-item
            checklist) instead of it just trailing the last field — while
            still scrolling normally once real content overflows. */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 pb-6 flex flex-col">
          <div className="space-y-5">
          {fields.map((f) => {
            if (f.type === "checklist") {
              const items = checklistItems(f);
              const isSingle = items.length === 1;
              const checked = (values[f.key] as Record<string, boolean> | undefined) ?? {};
              const toggleItem = (label: string) => setField(f.key, { ...checked, [label]: !checked[label] });
              return (
                <div key={f.key} className="space-y-1.5">
                  {/* A single-item checklist ("Take out garbage") skips the
                      label row above its own row — showing the action twice
                      would be redundant. A multi-item one keeps it as the
                      group heading above its rows. */}
                  {!isSingle && (
                    <label className="font-mono text-[10px] text-dim uppercase tracking-widest">{f.label}</label>
                  )}
                  <div className="space-y-2">
                    {items.map((label) => {
                      const isChecked = checked[label] === true;
                      return (
                        <button
                          key={label}
                          type="button"
                          onClick={() => toggleItem(label)}
                          className={`w-full flex items-center gap-3 py-3 px-3 rounded-card border font-body text-sm min-h-[44px] transition-colors ${
                            isChecked ? "bg-olive/10 border-olive text-text" : "border-border-light text-muted"
                          }`}
                        >
                          <span
                            className={`flex-shrink-0 w-5 h-5 rounded-md border flex items-center justify-center transition-colors ${
                              isChecked ? "bg-olive border-olive" : "border-border-light"
                            }`}
                          >
                            {isChecked && <Check size={13} strokeWidth={3} className="text-bg" />}
                          </span>
                          <span className="flex-1 text-left">{isSingle ? f.label : label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            }
            return (
              <div key={f.key} className="space-y-1.5">
                <label className="font-mono text-[10px] text-dim uppercase tracking-widest">
                  {f.label}
                  {f.type !== "temperature" && f.unit ? ` (${f.unit})` : ""}
                </label>
                {f.type === "temperature" ? (
                  <TemperatureInput
                    unit={(f.unit === "C" ? "C" : "F") as TempUnit}
                    value={values[f.key] as number | undefined}
                    onChange={(v) => setField(f.key, v)}
                    min={f.min}
                    max={f.max}
                  />
                ) : f.type === "boolean" ? (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setField(f.key, true)}
                      className={`flex-1 py-3 rounded-card border font-body text-sm min-h-[44px] transition-colors ${
                        values[f.key] === true ? "bg-olive/10 border-olive text-text" : "border-border-light text-muted"
                      }`}
                    >
                      Yes
                    </button>
                    <button
                      type="button"
                      onClick={() => setField(f.key, false)}
                      className={`flex-1 py-3 rounded-card border font-body text-sm min-h-[44px] transition-colors ${
                        values[f.key] === false ? "bg-olive/10 border-olive text-text" : "border-border-light text-muted"
                      }`}
                    >
                      No
                    </button>
                  </div>
                ) : f.type === "number" ? (
                  <input
                    type="number"
                    inputMode="decimal"
                    value={(values[f.key] as number | string) ?? ""}
                    onChange={(e) => setField(f.key, e.target.value === "" ? "" : Number(e.target.value))}
                    className="w-full bg-card border border-border rounded-card px-3 py-3 font-mono text-sm text-text outline-none focus:border-border-light min-h-[44px]"
                  />
                ) : (
                  <input
                    type="text"
                    value={(values[f.key] as string) ?? ""}
                    onChange={(e) => setField(f.key, e.target.value)}
                    className="w-full bg-card border border-border rounded-card px-3 py-3 font-body text-sm text-text outline-none focus:border-border-light min-h-[44px]"
                  />
                )}
              </div>
            );
          })}

          {/* Required completion photo — see
              docs/features/task-completion-photo.md. Positioned after the
              task's own fields, before Linked Inventory. */}
          {requiresPhoto && (
            <div className="space-y-1.5 pt-4 border-t border-border">
              <p className="font-mono text-[10px] text-dim uppercase tracking-widest">Completion Photo</p>
              <TaskPhotoCaptureButton taskId={item._id} photoUrl={photoUrl} onChange={setPhotoUrl} />
            </div>
          )}

          {/* Linked Inventory — count inputs for this task's linked
              InventoryItemTypes (see docs/features/inventory.md's "Task ↔
              Inventory Linking"), positioned after the task's own fields.
              Required links are marked with *; a blank optional field is
              simply skipped on save, never written as 0. */}
          {inventoryLinks && inventoryLinks.length > 0 && (
            <div className="space-y-5 pt-4 border-t border-border">
              <p className="font-mono text-[10px] text-dim uppercase tracking-widest">Linked Inventory</p>
              {inventoryLinks.map((link) => {
                const isPreVerified = alreadyVerified && !!link.nfcTagUid && link.nfcTagUid === preVerifiedNfcUid;
                // A required item on a different (or no) tag than this
                // task's own can never be satisfied through this task's
                // completion — see docs/features/inventory.md's "NFC
                // enforcement" — so there's no point offering an input
                // whose value would just be silently dropped server-side.
                const blockedByNfcRequirement = link.nfcRequiredToLog && !canLinkBeVerifiedByThisTask(link);
                return (
                  <div key={link.itemTypeId} className="space-y-1.5">
                    <label className="font-mono text-[10px] text-dim uppercase tracking-widest">
                      {link.name}
                      {link.unit ? ` (${link.unit})` : ""}
                      {link.required ? " *" : ""}
                    </label>
                    {blockedByNfcRequirement ? (
                      <p className="w-full bg-card border border-border rounded-card px-3 py-3 font-mono text-sm text-dim min-h-[44px] flex items-center gap-1.5">
                        <Nfc size={13} strokeWidth={1.75} />
                        Requires NFC scan
                      </p>
                    ) : (
                      <input
                        type="number"
                        inputMode="decimal"
                        value={inventoryValues[link.itemTypeId] ?? ""}
                        onChange={(e) => setInventoryValue(link.itemTypeId, e.target.value)}
                        placeholder={link.required ? "Required" : "Optional"}
                        className="w-full bg-card border border-border rounded-card px-3 py-3 font-mono text-sm text-text placeholder:text-dim outline-none focus:border-border-light min-h-[44px]"
                      />
                    )}
                    {isPreVerified && (
                      <p className="font-mono text-[11px] text-olive">Tag verified</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {error && <p className="font-mono text-xs text-burgundy-light">{error}</p>}
          </div>

          {/* Primary action — same single button either way (Nfc icon while
              a tag scan is still required, Check once ready to save).
              `sticky bottom-4` keeps it reachable on screen the whole time
              a long checklist/inventory sublist scrolls beneath it, instead
              of a separate mini FAB crossfading in over it. atRest (true
              once "Missed it" — the real end of content — is in view)
              drives a single size transition: full-size at its natural
              resting spot above Missed it, shrunk to a docked mini size
              while still floating above content further up. Always the
              same element, so there's never two blue circles overlapping
              mid-animation. mt-auto on the outer block still anchors
              everything to the bottom of the card when the fields above
              don't fill the available height on their own. */}
          <div className="mt-auto pt-4 w-full flex flex-col items-center">
            <div className="sticky bottom-4 z-20 flex flex-col items-center">
              <button
                onClick={handleSave}
                disabled={scanning}
                aria-label={requiresNfcScan && !alreadyVerified ? "Scan NFC tag to save" : "Save"}
                className={`relative rounded-full border-4 border-bg shadow-lg flex items-center justify-center bg-olive transition-all duration-300 ease-out disabled:opacity-70 active:opacity-90 ${
                  atRest ? "w-32 h-32" : "w-14 h-14"
                }`}
              >
                {/* The icon's `size` prop sets a literal SVG width/height
                    attribute, which can't CSS-transition — so it's kept at
                    one intrinsic size and scaled with a transform instead,
                    which animates smoothly in step with the button. */}
                {requiresNfcScan && !alreadyVerified ? (
                  <span
                    className={`inline-flex transition-transform duration-300 ease-out ${
                      atRest ? "scale-100" : "scale-[0.42]"
                    } ${scanning ? "animate-pulse" : ""}`}
                  >
                    <Nfc size={52} strokeWidth={1.75} className="text-bg" />
                  </span>
                ) : (
                  <span
                    className={`inline-flex transition-transform duration-300 ease-out ${
                      atRest ? "scale-100" : "scale-[0.42]"
                    }`}
                  >
                    <Check size={56} strokeWidth={2.25} className="text-bg" />
                  </span>
                )}
              </button>
              <p
                className={`font-mono text-xs text-dim uppercase tracking-widest overflow-hidden transition-all duration-300 ease-out ${
                  atRest ? "max-h-6 opacity-100 mt-3 mb-6" : "max-h-0 opacity-0 mt-0 mb-2"
                }`}
              >
                {scanning ? "Hold near tag…" : requiresNfcScan && !alreadyVerified ? "Scan NFC to Save" : "Save"}
              </p>
            </div>
            <button
              ref={missedButtonRef}
              onClick={onMissed}
              disabled={scanning}
              className="w-full py-3.5 rounded-card border border-burgundy/30 text-burgundy-light font-body text-sm min-h-[44px] disabled:opacity-60"
            >
              Missed it
            </button>
          </div>
        </div>
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
    </>
  );
}
