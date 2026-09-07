import Invite from "@/models/Invite";
import User from "@/models/User";
import type { SessionUser } from "@/lib/session";

export type RedeemInviteResult =
  | { ok: true; alreadyMember: boolean }
  | { ok: false; reason: "invalid" | "different-company" };

// Shared by app/invite/[token]/page.tsx (open the link directly — works
// signed-out too, via /login?callbackUrl=/invite/<token>) and
// app/api/invites/redeem/route.ts (paste the link into NoCompanyMessage
// while already signed in — see docs/features/team-invites.md). Same
// validity checks and the same atomic increment-with-filter so a
// maxUses:1 link can't be double-redeemed regardless of which path
// consumed it.
export async function redeemInvite(token: string, sessionUser: SessionUser): Promise<RedeemInviteResult> {
  const { userId, companyId } = sessionUser;

  const invite = await Invite.findOne({ token }).lean();

  // Not found, revoked, expired, or already maxed out — don't distinguish
  // *why* to the caller, no useful info for the recipient and it avoids
  // leaking this invite's internal state to whoever holds the link.
  const isInvalid =
    !invite ||
    !!invite.revokedAt ||
    invite.expiresAt.getTime() <= Date.now() ||
    invite.useCount >= invite.maxUses;
  if (isInvalid) return { ok: false, reason: "invalid" };

  // Already part of a *different* company — never silently reassign someone.
  if (companyId && companyId !== invite.companyId) {
    return { ok: false, reason: "different-company" };
  }

  // Already redeemed this exact invite (double-tap, refresh) — idempotent,
  // no double-increment.
  if (companyId && companyId === invite.companyId) {
    return { ok: true, alreadyMember: true };
  }

  const redeemed = await Invite.findOneAndUpdate(
    {
      token,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
      $expr: { $lt: ["$useCount", "$maxUses"] },
    },
    { $inc: { useCount: 1 } }
  ).lean();

  if (!redeemed) return { ok: false, reason: "invalid" };

  await User.findByIdAndUpdate(userId, {
    $set: {
      companyId: redeemed.companyId,
      role: redeemed.role,
      companyJoinedAt: new Date(),
      // Stamped from the invite, never picked by whoever redeems it — see
      // docs/features/locations.md's "Location assignment". Null only for
      // an invite created before Locations shipped.
      locationId: redeemed.locationId ?? null,
    },
  });

  return { ok: true, alreadyMember: false };
}
