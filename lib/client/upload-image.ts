// Shared direct-to-Blob upload helper — originally built inline in
// components/ManageTasksView.tsx for instruction-step images (see
// docs/features/task-completion-instructions.md), extracted here once
// docs/features/task-completion-photo.md's TaskPhotoCaptureButton needed
// the identical upload path for an employee's own completion photo.
//
// Deliberately bypasses @vercel/blob/client's upload() — that SDK call was
// silently retrying a 400 (its getBlobError() falls back to a retryable
// "unknown_error" classification whenever a response body doesn't parse
// into its exact expected shape, which masked the real failure behind up
// to 10 retries with exponential backoff) and never surfaced the actual
// reason. This replicates just the two requests upload() makes internally
// — token retrieval via our own /api/blob/upload route, then the PUT to
// Vercel's Blob API — with no retries, so any failure's real response text
// reaches the UI on the first attempt.

// Mirrors app/api/blob/upload/route.ts's onBeforeGenerateToken constraints
// exactly — checking client-side first turns an oversized/wrong-type photo
// into an immediate, specific error message instead of a round-trip to
// Vercel Blob that comes back as a generic 400. In practice a captured
// photo is already resized well under this by lib/client/capture-image.ts;
// this cap is the backstop, matching the server's own.
export const MAX_UPLOAD_IMAGE_BYTES = 8 * 1024 * 1024;
export const ALLOWED_UPLOAD_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

export async function uploadImageDirect(file: File, pathname: string): Promise<string> {
  const tokenRes = await fetch("/api/blob/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "blob.generate-client-token",
      payload: { pathname, clientPayload: null, multipart: false },
    }),
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.json().catch(() => ({}));
    throw new Error(body.error || `Token request failed (${tokenRes.status})`);
  }
  const { clientToken } = (await tokenRes.json()) as { clientToken: string };
  const storeId = clientToken.split("_")[3] ?? "";

  const params = new URLSearchParams({ pathname });
  const putRes = await fetch(`https://vercel.com/api/blob/?${params.toString()}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${clientToken}`,
      "x-content-type": file.type,
      "x-api-version": "12",
      "x-vercel-blob-store-id": storeId,
      "x-api-blob-request-id": `${storeId}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      "x-api-blob-request-attempt": "0",
    },
    body: file,
  });
  if (!putRes.ok) {
    const text = await putRes.text().catch(() => "");
    throw new Error(`Blob upload failed (${putRes.status}): ${text.slice(0, 300) || "no response body"}`);
  }
  const json = (await putRes.json()) as { url: string };
  return json.url;
}

// 30s cap on the Blob upload — without this, a hung request (bad token,
// network stall, a browser-bundling quirk in @vercel/blob/client) leaves
// the caller's busy state stuck true forever with no error ever surfacing,
// since a promise that never settles never reaches either the try's
// success path or the catch. Better to fail loud after a timeout than hang
// silently.
export function withUploadTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
