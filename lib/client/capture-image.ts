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
//
// resultType is Base64, not Uri: an earlier Uri-based version returned
// photo.webPath and converted it via fetch(photo.webPath).blob() — that
// works fine for the default local capacitor://localhost webview, but this
// app loads its content from a remote origin instead (capacitor.config.ts's
// server.url), and a live https: page fetching a local file: resource is
// blocked as mixed content. @capacitor/camera's own webPath doc comment
// only promises it's usable as an <img> src (the WebView's native resource
// loader, not the page's own fetch()) — never actually documented as
// fetch()-able. That fetch rejected, uncaught, which hung the caller
// forever (setCapturing never ran) instead of surfacing an error. Base64
// sidesteps this: the image comes back as plain data on the JS side, no
// second network/scheme-dependent read required.
export async function capturePhoto(): Promise<CapturePhotoResult> {
  let photo;
  try {
    photo = await Camera.getPhoto({
      source: CameraSource.Camera,
      resultType: CameraResultType.Base64,
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

  if (!photo.base64String) {
    return { status: "error", message: "Camera returned no image data." };
  }
  // Everything past this point is synchronous, local decoding — no fetch,
  // no dependency on how the webview's document origin/scheme is set up.
  // Wrapped in try/catch (unlike the old fetch-based version, whose
  // rejection was never caught) so any decode failure surfaces as a normal
  // {status: "error"} result instead of an unhandled rejection that leaves
  // the caller's "capturing" state stuck forever.
  try {
    const byteString = atob(photo.base64String);
    const bytes = new Uint8Array(byteString.length);
    for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i);
    // Wrapped in a File (not returned as a bare Blob) so the calling code's
    // existing type/size validation and Blob pathname-from-filename logic —
    // written for the old <input type="file"> flow — need no changes beyond
    // swapping what produces the file.
    const file = new File([bytes], `photo-${Date.now()}.jpg`, { type: "image/jpeg" });
    return { status: "ok", file };
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : "Failed to process the captured photo." };
  }
}
