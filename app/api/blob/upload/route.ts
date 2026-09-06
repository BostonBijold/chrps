import { NextRequest, NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { resolveSessionUser, isManagerOrAbove } from "@/lib/session";

export const dynamic = "force-dynamic";

// POST /api/blob/upload — issues a short-lived client-upload token so a
// manager's browser can push instruction-step image bytes straight to
// Vercel Blob, never through this server's own request body (keeps image
// uploads off Vercel's serverless payload limits). Manager-or-above only.
// See docs/features/task-completion-instructions.md's "Blob upload flow".
// Generic — companyId is stamped into the pathname so more upload
// call-sites can reuse this one token route later without collisions.
export async function POST(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) {
    console.error("[blob/upload] rejected: no session");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { companyId, role } = sessionUser;
  if (!companyId) {
    console.error("[blob/upload] rejected: session has no companyId");
    return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  }
  if (!isManagerOrAbove(role)) {
    console.error(`[blob/upload] rejected: role "${role}" is not manager-or-above`);
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  }

  const body = (await req.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ["image/jpeg", "image/png", "image/webp"],
        maximumSizeInBytes: 5 * 1024 * 1024, // 5MB
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
