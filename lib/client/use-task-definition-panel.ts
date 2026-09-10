"use client";

import { useState } from "react";
import { Capacitor } from "@capacitor/core";
import { scanNfcTag } from "@/lib/native/nfc-scan";
import { claimNfcTag } from "@/lib/client/claim-nfc-tag";
import { capturePhoto } from "@/lib/client/capture-image";
import { uploadImageDirect, withUploadTimeout, MAX_UPLOAD_IMAGE_BYTES, ALLOWED_UPLOAD_IMAGE_TYPES } from "@/lib/client/upload-image";

// Shared client-side state/logic for the four TaskDefinition-level panels
// that need to render identically whether a manager reaches a task through
// a Task Lists placement row (TaskListEditView.tsx's SortableRow) or the
// Task Catalog (ManageTasksView.tsx's CatalogRow, via ManageTaskDetailSheet)
// — see docs/features/unified-task-edit-surface.md. Every call here is
// definitionId-scoped (PATCH /api/task-definitions/[id],
// POST/DELETE /api/task-definitions/[id]/nfc-tag), so binding a tag,
// adding an instruction step, or toggling requiresPhoto behaves identically
// and cascades to every list placement no matter which screen it's edited
// from. Linked Inventory is a separate hook (useInventoryLinks below) since
// it also needs a "pick an item type" picker sheet the caller renders.

export interface DefinitionInstructionStep {
  _id: string;
  description: string | null;
  imageUrl: string | null;
}

export interface UseTaskDefinitionPanelInit {
  nfcTagUid: string | null;
  instructionSteps: DefinitionInstructionStep[];
  requiresPhoto: boolean;
}

export const MAX_INSTRUCTION_STEPS = 3;

