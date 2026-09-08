import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import InventoryGroup from "@/models/InventoryGroup";
import { resolveSessionUser, isManagerOrAbove, pickActiveLocationId } from "@/lib/session";
import { validateLocationId } from "@/lib/locations";

export const dynamic = "force-dynamic";

// GET /api/inventory-groups — the caller's own location's active groups,
// for the Inventory tab's section list and the group picker in
// AddInventoryItemTypeSheet.tsx. Open to any signed-in company user, same
// as the item-type catalog itself — see docs/features/inventory.md's
// "Grouping". Location-owned, same as InventoryItemType — see
// docs/features/locations.md's "Location scoping".
export async function GET(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });

  await connectDB();

  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);

  const groups = await InventoryGroup.find({ companyId, locationId, isActive: true }).sort({ createdAt: 1 }).lean();

  return NextResponse.json(groups.map((g) => ({ _id: g._id.toString(), name: g.name })));
}

// POST /api/inventory-groups — create a group at the caller's own location.
// Manager-only. Also reachable inline from AddInventoryItemTypeSheet.tsx's
// "+ New Group" option, same create-inline pattern used elsewhere for
// lightweight catalog creation.
export async function POST(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role, userId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);
  if (!locationId) return NextResponse.json({ error: "No location assigned" }, { status: 403 });

  const body = await req.json();
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });

  await connectDB();

  const group = await InventoryGroup.create({ companyId, locationId, name, createdByUserId: userId });

  return NextResponse.json({ _id: group._id.toString(), name: group.name });
}
