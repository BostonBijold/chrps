"use client";

import { X } from "lucide-react";
import AppIcon from "@/components/AppIcon";

interface Props {
  taskName: string;
  taskIcon: string;
  photoUrl: string;
  onClose: () => void;
}

// Manager-facing review surface for a completed task's photo (see
// docs/features/task-completion-photo.md's "Deferred beyond v1" note —
// this closes that gap). Same bottom-sheet chrome as
// TaskInstructionsSheet.tsx, but a single completion photo rather than a
// manager-authored step list. Only ever rendered when the log actually
// has a photoUrl — the caller (TaskRow.tsx) gates the "View Image" pill
// that opens this on that.
export default function TaskPhotoViewSheet({ taskName, taskIcon, photoUrl, onClose }: Props) {
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
                <p className="font-mono text-[10px] uppercase tracking-widest text-dim mt-0.5">Completion Photo</p>
              </div>
            </div>
            <button onClick={onClose} className="text-dim min-h-[44px] min-w-[44px] flex items-center justify-end flex-shrink-0">
              <X size={18} />
            </button>
          </div>

          <div className="px-4 pb-8 overflow-y-auto">
            <div className="bg-bg border border-border rounded-card overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photoUrl} alt="" className="w-full h-auto block" />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
