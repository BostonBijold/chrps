"use client";

import { X } from "lucide-react";
import AppIcon from "@/components/AppIcon";

export interface TaskInstructionStep {
  _id: string;
  description: string | null;
  imageUrl: string | null;
}

interface Props {
  taskName: string;
  taskIcon: string;
  steps: TaskInstructionStep[];
  onClose: () => void;
}

// Read-only complement to the manager-authoring "Instructions" section in
// ManageTaskDetailSheet.tsx — same bottom-sheet chrome, same image-forward
// step layout, but no Delete icon, no "+ Add Step", no file picker. Just
// the steps in stored order and a close action. See
// docs/features/task-instructions-employee-view.md. Only ever rendered
// when the task actually has at least one step — the caller (TaskRow.tsx/
// TaskCard.tsx) gates on `item.instructionSteps?.length > 0` before
// showing the button that opens this at all.
export default function TaskInstructionsSheet({ taskName, taskIcon, steps, onClose }: Props) {
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
                <AppIcon name={taskIcon} size={18} className="text-muted" />
              </div>
              <div className="min-w-0">
                <h2 className="font-heading text-lg text-text truncate">{taskName}</h2>
                <p className="font-mono text-[10px] uppercase tracking-widest text-dim mt-0.5">Instructions</p>
              </div>
            </div>
            <button onClick={onClose} className="text-dim min-h-[44px] min-w-[44px] flex items-center justify-end flex-shrink-0">
              <X size={18} />
            </button>
          </div>

          <div className="px-4 pb-8 overflow-y-auto space-y-4">
            {steps.map((step) => (
              <div
                key={step._id}
                className="bg-bg border border-border rounded-card overflow-hidden"
              >
                {step.imageUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={step.imageUrl}
                    alt=""
                    className="w-full h-auto block"
                  />
                )}
                {step.description && (
                  <p className="font-body text-sm text-text p-3">
                    {step.description}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
