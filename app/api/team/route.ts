import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import User from "@/models/User";
import { resolveSessionUser, isOwner } from "@/lib/session";

export const dynamic = "force-dynamic";

const ROLE_RANK: Record<string, number> = { owner: 0, manager: 1, employee: 2 };

// GET /api/team — the read-only roster, open to any signed-in company
// member (not manager-gated). Managers first, then alphabetical by name.
// Location filtering (see docs/features/locations.md's "Location
// switcher") is opt-in and owner-only: sessionUser.activeLocationId is
// read directly here rather than through pickActiveLocationId, since this
// route's own "no override" default (show the WHOLE company, unfiltered)
// has always differed from every other page's ("fall back to my own
// location") — a non-owner's activeLocationId is always null anyway, so
// this has no effect on employee/manager, unchanged from before this
// field existed.
export async function GET() {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role, activeLocationId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });

  await connectDB();

  // Unlike every other model's companyId (plain String — see CLAUDE.md's
  // Multi-Tenancy section), User.companyId is Mongoose-typed as ObjectId.
  // SKIP_AUTH's dev sentinel company id isn't a valid ObjectId and would
  // otherwise make this query throw a cast error — same defensive pattern
  // as lib/task-list-session-actions.ts's getOpenSessionLocks(). No real
  // company ever has that id, so there's nothing to find either way.
  const query: Record<string, unknown> = { companyId };
  // Gate on role, not just presence: activeLocationId is meant to be
  // owner-only (set exclusively by the owner-gated PATCH
  // /api/session/active-location), but nothing clears it if a hand-edit in
  // MongoDB later demotes that user away from "owner" — a stale value would
  // otherwise silently filter this manager/employee's own roster down to
  // one location.
  if (isOwner(role) && activeLocationId) query.locationId = activeLocationId;
  const users = mongoose.isValidObjectId(companyId)
    ? await User.find(query, "name image role createdAt companyJoinedAt locationId jobTags").lean()
    : [];
  users.sort((a, b) => (ROLE_RANK[a.role] ?? 1) - (ROLE_RANK[b.role] ?? 1) || (a.name ?? "").localeCompare(b.name ?? ""));

  return NextResponse.json(
    users.map((u) => ({
      _id: u._id.toString(),
      name: u.name ?? "Unnamed",
      image: u.image ?? null,
      role: u.role,
      // Pre-existing users attached to a company by hand (before this
      // feature existed) have no companyJoinedAt — fall back to account
      // creation as the closest available signal.
      joinedAt: u.companyJoinedAt ?? u.createdAt ?? null,
      // Additive field for the Admin Console's Team table (see
      // docs/features/admin-console.md's Phase 1b) — its per-row location
      // dropdown needs each member's current assignment. Ignored by the
      // mobile TeamView, which has never read this field.
      locationId: u.locationId ? u.locationId.toString() : null,
      // Additive field for the console's job-tags assignment UI (see
      // docs/features/locations.md's "Job tags") — ignored by mobile.
      jobTags: u.jobTags ?? [],
    }))
  );
}
