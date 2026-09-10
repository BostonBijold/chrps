import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { connectDB } from "@/lib/mongoose";
import clientPromise from "@/lib/mongodb-client";
import User from "@/models/User";
import PushToken from "@/models/PushToken";
import { resolveSessionUser, isOwner } from "@/lib/session";
import { signOut } from "@/lib/auth";

export const dynamic = "force-dynamic";

// DELETE /api/account — self-service account deletion (App Store Review
// Guideline 5.1.1(v)). Self only: always acts on the caller's own session,
// never a userId in the body/URL. Scrubs PII off this User document and
// kills their ability to sign back in; every TaskLog/TaskListSession/
// InventoryLog they created stays exactly where it is, still attributable
// to the company/location it happened at — see
// docs/features/account-deletion.md.
export async function DELETE() {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // The owner is the billing contact and, in a single-owner company, the
  // only account that can administer every location — scrubbing that User
  // doesn't touch Stripe or hand off administration to anyone. Routed to a
  // human instead of a self-service path. `developer` (a strict superset
  // of owner, see docs/features/nfc.md's "Provisioning") is blocked the
  // same way — an internal, hand-managed account, never meant to be
  // self-deleted through this flow either.
  if (isOwner(sessionUser.role)) {
    return NextResponse.json(
      { error: "Owners can't self-delete — contact contact@usechrps.com" },
      { status: 403 }
    );
  }

  await connectDB();

  // Same last-manager-or-owner guard PATCH/DELETE /api/team/[userId]
  // already enforce — self-deleting shouldn't be able to leave a company
  // with zero people who can administer it.
  if (sessionUser.companyId && sessionUser.role === "manager") {
    const [managerCount, ownerCount] = await Promise.all([
      User.countDocuments({ companyId: sessionUser.companyId, role: "manager" }),
      User.countDocuments({ companyId: sessionUser.companyId, role: "owner" }),
    ]);
    if (managerCount <= 1 && ownerCount === 0) {
      return NextResponse.json({ error: "Can't remove the last manager" }, { status: 400 });
    }
  }

  const { userId } = sessionUser;

  await User.findByIdAndUpdate(userId, {
    $set: {
      name: "Deleted User",
      // The adapter's unique index on email means this can't just go null.
      email: `deleted-${userId}@deleted.usechrps.com`,
      image: null,
      companyId: null,
      role: null,
      companyJoinedAt: null,
      locationId: null,
      liveActivityPushToken: null,
      liveActivityPushEnvironment: null,
      passwordHash: null,
      deletedAt: new Date(),
    },
  });

  await PushToken.deleteMany({ userId });

  // Unlinks Google OAuth and drops any database-backed session rows — the
  // adapter stores userId as ObjectId on both, see
  // node_modules/@auth/mongodb-adapter's own deleteUser.
  const client = await clientPromise;
  const db = client.db();
  const objectId = new ObjectId(userId);
  await Promise.all([
    db.collection("accounts").deleteMany({ userId: objectId }),
    db.collection("sessions").deleteMany({ userId: objectId }),
  ]);

  // Clears this response's session cookie so the client doesn't hold a
  // now-invalid session past this request. lib/auth.ts's jwt callback
  // covers any JWT already issued to another device/session.
  await signOut({ redirect: false });

  return NextResponse.json({ ok: true });
}
