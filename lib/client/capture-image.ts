import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";

// Shared camera-capture helper — deliberately not instruction-steps-specific
// (hence lib/client/ rather than a components/ file) so the employee-side
// completion-photo feature can call the same function later instead of
// re-solving this. See docs/features/instruction-steps-camera-capture.md.
export type CapturePhotoResult =
  | { status: "ok"; file: File }
  | { status: "cancelled" } // user backed out of the camera sheet — not an error
  | { status: "denied" } // camera permission declined (prompt or OS-level)
  | { status: "error"; message: string };

// CameraSource.Camera forces the live camera with no "choose from library"
// fallback — this replaces the old file-picker input rather than adding a
// second option alongside it. quality/width are a starting point to keep a
// reference photo comfortably under POST /api/blob/upload's size cap
// without relying on the server cap alone — see that route's own comment.
export async function capturePhoto(): Promise<CapturePhotoResult> {
  let photo;
  try {
    photo = await Camera.getPhoto({
      source: CameraSource.Camera,
      resultType: CameraResultType.Uri,
      quality: 80,
      width: 1600,
      correctOrientation: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Capacitor's iOS implementation rejects with this exact wording for
    // both a declined permission prompt and a previously-denied OS setting;
    // a plain user cancel (backing out of the camera sheet) rejects with
    // "User cancelled photos app" instead — surfaced as `cancelled`, not an
    // error, so the caller can just close back to its own UI silently.
    if (/denied|permission/i.test(message)) return { status: "denied" };
    if (/cancel/i.test(message)) return { status: "cancelled" };
    return { status: "error", message };
  }

  if (!photo.webPath) {
    return { status: "error", message: "Camera returned no image data." };
  }
  const response = await fetch(photo.webPath);
  const blob = await response.blob();
  // Wrapped in a File (not returned as a bare Blob) so the calling code's
  // existing type/size validation and Blob pathname-from-filename logic —
  // written for the old <input type="file"> flow — need no changes beyond
  // swapping what produces the file.
  const file = new File([blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" });
  return { status: "ok", file };
}
