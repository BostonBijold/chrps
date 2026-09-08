import mongoose from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import InventoryItemType from "@/models/InventoryItemType";
import InventoryGroup from "@/models/InventoryGroup";
import { resolveSessionUser, isManagerOrAbove, pickActiveLocationId } from "@/lib/session";
import { validateLocationId } from "@/lib/locations";

export const dynamic = "force-dynamic";

// GET /api/inventory-item-types/[id] — single item type, for the detail/log
// screen's server-rendered page (app/(app)/inventory/[itemTypeId]/page.tsx).
// Open to any signed-in company user, same as the list route. Scoped to the
// caller's own location — an item type belongs to exactly one location, see
// docs/features/locations.md's "Location scoping".
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });

  await connectDB();

  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);

  const itemType = await InventoryItemType.findOne({ _id: params.id, companyId, locationId, isActive: true }).lean();
  if (!itemType) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    _id: itemType._id.toString(),
    name: itemType.name,
    unit: itemType.unit ?? null,
    parLevel: itemType.parLevel ?? null,
    nfcTagUid: itemType.nfcTagUid ?? null,
    nfcRequiredToLog: itemType.nfcRequiredToLog ?? false,
    entryMode: itemType.entryMode ?? "text",
    groupId: itemType.groupId ? itemType.groupId.toString() : null,
  });
}

// PATCH /api/inventory-item-types/[id] — edit name/unit/parLevel/groupId/
// nfcRequiredToLog/entryMode. Manager-only. NFC binding (the tag itself) has
// its own route (./nfc-tag), same split as TaskDefinition — groupId,
// nfcRequiredToLog, and entryMode are plain fields here, not a binding
// lifecycle, see docs/features/inventory.md's "Grouping" and "NFC
// enforcement".
const EDITABLE_FIELDS = ["name", "unit", "parLevel", "groupId", "nfcRequiredToLog", "entryMode"] as const;

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);

  const body = await req.json();
  const updates: Partial<Record<(typeof EDITABLE_FIELDS)[number], unknown>> = {};
  for (const key of EDITABLE_FIELDS) if (key in body) updates[key] = body[key];

  if ("name" in updates) {
    const name = typeof updates.name === "string" ? updates.name.trim() : "";
    if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });
    updates.name = name;
  }
  if ("unit" in updates) {
    updates.unit = typeof updates.unit === "string" && updates.unit.trim() ? updates.unit.trim() : null;
  }
  if ("parLevel" in updates) {
    updates.parLevel = typeof updates.parLevel === "number" && Number.isFinite(updates.parLevel) ? updates.parLevel : null;
  }
  if ("nfcRequiredToLog" in updates) {
    updates.nfcRequiredToLog = updates.nfcRequiredToLog === true;
  }
  if ("entryMode" in updates) {
    updates.entryMode = updates.entryMode === "stepper" ? "stepper" : "text";
  }

  await connectDB();

  if ("groupId" in updates) {
    const groupId = typeof updates.groupId === "string" && updates.groupId ? updates.groupId : null;
    if (groupId) {
      if (!mongoose.isValidObjectId(groupId)) {
        return NextResponse.json({ error: "Invalid groupId" }, { status: 400 });
      }
      // A group is location-owned too — see the same check in POST
      // /api/inventory-item-types.
      const group = await InventoryGroup.findOne({ _id: groupId, companyId, locationId }).select("_id").lean();
      if (!group) return NextResponse.json({ error: "Invalid groupId" }, { status: 400 });
    }
    updates.groupId = groupId;
  }

  const itemType = await InventoryItemType.findOneAndUpdate(
    { _id: params.id, companyId, locationId },
    { $set: updates },
    { returnDocument: "after" }
  );
  if (!itemType) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    _id: itemType._id.toString(),
    name: itemType.name,
    unit: itemType.unit,
    parLevel: itemType.parLevel,
    nfcTagUid: itemType.nfcTagUid,
    nfcRequiredToLog: itemType.nfcRequiredToLog,
    entryMode: itemType.entryMode,
    groupId: itemType.groupId ? itemType.groupId.toString() : null,
  });
}

// DELETE /api/inventory-item-types/[id] — archive (soft delete). Manager-
// only. No "still in use" block like TaskDefinition's — an item type has no
// placement concept to check, and historical InventoryLog rows stay valid
// (and readable — they carry their own count/loggedAt) once archived, same
// as an archived TaskDefinition's TaskLog history stays intact.
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);

  await connectDB();

  const itemType = await InventoryItemType.findOne({ _id: params.id, companyId, locationId });
  if (!itemType) return NextResponse.json({ error: "Not found" }, { status: 404 });

  itemType.isActive = false;
  await itemType.save();

  return NextResponse.json({ ok: true });
}
