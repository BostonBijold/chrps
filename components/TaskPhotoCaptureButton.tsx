"use client";

import { useState } from "react";
import { Camera as CameraIcon } from "lucide-react";
import { capturePhoto } from "@/lib/client/capture-image";
import { uploadImageDirect, withUploadTimeout, MAX_UPLOAD_IMAGE_BYTES, ALLOWED_UPLOAD_IMAGE_TYPES } from "@/lib/client/upload-image";

interface Props {
  taskId: string;
  photoUrl: string | null;
  onChange: (url: string | null) => void;
  disabled?: boolean;
}

// Shared completion-photo capture control — see
// docs/features/task-completion-photo.md. Reused across every screen that
// can mark a requiresPhoto task done (TimerScreen.tsx, TaskFormScreen.tsx,
// TaskCard.tsx's back-entry mode). Purely local/controlled state: nothing
// about the capture is persisted anywhere until the parent screen's own
// Done/Save action actually fires — the parent just reads `photoUrl` back
// out via `onChange` and threads it into its own completion call. Reuses
// the same capturePhoto()/uploadImageDirect() plumbing built for
// instruction-step images (docs/features/instruction-steps-camera-capture.md).
export default function TaskPhotoCaptureButton({ taskId, photoUrl, onChange, disabled = false }: Props) {
  const [capturing, setCapturing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = capturing || uploading;

  async function handleCapture() {
    setError(null);
    setCapturing(true);
    const result = await capturePhoto();
    setCapturing(false);

    if (result.status === "denied") {
      setError("Camera access is off for Ch'rps — enable it in Settings to add a photo.");
      return;
    }
    if (result.status === "error") {
      setError(result.message);
      return;
    }
    if (result.status !== "ok") return; // "cancelled" — no error, stay as-is

    const { file } = result;
    if (!ALLOWED_UPLOAD_IMAGE_TYPES.includes(file.type)) {
      setError(`"${file.type || "unknown"}" isn't a supported image type — use JPEG, PNG, or WEBP.`);
      return;
    }
    if (file.size > MAX_UPLOAD_IMAGE_BYTES) {
      setError(`That photo is ${(file.size / 1024 / 1024).toFixed(1)}MB — must be 8MB or smaller.`);
      return;
    }

    setUploading(true);
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "-");
    const pathname = `completion-photos/${taskId}-${Date.now()}-${safeName}`;
    try {
      const url = await withUploadTimeout(
        uploadImageDirect(file, pathname),
        30000,
        "Upload timed out — check your connection and try again."
      );
      onChange(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to upload photo");
    } finally {
      setUploading(false);
    }
  }

  if (photoUrl) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photoUrl} alt="" className="w-14 h-14 object-cover rounded-md flex-shrink-0" />
          <button
            type="button"
            onClick={handleCapture}
            disabled={busy || disabled}
            className="flex-1 flex items-center justify-center gap-1.5 border border-olive/30 bg-olive/10 text-olive font-mono text-xs px-3 py-2.5 rounded-card min-h-[44px] disabled:opacity-40"
          >
            <CameraIcon size={14} strokeWidth={1.75} />
            {capturing ? "Opening camera…" : uploading ? "Uploading…" : "Retake"}
          </button>
        </div>
        {error && <p className="font-mono text-[11px] text-burgundy-light">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={handleCapture}
        disabled={busy || disabled}
        className="w-full flex items-center justify-center gap-2 border border-dashed border-border-light text-muted font-mono text-xs py-3 rounded-card hover:border-olive/40 hover:text-olive transition-colors min-h-[44px] disabled:opacity-40"
      >
        <CameraIcon size={14} strokeWidth={1.75} />
        {capturing ? "Opening camera…" : uploading ? "Uploading…" : "Add a Photo"}
      </button>
      {error && <p className="font-mono text-[11px] text-burgundy-light">{error}</p>}
    </div>
  );
}