export function useTaskDefinitionPanel(definitionId: string, initial: UseTaskDefinitionPanelInit) {
  // Scan-to-complete binding — see docs/features/nfc.md's "In-app
  // scan-to-complete binding".
  const [nfcTagUid, setNfcTagUid] = useState<string | null>(initial.nfcTagUid);
  const [bindBusy, setBindBusy] = useState(false);
  const [bindError, setBindError] = useState<string | null>(null);
  // Each entry names another active target sharing this UID and, when it's
  // a TaskDefinition, which location it belongs to (null for an
  // InventoryItemType match, or a pre-Locations row) — see
  // lib/task-definitions.ts's bindNfcTag.
  const [alsoBoundTo, setAlsoBoundTo] = useState<Array<{ name: string; locationName: string | null }>>([]);
  // Set when a bind attempt comes back 409 { reason: "unclaimed" } — see
  // docs/features/nfc.md's "Claiming". Surfaces a "Claim & Retry" action in
  // NfcBindingPanel instead of a dead-end error; null the rest of the time.
  const [unclaimedUid, setUnclaimedUid] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);

  async function bindUid(uid: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/task-definitions/${definitionId}/nfc-tag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body.reason === "unclaimed") {
          setUnclaimedUid(uid);
        } else {
          setUnclaimedUid(null);
        }
        setBindError(body.error || "Failed to bind tag");
        return false;
      }
      const body = await res.json();
      setNfcTagUid(uid);
      setAlsoBoundTo(body.alsoBoundTo ?? []);
      setUnclaimedUid(null);
      return true;
    } catch (err) {
      setUnclaimedUid(null);
      setBindError(err instanceof Error ? err.message : "Failed to bind tag");
      return false;
    }
  }

  async function handleScanToLink() {
    setBindError(null);
    setUnclaimedUid(null);
    if (!Capacitor.isNativePlatform()) {
      setBindError("Open the app on your phone to scan a tag.");
      return;
    }
    setBindBusy(true);
    const result = await scanNfcTag();
    if (result.status !== "ok") {
      setBindBusy(false);
      setBindError(result.status === "unsupported" ? "NFC isn't available on this device." : result.message);
      return;
    }
    await bindUid(result.uid);
    setBindBusy(false);
  }

  // Claims unclaimedUid for this manager's own location, then retries the
  // same bind — the recovery path for the "unclaimed" rejection above, see
  // docs/features/nfc.md's "Claiming".
  async function handleClaimAndLink() {
    if (!unclaimedUid) return;
    setClaiming(true);
    setBindError(null);
    const claimResult = await claimNfcTag(unclaimedUid);
    if (!claimResult.ok) {
      setBindError(claimResult.error);
      setClaiming(false);
      return;
    }
    await bindUid(unclaimedUid);
    setClaiming(false);
  }

  async function handleUnbindTag() {
    setBindBusy(true);
    setBindError(null);
    try {
      const res = await fetch(`/api/task-definitions/${definitionId}/nfc-tag`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to unbind tag");
      setNfcTagUid(null);
      setAlsoBoundTo([]);
    } catch (err) {
      setBindError(err instanceof Error ? err.message : "Failed to unbind tag");
    } finally {
      setBindBusy(false);
    }
  }

  // Instruction steps — see docs/features/task-completion-instructions.md.
  // The whole array is re-saved through PATCH /api/task-definitions/[id]
  // on every add/delete, same as formFields — no separate per-step
  // endpoint.
  const [instructionSteps, setInstructionSteps] = useState<DefinitionInstructionStep[]>(initial.instructionSteps);
  const [stepsBusy, setStepsBusy] = useState(false);
  const [stepsError, setStepsError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);

  async function saveInstructionSteps(next: Array<{ description: string | null; imageUrl: string | null }>): Promise<boolean> {
    setStepsBusy(true);
    setStepsError(null);
    try {
      const res = await fetch(`/api/task-definitions/${definitionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructionSteps: next }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to save");
      const body = await res.json();
      setInstructionSteps(body.instructionSteps ?? []);
      return true;
    } catch (err) {
      console.error("[task-definition-panel] instruction save failed:", err);
      setStepsError(err instanceof Error ? err.message : "Failed to save");
      return false;
    } finally {
      setStepsBusy(false);
    }
  }

  // Opens the device camera directly — see
  // docs/features/instruction-steps-camera-capture.md. Returns the captured
  // file, or null on cancel/denial/error (with captureError set for the
  // latter two).
  async function handleTakePhoto(): Promise<File | null> {
    setCaptureError(null);
    setCapturing(true);
    const result = await capturePhoto();
    setCapturing(false);
    if (result.status === "ok") return result.file;
    if (result.status === "denied") {
      setCaptureError("Camera access is off for Ch'rps — enable it in Settings to add a photo.");
    } else if (result.status === "error") {
      setCaptureError(result.message);
    }
    // "cancelled": no error, just nothing captured.
    return null;
  }

  async function handleAddStep({ description, file }: { description: string | null; file: File | null }): Promise<boolean> {
    setStepsBusy(true);
    setStepsError(null);
    let imageUrl: string | null = null;
    if (file) {
      if (!ALLOWED_UPLOAD_IMAGE_TYPES.includes(file.type)) {
        setStepsError(`"${file.type || "unknown"}" isn't a supported image type — use JPEG, PNG, or WEBP.`);
        setStepsBusy(false);
        return false;
      }
      if (file.size > MAX_UPLOAD_IMAGE_BYTES) {
        setStepsError(`That photo is ${(file.size / 1024 / 1024).toFixed(1)}MB — must be 8MB or smaller.`);
        setStepsBusy(false);
        return false;
      }
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "-");
      const pathname = `instruction-steps/${definitionId}-${Date.now()}-${safeName}`;
      try {
        imageUrl = await withUploadTimeout(
          uploadImageDirect(file, pathname),
          30000,
          "Upload timed out — check your connection and try again."
        );
      } catch (err) {
        console.error("[task-definition-panel] image upload failed:", err);
        setStepsError(err instanceof Error ? err.message : "Failed to upload image");
        setStepsBusy(false);
        return false;
      }
    }
    setStepsBusy(false);
    return saveInstructionSteps([
      ...instructionSteps.map((s) => ({ description: s.description, imageUrl: s.imageUrl })),
      { description, imageUrl },
    ]);
  }

  async function handleDeleteStep(index: number) {
    const next = instructionSteps
      .filter((_, i) => i !== index)
      .map((s) => ({ description: s.description, imageUrl: s.imageUrl }));
    await saveInstructionSteps(next);
  }

  // Require Photo at Completion — see docs/features/task-completion-photo.md.
  const [requiresPhoto, setRequiresPhoto] = useState(initial.requiresPhoto);
  const [requiresPhotoBusy, setRequiresPhotoBusy] = useState(false);

  async function handleToggleRequiresPhoto() {
    const next = !requiresPhoto;
    setRequiresPhotoBusy(true);
    setRequiresPhoto(next); // optimistic — reverted below on failure
    try {
      const res = await fetch(`/api/task-definitions/${definitionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requiresPhoto: next }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setRequiresPhoto(!next);
    } finally {
      setRequiresPhotoBusy(false);
    }
  }

  return {
    nfcTagUid,
    bindBusy,
    bindError,
    alsoBoundTo,
    unclaimedUid,
    claiming,
    handleScanToLink,
    handleUnbindTag,
    handleClaimAndLink,

    instructionSteps,
    stepsBusy,
    stepsError,
    capturing,
    captureError,
    handleTakePhoto,
    handleAddStep,
    handleDeleteStep,

    requiresPhoto,
    requiresPhotoBusy,
    handleToggleRequiresPhoto,
  };
}
