> **Keep this file updated after any code change in this area — do not let it drift from actual implementation.**

# Instruction Steps — Camera Capture

**Status: BUILT.** Supersedes the "upload-from-file-picker only" line in [`task-completion-instructions.md`](task-completion-instructions.md) — the manager's "+ Add Step" editor now opens the device camera directly via `@capacitor/camera`, **replacing** the file-picker input rather than sitting alongside it. Built as a shared, reusable capture helper (not instruction-steps-specific) so the employee-side completion-photo feature (see that doc's "Sets up for") can call the same function later rather than re-solving this.

Two real problems come with switching from a file picker to a live camera, both addressed here:

1. **Token expiry** — `POST /api/blob/upload`'s client-upload token defaulted to a 30-second `validUntil`. A file picker upload starts near-instantly since the photo's already chosen; a camera flow adds real time — permission prompt, framing, a possible retake, confirming — that can easily exceed 30 seconds.
2. **File size** — the same route capped uploads at 5MB. An actual, uncompressed phone camera photo routinely lands above that. Solved client-side via the Camera plugin's built-in resize/quality options, not by just raising the server cap — keeps Blob storage cost bounded regardless of the phone's sensor resolution.

## Shared capture helper

`lib/client/capture-image.ts`, deliberately not under an instruction-steps-specific path:

```ts
export type CapturePhotoResult =
  | { status: "ok"; file: File }
  | { status: "cancelled" }
  | { status: "denied" }
  | { status: "error"; message: string };

export async function capturePhoto(): Promise<CapturePhotoResult> { ... }
```

Uses `Camera.getPhoto({ source: CameraSource.Camera, resultType: CameraResultType.Uri, quality: 80, width: 1600, correctOrientation: true })` — `CameraSource.Camera` is what makes this camera-only (no "choose from library" fallback), matching the decision to replace the file picker rather than add a second option. `getPhoto` is the older of `@capacitor/camera` v8's two capture APIs (v8.1 added a `takePhoto`/`MediaResult` pair meant to eventually replace it) but was kept deliberately: it's the one with a stable, documented single-dimension resize (`width` alone, aspect ratio preserved automatically), where `takePhoto`'s replacement `targetWidth`/`targetHeight` pair's single-dimension behavior isn't clearly documented. `width: 1600`/`quality: 80` is a starting point (a reference photo of a clean kitchen doesn't need full sensor resolution) — worth a quick real-device check to confirm output file size lands comfortably under the server cap (see below) across a couple of phone models, not just the simulator.

The plugin's `webPath` result is `fetch()`ed into a `Blob`, then **wrapped in a `File`** (`new File([blob], \`photo-${Date.now()}.jpg\`, { type: "image/jpeg" })`) rather than returned as a bare `Blob` — the calling code's existing validation (`file.type`, `file.size`) and Blob-pathname-from-filename logic were written for the old `<input type="file">` flow's `File` objects, and a bare `Blob` has no `.name` those needed. Returning a `File` meant zero changes to that downstream logic beyond swapping what produces it.

**Result handling, not exceptions**: `capturePhoto()` never throws — permission-denied and user-cancel are both promise rejections from `Camera.getPhoto()` on iOS, distinguished only by matching the rejection's message text (`/denied|permission/i` vs `/cancel/i`, since Capacitor doesn't expose a typed error code for either). Returning a discriminated result instead of re-throwing keeps that fragile string-matching contained to one place rather than leaking into every call site's `catch` block.

## `POST /api/blob/upload` changes

`app/api/blob/upload/route.ts`'s `onBeforeGenerateToken`:

- **`validUntil`**: extended from the default 30 seconds to `Date.now() + 5 * 60 * 1000` (5 minutes) — comfortably covers a manager fumbling with the shot, still short enough to not be a meaningful concern on a manager-gated endpoint.
- **`maximumSizeInBytes`**: bumped from 5MB to 8MB as a safety-net backstop, not the primary defense — the real size control is the client-side resize in `capturePhoto()`; this just covers a browser/OS edge case where the resize step is skipped or fails.

`lib/client/upload-image.ts`'s `MAX_UPLOAD_IMAGE_BYTES` mirrors the new 8MB cap for the same client-side-fail-fast reason described in [`task-completion-instructions.md`](task-completion-instructions.md) — shared by both this feature's `ManageTasksView.tsx` caller and [`task-completion-photo.md`](task-completion-photo.md)'s `TaskPhotoCaptureButton.tsx`. No change to `allowedContentTypes` — camera-captured JPEGs already fall under the existing `image/jpeg` allowance.

## Manager UI change

In the "+ Add Step" inline editor (`ManageTaskDetailSheet.tsx`, wired up from `ManageTasksView.tsx`'s `CatalogRow`): the file-picker `<input type="file">` is replaced with a single **"Take Photo"** button (`handleTakePhoto`) that calls `capturePhoto()` and, on success, sets the draft step's file the same way the old file-input's `onChange` did — the rest of the draft flow (description field, the "at least one of description/imageUrl" validation rule via `canAddDraft`, the 3-step cap, `confirmAddStep` calling `instructions.onAddStep`) is unchanged.

- **Permission denied** (`status: "denied"`) shows "Camera access is off for Ch'rps — enable it in Settings to add a photo." inline in the draft editor (`captureError` state), rather than a silent failure or a raw stack trace.
- **User cancels the camera sheet** (`status: "cancelled"`) shows nothing — the draft editor just stays open with no error, same as backing out of a file picker used to do.
- **Any other capture error** (`status: "error"`) shows the raw message inline, same treatment as the existing `instructions.error` (upload/save failures).
- The button and the "Add" confirm button both disable while `capturing` is true, alongside the existing `instructions.busy` gate.

## iOS permission (App Store requirement)

`@capacitor/camera` is installed (`package.json`) and synced into the iOS project (`npx cap sync ios` — see `ios/App/CapApp-SPM/Package.swift`'s plugin list). `ios/App/App/Info.plist` has an `NSCameraUsageDescription` entry, worded to cover both this feature and [`task-completion-photo.md`](task-completion-photo.md)'s employee capture rather than instruction steps alone (Apple review checks that this string actually matches what the camera is used for): *"Ch'rps uses the camera to attach reference and completion photos to tasks."* — matching the existing `NFCReaderUsageDescription` entry's convention.

## Open questions / deferred

- **Exact `width`/`quality` tuning** — 1600px / 80 quality is a reasonable starting point, not a measured one; worth a quick check on actual output file sizes from a real device before considering this final.
- **Android** — not addressed here since the current tech stack is iOS-only (Capacitor iOS wrapper); `@capacitor/camera` is cross-platform so this should carry over cleanly if Android ever gets added, but that's untested by this doc.
- **`getPhoto` deprecation** — `@capacitor/camera` v8.1 marks `getPhoto` deprecated in favor of `takePhoto`/`chooseFromGallery`. Kept for now (see "Shared capture helper" above); worth revisiting if a future major version actually removes it.

## Depends on

[`task-completion-instructions.md`](task-completion-instructions.md) — the step editor and `POST /api/blob/upload` route this modifies. This doc's `capturePhoto()` helper is written to be reused, not extended per-feature — [`task-completion-photo.md`](task-completion-photo.md) is the employee-side completion-photo feature that reuses it.
