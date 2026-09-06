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
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });

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
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upload failed" },
      { status: 400 }
    );
  }
}
