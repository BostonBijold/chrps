import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import { bindInventoryNfcTag, unbindInventoryNfcTag } from "@/lib/inventory";
import { resolveSessionUser, isManagerOrAbove, pickActiveLocationId } from "@/lib/session";
import { validateLocationId } from "@/lib/locations";
import { NfcTagNotRecognizedError, NfcTagClaimedElsewhereError } from "@/lib/nfc-tags";

export const dynamic = "force-dynamic";

// POST /api/inventory-item-types/[id]/nfc-tag — binds a physical tag's raw
// UID to an item type's storage location — see docs/features/nfc.md's
// "Multi-target binding". Mirrors app/api/task-definitions/[id]/nfc-tag:
// same manager-only gate, same locationId scoping now that InventoryItemType
// is location-owned too (see docs/features/locations.md's "Location
// scoping"), same "never fails because the UID is already used elsewhere"
// behavior (that's the entire point of Part 1's model — the same freezer
// tag legitimately backs both a task and this item type).
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role, userId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);

  const { uid } = await req.json();
  if (!uid || typeof uid !== "string") {
    return NextResponse.json({ error: "Missing uid" }, { status: 400 });
  }

  await connectDB();

  let bound;
  try {
    bound = await bindInventoryNfcTag(companyId, locationId, userId, params.id, uid);
  } catch (err) {
    if (err instanceof NfcTagNotRecognizedError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof NfcTagClaimedElsewhereError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
  if (!bound) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ nfcTagUid: bound.itemType.nfcTagUid, alsoBoundTo: bound.alsoBoundTo });
}

// DELETE /api/inventory-item-types/[id]/nfc-tag — unbind. Manager-only.
// Only ever clears this item type's own binding — see docs/features/nfc.md's
// "Multi-target binding" on why unbinding is deliberately panel-scoped.
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });
  if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);

  await connectDB();

  const itemType = await unbindInventoryNfcTag(companyId, locationId, params.id);
  if (!itemType) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ ok: true });
}
