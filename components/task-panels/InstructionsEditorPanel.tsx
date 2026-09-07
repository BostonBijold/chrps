"use client";

import { useState } from "react";
import { Trash2, Camera as CameraIcon } from "lucide-react";

// A manager-authored "what this should look like when done" step (photo
// and/or caption) — see docs/features/task-completion-instructions.md.
// `key` is the step's Mongo subdocument _id for an already-saved step, or
// a locally-generated placeholder for one just added in this session.
export interface InstructionStepView {
  key: string;
  description: string | null;
  imageUrl: string | null;
}

export interface InstructionsPanel {
  steps: InstructionStepView[];
  maxSteps: number;
  busy: boolean;
  error: string | null;
  capturing: boolean;
  captureError: string | null;
  onTakePhoto: () => Promise<File | null>;
  // Returns whether the add actually succeeded — the inline editor only
  // closes on success (see confirmAddStep below), so a failure stays open
  // with the draft intact and instructions.error visible, instead of
  // silently closing either way and leaving no sign anything went wrong.
  onAddStep: (input: { description: string | null; file: File | null }) => Promise<boolean>;
  onDeleteStep: (index: number) => void;
}

// Instructions panel — shared between TaskListEditView.tsx's SortableRow
// (Task Lists tab) and ManageTaskDetailSheet.tsx (Task Catalog tab), backed
// by lib/client/use-task-definition-panel.ts's useTaskDefinitionPanel hook
// — see docs/features/unified-task-edit-surface.md. Only the ephemeral
// "add a new step" draft (description/file/expanded-or-not) lives here as
// local state; every persisted step comes from the hook via `instructions`.
export default function InstructionsEditorPanel({ instructions }: { instructions: InstructionsPanel }) {
  const [addingStep, setAddingStep] = useState(false);
  const [draftDescription, setDraftDescription] = useState("");
  const [draftFile, setDraftFile] = useState<File | null>(null);

  const canAddDraft = draftDescription.trim().length > 0 || draftFile !== null;

  function resetDraft() {
    setAddingStep(false);
    setDraftDescription("");
    setDraftFile(null);
  }

  async function handleTakePhoto() {
    const file = await instructions.onTakePhoto();
    if (file) setDraftFile(file);
  }

  async function confirmAddStep() {
    if (!canAddDraft) return;
    const ok = await instructions.onAddStep({ description: draftDescription.trim() || null, file: draftFile });
    if (ok) resetDraft();
  }

  return (
    <div className="pt-3 border-t border-border">
      <p className="font-mono text-[10px] uppercase tracking-widest text-dim mb-1.5">Instructions</p>

      {instructions.steps.length > 0 && (
        <div className="space-y-2 mb-2">
          {instructions.steps.map((step, i) => (
            <div key={step.key} className="flex items-start gap-2 bg-bg border border-border rounded-card p-2">
              {step.imageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={step.imageUrl} alt="" className="w-14 h-14 object-cover rounded-md flex-shrink-0" />
              )}
              {step.description && (
                <p className="font-body text-xs text-text flex-1 min-w-0 pt-1">{step.description}</p>
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
            <button
              type="button"
              onClick={handleTakePhoto}
              disabled={instructions.capturing || instructions.busy}
              className="w-full flex items-center gap-2 font-mono text-[11px] text-muted min-h-[44px] disabled:opacity-40"
            >
              <CameraIcon size={14} strokeWidth={1.75} className="flex-shrink-0" />
              <span className="flex-1 truncate text-left">
                {instructions.capturing ? "Opening camera…" : draftFile ? draftFile.name : "Take Photo (optional)"}
              </span>
            </button>
            {instructions.captureError && (
              <p className="font-mono text-[11px] text-burgundy-light">{instructions.captureError}</p>
            )}
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
                disabled={!canAddDraft || instructions.busy || instructions.capturing}
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
  );
}
