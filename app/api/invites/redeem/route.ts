import { NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import { resolveSessionUser } from "@/lib/session";
import { redeemInvite } from "@/lib/invites";

export const dynamic = "force-dynamic";

// Pulls the bare token out of either a pasted full invite URL
// (https://.../invite/<token>) or a raw token someone typed/copied by
// hand — see NoCompanyMessage.tsx's "Have an invite link?" field, the
// in-app alternative to opening /invite/[token] as a page (see
// docs/features/team-invites.md). Falls back to the trimmed input itself
// so a bare token still works.
function extractToken(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/\/invite\/([^/?#\s]+)/);
  return match ? match[1] : trimmed;
}

// POST /api/invites/redeem — same redemption rules as opening the link
// directly (app/invite/[token]/page.tsx), just reachable without leaving
// the app: a signed-in user stuck on NoCompanyMessage pastes their invite
// link/token here instead of switching to a browser tab or the Mail app.
export async function POST(req: Request) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { link } = (await req.json()) as { link?: string };
  if (!link?.trim()) {
    return NextResponse.json({ error: "Paste an invite link or code" }, { status: 400 });
  }

  await connectDB();

  const token = extractToken(link);
  const result = await redeemInvite(token, sessionUser);

  if (!result.ok) {
    const message =
      result.reason === "different-company"
        ? "You're already part of a different team — contact support to switch companies."
        : "That invite link isn't valid. Ask for a fresh one.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
