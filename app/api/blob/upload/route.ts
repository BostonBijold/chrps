import { NextRequest, NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { resolveSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

// POST /api/blob/upload — issues a short-lived client-upload token so a
// browser can push task-image bytes straight to Vercel Blob, never through
// this server's own request body (keeps image uploads off Vercel's
// serverless payload limits). Any authenticated employee of the company —
// not manager-or-above only. Originally built manager-only for instruction-
// step authoring (see docs/features/task-completion-instructions.md), then
// loosened once docs/features/task-completion-photo.md needed the same
// route for an employee's own completion photo: the actual gate that
// matters (who can edit a TaskDefinition's instructionSteps vs. who can
// complete a task) already lives on the routes that consume the resulting
// URL, not here. Generic — companyId is stamped into the pathname so more
// upload call-sites can reuse this one token route later without
// collisions.
export async function POST(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) {
    console.error("[blob/upload] rejected: no session");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { companyId } = sessionUser;
  if (!companyId) {
    console.error("[blob/upload] rejected: session has no companyId");
    return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  }

  const body = (await req.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ["image/jpeg", "image/png", "image/webp"],
        // 8MB backstop, not the primary defense — the real size control is
        // lib/client/capture-image.ts's client-side resize/quality options;
        // this just covers a browser/OS edge case where that step is
        // skipped or fails. See docs/features/instruction-steps-camera-capture.md.
        maximumSizeInBytes: 8 * 1024 * 1024,
        // Vercel's client-upload token defaults to a 30s validUntil — fine
        // for a file-picker upload (the photo's already chosen) but a live
        // camera flow adds real time (permission prompt, framing, a
        // possible retake) that can easily exceed it. 5 minutes comfortably
        // covers fumbling with the shot on this employee-of-the-company-gated
        // endpoint.
        validUntil: Date.now() + 5 * 60 * 1000,
        addRandomSuffix: true,
        tokenPayload: JSON.stringify({ companyId }),
      }),
    });
    return NextResponse.json(jsonResponse);
  } catch (err) {
    // @vercel/blob's client-side upload() discards this response body on
    // any non-2xx status — it only ever surfaces a generic "Failed to
    // retrieve the client token" in the browser, regardless of what
    // actually failed here (missing BLOB_READ_WRITE_TOKEN, a bad
    // onBeforeGenerateToken payload, etc.). Logging server-side is the
    // only way to see the real cause — check Vercel's Runtime Logs for
    // this route.
    console.error("[blob/upload] handleUpload failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upload failed" },
      { status: 400 }
    );
  }
}
