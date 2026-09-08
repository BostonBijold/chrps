import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import InventoryGroup from "@/models/InventoryGroup";
import { archiveInventoryGroup } from "@/lib/inventory";
import { resolveSessionUser, isManagerOrAbove, pickActiveLocationId } from "@/lib/session";
import { validateLocationId } from "@/lib/locations";

export const dynamic = "force-dynamic";

// PATCH /api/inventory-groups/[id] — rename. Manager-only. Scoped to the
// caller's own location — a group belongs to exactly one location, see
// docs/features/locations.md's "Location scoping".
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);

  const body = await req.json();
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });

  await connectDB();

  const group = await InventoryGroup.findOneAndUpdate(
    { _id: params.id, companyId, locationId },
    { $set: { name } },
    { returnDocument: "after" }
  );
  if (!group) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ _id: group._id.toString(), name: group.name });
}

// DELETE /api/inventory-groups/[id] — archive (soft delete). Manager-only.
// Ungroups every member InventoryItemType at this same location
// (groupId -> null) as part of the same request — see
// docs/features/inventory.md's "Grouping". Items and their InventoryLog
// history stay untouched.
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);

  await connectDB();

  const result = await archiveInventoryGroup(companyId, locationId, params.id);
  if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ ok: true, ungroupedCount: result.ungroupedCount });
}
