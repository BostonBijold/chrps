import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import User from "@/models/User";
import Location from "@/models/Location";
import JobTag from "@/models/JobTag";
import { resolveSessionUser, isManagerOrAbove, isOwner } from "@/lib/session";

export const dynamic = "force-dynamic";

// Unlike every other model's companyId (plain String — see CLAUDE.md's
// Multi-Tenancy section), User.companyId is Mongoose-typed as ObjectId, and
// params.userId feeds straight into a User _id lookup too. Neither
// SKIP_AUTH's dev sentinel ids (see lib/session.ts) nor a malformed userId
// param are valid ObjectIds, and would otherwise make every query below
// throw a cast error instead of just not matching — same defensive pattern
// as lib/task-list-session-actions.ts's getOpenSessionLocks(). No real
// document could ever match either id, so this is just an earlier, cleaner
// 404 than the cast error would have produced.
function isAddressable(companyId: string, userId: string) {
  return mongoose.isValidObjectId(companyId) && mongoose.isValidObjectId(userId);
}

// PATCH /api/team/[userId] — manager changes a teammate's role. Blocked if
// it would demote the company's last remaining manager — a company with
// zero managers is a lockout state nobody can recover from through the UI.
export async function PATCH(req: Request, { params }: { params: { userId: string } }) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role: sessionRole } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(sessionRole)) return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const { role, locationId, jobTags } = (await req.json()) as {
    role?: string;
    locationId?: string;
    jobTags?: string[];
  };
  // All three fields are optional independently — a request may carry any
  // subset — but at least one must be present.
  if (role === undefined && locationId === undefined && jobTags === undefined) {
    return NextResponse.json({ error: "role, locationId, or jobTags required" }, { status: 400 });
  }
  if (role !== undefined && role !== "employee" && role !== "manager") {
    return NextResponse.json({ error: "role must be 'employee' or 'manager'" }, { status: 400 });
  }
  // Reassigning a teammate between locations is owner-only (see
  // docs/features/locations.md's "Location assignment") — a location-bound
  // manager has no visibility into other locations by definition, so they
  // can't meaningfully be the one to move someone into one.
  if (locationId !== undefined && !isOwner(sessionRole)) {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }
  // Job tags are orthogonal to location visibility — any manager can tag
  // their own teammates, same gate as the role change above (see
  // docs/features/locations.md's "Job tags").
  if (jobTags !== undefined && !Array.isArray(jobTags)) {
    return NextResponse.json({ error: "jobTags must be an array" }, { status: 400 });
  }

  if (!isAddressable(companyId, params.userId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await connectDB();

  const target = await User.findOne({ _id: params.userId, companyId }, "role").lean<{ role?: string }>();
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (locationId !== undefined) {
    const location = await Location.findOne({ _id: locationId, companyId, isActive: true }).lean();
    if (!location) return NextResponse.json({ error: "Location not found" }, { status: 404 });
  }

  if (jobTags !== undefined && jobTags.length > 0) {
    const validTags = await JobTag.find({ companyId, name: { $in: jobTags }, isActive: true }, "name").lean();
    if (validTags.length !== new Set(jobTags).size) {
      return NextResponse.json({ error: "One or more job tags are invalid" }, { status: 400 });
    }
  }

  // An owner is a strict superset of manager (see docs/features/locations.md),
  // and `developer` a strict superset of owner again (see
  // docs/features/nfc.md's "Provisioning") — neither can be created or
  // changed through this employee/manager-only toggle, and only an owner
  // (or developer) may touch a fellow owner/developer's role at all.
  if ((target.role === "owner" || target.role === "developer") && !isOwner(sessionRole)) {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }

  if (role === "employee" && target.role === "manager") {
    // A company with at least one owner is never locked out even at zero
    // managers — an owner already administers everything a manager can.
    const [managerCount, ownerCount] = await Promise.all([
      User.countDocuments({ companyId, role: "manager" }),
      User.countDocuments({ companyId, role: "owner" }),
    ]);
    if (managerCount <= 1 && ownerCount === 0) {
      return NextResponse.json({ error: "Can't demote the last manager" }, { status: 400 });
    }
  }

  const updates: Record<string, unknown> = {};
  if (role !== undefined) updates.role = role;
  if (locationId !== undefined) updates.locationId = locationId;
  if (jobTags !== undefined) updates.jobTags = Array.from(new Set(jobTags));
  await User.findOneAndUpdate({ _id: params.userId, companyId }, { $set: updates });

  return NextResponse.json({ ok: true });
}

// DELETE /api/team/[userId] — manager removes a teammate from the company.
// A soft company-detach (companyId/role cleared back to the "not yet
// provisioned" state a brand-new sign-in sees), not an account deletion —
// their historical TaskLogs etc. stay scoped to the company they belonged
// to at the time. Same last-manager guard as PATCH above.
export async function DELETE(req: Request, { params }: { params: { userId: string } }) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role: sessionRole } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(sessionRole)) return NextResponse.json({ error: "Managers only" }, { status: 403 });

  if (!isAddressable(companyId, params.userId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await connectDB();

  const target = await User.findOne({ _id: params.userId, companyId }, "role").lean<{ role?: string }>();
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if ((target.role === "owner" || target.role === "developer") && !isOwner(sessionRole)) {
    return NextResponse.json({ error: "Owners only" }, { status: 403 });
  }

  if (target.role === "manager") {
    // Same owner-covers-the-lockout reasoning as PATCH above.
    const [managerCount, ownerCount] = await Promise.all([
      User.countDocuments({ companyId, role: "manager" }),
      User.countDocuments({ companyId, role: "owner" }),
    ]);
    if (managerCount <= 1 && ownerCount === 0) {
      return NextResponse.json({ error: "Can't remove the last manager" }, { status: 400 });
    }
  } else if (target.role === "owner") {
    const ownerCount = await User.countDocuments({ companyId, role: "owner" });
    if (ownerCount <= 1) {
      return NextResponse.json({ error: "Can't remove the last owner" }, { status: 400 });
    }
  }

  await User.findOneAndUpdate(
    { _id: params.userId, companyId },
    { $set: { companyId: null, role: null, companyJoinedAt: null, locationId: null } }
  );

  return NextResponse.json({ ok: true });
}
