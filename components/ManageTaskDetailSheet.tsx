"use client";

import { useState } from "react";
import Link from "next/link";
import { X, Nfc, Trash2, ImagePlus } from "lucide-react";
import AppIcon from "@/components/AppIcon";

interface UsedInEntry {
  taskListId: string;
  taskListName: string;
}

interface TagBinding {
  nfcTagUid: string | null;
  busy: boolean;
  error: string | null;
  alsoBoundTo: string[];
  onScanToLink: () => void;
  onUnbind: () => void;
}

// A manager-authored "what this should look like when done" step (photo
// and/or caption) — see docs/features/task-completion-instructions.md.
// `key` is the step's Mongo subdocument _id for an already-saved step, or
// a locally-generated placeholder for one just added in this session.
export interface InstructionStepView {
  key: string;
  description: string | null;
  imageUrl: string | null;
}

interface InstructionsPanel {
  steps: InstructionStepView[];
  maxSteps: number;
  busy: boolean;
  error: string | null;
  // Returns whether the add actually succeeded — the inline editor only
  // closes on success (see confirmAddStep below), so a failure stays open
  // with the draft intact and instructions.error visible, instead of
  // silently closing either way and leaving no sign anything went wrong.
  onAddStep: (input: { description: string | null; file: File | null }) => Promise<boolean>;
  onDeleteStep: (index: number) => void;
}

interface Props {
  icon: string;
  name: string;
  meta: string;
  usedIn?: UsedInEntry[];
  tagBinding?: TagBinding;
  instructions?: InstructionsPanel;
  editHref?: string;
  editLabel?: string;
  onDelete: () => void;
  deleteLabel: string;
  deleting: boolean;
  blockedMessage?: string | null;
  onClose: () => void;
}

