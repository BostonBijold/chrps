import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongoose";
import JobTag from "@/models/JobTag";
import User from "@/models/User";
import { resolveSessionUser, isManagerOrAbove } from "@/lib/session";

export const dynamic = "force-dynamic";

// GET /api/job-tags — the company's active job-tag catalog. Open to any
// signed-in company user, same as /api/inventory-groups — a future
// mobile assignment UI would read this too, not just the console.
export async function GET() {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });

  await connectDB();

  const tags = await JobTag.find({ companyId, isActive: true }).sort({ createdAt: 1 }).lean();

  // userCount — how many active company teammates currently hold each
  // tag. Powers the Task Management tag picker's "no one currently holds
  // this tag" hint (see
  // docs/features/notification-job-tag-targeting.md's tag-picker section)
  // so a manager can see up front that a tag-scoped list's reminder would
  // reach nobody, without cross-referencing the Team page separately.
  const counts = new Map<string, number>();
  if (mongoose.isValidObjectId(companyId)) {
    const rows = await User.aggregate([
      { $match: { companyId: new mongoose.Types.ObjectId(companyId), jobTags: { $in: tags.map((t) => t.name) } } },
      { $unwind: "$jobTags" },
      { $group: { _id: "$jobTags", count: { $sum: 1 } } },
    ]);
    for (const row of rows) counts.set(row._id, row.count);
  }

  return NextResponse.json(
    tags.map((t) => ({ _id: t._id.toString(), name: t.name, userCount: counts.get(t.name) ?? 0 }))
  );
}

// POST /api/job-tags — create a tag. Manager-only, same gate as
// /api/inventory-groups.
export async function POST(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role, userId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const body = await req.json();
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });

  await connectDB();

  const existing = await JobTag.findOne({ companyId, name, isActive: true }).lean();
  if (existing) return NextResponse.json({ error: "That tag already exists" }, { status: 409 });

  const tag = await JobTag.create({ companyId, name, createdByUserId: userId });

  return NextResponse.json({ _id: tag._id.toString(), name: tag.name });
}