// Shared detail-on-tap sheet for Manage Tasks' compact rows (Standalone
// Tasks and Company Task Catalog) — reuses AddTaskSheet's bottom-sheet
// presentation so a manager sees the same "used in"/tag-binding/edit/delete
// detail that used to render inline on every card, but only when they
// actually tap in for it. `usedIn`/`tagBinding` are omitted for a
// Standalone Tasks row, which has neither concept at the placement level.
export default function ManageTaskDetailSheet({
  icon,
  name,
  meta,
  usedIn,
  tagBinding,
  instructions,
  editHref,
  editLabel,
  onDelete,
  deleteLabel,
  deleting,
  blockedMessage,
  onClose,
}: Props) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [addingStep, setAddingStep] = useState(false);
  const [draftDescription, setDraftDescription] = useState("");
  const [draftFile, setDraftFile] = useState<File | null>(null);

  const canAddDraft = draftDescription.trim().length > 0 || draftFile !== null;

  function resetDraft() {
    setAddingStep(false);
    setDraftDescription("");
    setDraftFile(null);
  }

  async function confirmAddStep() {
    if (!instructions || !canAddDraft) return;
    const ok = await instructions.onAddStep({ description: draftDescription.trim() || null, file: draftFile });
    if (ok) resetDraft();
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-40" onClick={onClose} />

      <div className="fixed bottom-0 left-0 right-0 z-50 max-w-mobile mx-auto">
        <div className="bg-card rounded-t-modal max-h-[80vh] flex flex-col">
          <div className="flex justify-center pt-3 pb-1 flex-shrink-0">
            <div className="w-10 h-1 rounded-full bg-border-light" />
          </div>

          <div className="flex items-center justify-between px-4 pb-3 flex-shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 flex items-center justify-center flex-shrink-0">
                <AppIcon name={icon} size={18} className="text-muted" />
              </div>
              <div className="min-w-0">
                <h2 className="font-heading text-lg text-text truncate">{name}</h2>
                <p className="font-mono text-[10px] text-dim mt-0.5">{meta}</p>
              </div>
            </div>
            <button onClick={onClose} className="text-dim min-h-[44px] min-w-[44px] flex items-center justify-end flex-shrink-0">
              <X size={18} />
            </button>
          </div>

          <div className="px-4 pb-8 overflow-y-auto space-y-4">
            {usedIn && (
              <div>
                <p className="font-mono text-[10px] uppercase tracking-widest text-dim mb-1.5">
                  Used In
                </p>
                {usedIn.length > 0 ? (
                  <p className="font-body text-sm text-text">
                    {usedIn.map((p) => p.taskListName).join(", ")}
                  </p>
                ) : (
                  <p className="font-mono text-xs text-dim">Not placed in any list</p>
                )}
              </div>
            )}

            {tagBinding && (
              <div className="pt-3 border-t border-border">
                <p className="font-mono text-[10px] uppercase tracking-widest text-dim mb-1.5 flex items-center gap-1.5">
                  <Nfc size={11} strokeWidth={1.75} />
                  Scan-to-Complete Tag
                </p>
                {tagBinding.nfcTagUid ? (
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-olive flex-1 truncate">
                      Bound · {tagBinding.nfcTagUid}
                    </span>
                    <button
                      type="button"
                      onClick={tagBinding.onUnbind}
                      disabled={tagBinding.busy}
                      className="font-mono text-[11px] text-burgundy-light px-2 py-1 disabled:opacity-40"
                    >
                      Unbind
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={tagBinding.onScanToLink}
                    disabled={tagBinding.busy}
                    className="font-mono text-[11px] text-olive border border-olive/30 bg-olive/10 px-3 py-1.5 rounded-pill disabled:opacity-40"
                  >
                    {tagBinding.busy ? "Hold near tag…" : "Scan to Link"}
                  </button>
                )}
                {tagBinding.error && (
                  <p className="font-mono text-[11px] text-burgundy-light mt-1.5">{tagBinding.error}</p>
                )}
                {tagBinding.alsoBoundTo.length > 0 && (
                  <p className="font-mono text-[11px] text-dim mt-1.5">
                    Also bound to: {tagBinding.alsoBoundTo.join(", ")}
                  </p>
                )}
              </div>
            )}

            {instructions && (
              <div className="pt-3 border-t border-border">
                <p className="font-mono text-[10px] uppercase tracking-widest text-dim mb-1.5">
                  Instructions
                </p>

                {instructions.steps.length > 0 && (
                  <div className="space-y-2 mb-2">
                    {instructions.steps.map((step, i) => (
                      <div
                        key={step.key}
                        className="flex items-start gap-2 bg-bg border border-border rounded-card p-2"
                      >
                        {step.imageUrl && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={step.imageUrl}
                            alt=""
                            className="w-14 h-14 object-cover rounded-md flex-shrink-0"
                          />
                        )}
                        {step.description && (
                          <p className="font-body text-xs text-text flex-1 min-w-0 pt-1">
                            {step.description}
                          </p>
                        )}
                        <button
                          type="button"
                          onClick={() => instructions.onDeleteStep(i)}
                          disabled={instructions.busy}
                          aria-label="Delete step"
                          className="text-dim hover:text-burgundy-light flex-shrink-0 min-h-[32px] min-w-[32px] flex items-center justify-center disabled:opacity-40"
                        >
                          <Trash2 size={14} strokeWidth={1.75} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {instructions.error && (
                  <p className="font-mono text-[11px] text-burgundy-light mb-1.5">{instructions.error}</p>
                )}

                {instructions.steps.length < instructions.maxSteps &&
                  (addingStep ? (
                    <div className="space-y-2 bg-bg border border-border rounded-card p-2.5">
                      <label className="flex items-center gap-2 font-mono text-[11px] text-muted min-h-[44px]">
                        <ImagePlus size={14} strokeWidth={1.75} className="flex-shrink-0" />
                        <span className="flex-1 truncate">{draftFile ? draftFile.name : "Add a photo (optional)"}</span>
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          className="hidden"
                          onChange={(e) => setDraftFile(e.target.files?.[0] ?? null)}
                        />
                      </label>
                      <textarea
                        value={draftDescription}
                        onChange={(e) => setDraftDescription(e.target.value)}
                        placeholder="Description (optional)"
                        rows={2}
                        className="w-full bg-card border border-border rounded-md px-2.5 py-2 font-body text-xs text-text placeholder:text-dim outline-none resize-none"
                      />
                      <div className="flex items-center justify-end gap-3">
                        <button
                          type="button"
                          onClick={resetDraft}
                          className="font-mono text-[11px] text-dim uppercase tracking-widest"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={confirmAddStep}
                          disabled={!canAddDraft || instructions.busy}
                          className="font-mono text-[11px] text-olive uppercase tracking-widest disabled:opacity-40"
                        >
                          {instructions.busy ? "Adding…" : "Add"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setAddingStep(true)}
                      className="w-full flex items-center justify-center gap-2 border border-dashed border-border-light text-dim font-mono text-[11px] py-2.5 rounded-card hover:border-olive/40 hover:text-olive transition-colors min-h-[40px]"
                    >
                      + Add Step
                    </button>
                  ))}
              </div>
            )}

            <div className="pt-3 border-t border-border flex items-center justify-between gap-2">
              {editHref ? (
                <Link href={editHref} className="font-mono text-[10px] text-olive uppercase tracking-widest">
                  {editLabel}
                </Link>
              ) : (
                <span />
              )}
              <button
                onClick={() => (confirmingDelete ? onDelete() : setConfirmingDelete(true))}
                disabled={deleting}
                className="font-mono text-[10px] text-burgundy-light uppercase tracking-widest disabled:opacity-50"
              >
                {deleting ? `${deleteLabel === "Delete" ? "Deleting" : "Removing"}…` : confirmingDelete ? `Confirm ${deleteLabel}` : deleteLabel}
              </button>
            </div>

            {blockedMessage && (
              <p className="font-mono text-[10px] text-burgundy-light">{blockedMessage}</p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
