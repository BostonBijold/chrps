import mongoose from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import InventoryItemType from "@/models/InventoryItemType";
import InventoryLog from "@/models/InventoryLog";
import User from "@/models/User";
import { assertInventoryNfcVerified, InventoryNfcRequiredError } from "@/lib/inventory";
import { resolveSessionUser, pickActiveLocationId } from "@/lib/session";
import { validateLocationId } from "@/lib/locations";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;

// GET /api/inventory-logs?itemTypeId=<id>&limit=<n> — an item type's count
// history, newest first. Doubles as both the item detail screen's "current
// count" (logs[0]) and its recent-history list — see
// docs/features/inventory.md. Open to any signed-in company user.
export async function GET(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });

  const itemTypeId = req.nextUrl.searchParams.get("itemTypeId");
  if (!itemTypeId) return NextResponse.json({ error: "Missing itemTypeId" }, { status: 400 });
  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Math.min(Math.max(Number(limitParam) || DEFAULT_LIMIT, 1), 100) : DEFAULT_LIMIT;

  await connectDB();

  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);

  const logs = await InventoryLog.find({ companyId, locationId, itemTypeId })
    .sort({ loggedAt: -1 })
    .limit(limit)
    .lean();

  // Excludes SKIP_AUTH's non-ObjectId dev sentinel (same filter as
  // app/api/task-logs/history/route.ts's identical join) — User._id is a
  // real ObjectId schema type, so an unfiltered $in throws a CastError.
  const loggerIds = Array.from(new Set(logs.map((l) => l.loggedByUserId))).filter((id) => mongoose.isValidObjectId(id));
  const loggers = loggerIds.length > 0 ? await User.find({ _id: { $in: loggerIds } }, "name").lean() : [];
  const loggerNameById = new Map(loggers.map((u) => [u._id.toString(), u.name ?? "Unknown"]));

  return NextResponse.json(
    logs.map((l) => ({
      _id: l._id.toString(),
      count: l.count,
      loggedAt: new Date(l.loggedAt).toISOString(),
      loggedByUserId: l.loggedByUserId,
      loggedByName: loggerNameById.get(l.loggedByUserId) ?? "Unknown",
      verifiedNfcUid: l.verifiedNfcUid ?? null,
    }))
  );
}

// POST /api/inventory-logs — log a new count. Open to any signed-in company
// user (not manager-gated) — "anyone logs the current count when they
// check/restock," see docs/features/inventory.md. Append-only: this always
// creates a new row, even for a manager correcting a bad prior entry —
// there is no edit path, same as TaskLog's own history.
//
// verifiedNfcUid is only required when the item type has opted into
// nfcRequiredToLog (default false) — see docs/features/inventory.md's "NFC
// enforcement" and lib/inventory.ts's assertInventoryNfcVerified, which
// mirrors assertNfcVerified for tasks. Otherwise an item type's nfcTagUid
// (if bound) is a shortcut/verification, not a gate: a supplied uid is only
// ever stored as "verified" when it actually matches this item type's own
// bound tag — a stray or mismatched value is silently dropped rather than
// rejecting the whole log.
export async function POST(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, userId } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });

  const body = await req.json();
  const itemTypeId = typeof body.itemTypeId === "string" ? body.itemTypeId : null;
  const count = typeof body.count === "number" && Number.isFinite(body.count) ? body.count : null;
  if (!itemTypeId || count === null) {
    return NextResponse.json({ error: "itemTypeId and count are required" }, { status: 400 });
  }
  const claimedUid = typeof body.verifiedNfcUid === "string" ? body.verifiedNfcUid.toLowerCase() : null;
  const requestedLocationId = typeof body.locationId === "string" ? body.locationId : null;

  await connectDB();
  const locationId = pickActiveLocationId(sessionUser, await validateLocationId(companyId, requestedLocationId));

  // locationId-scoped — InventoryItemType is location-owned (see
  // docs/features/inventory.md's "Location scoping"), so a count can only
  // ever be logged against an item that actually belongs to the acting
  // location, same as every other item-type lookup in this file's sibling
  // routes.
  const itemType = await InventoryItemType.findOne({ _id: itemTypeId, companyId, locationId, isActive: true }).lean();
  if (!itemType) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    await assertInventoryNfcVerified(itemTypeId, claimedUid);
  } catch (err) {
    if (err instanceof InventoryNfcRequiredError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }

  const verifiedNfcUid = claimedUid && itemType.nfcTagUid && claimedUid === itemType.nfcTagUid ? claimedUid : null;

  const log = await InventoryLog.create({
    companyId,
    locationId,
    itemTypeId,
    count,
    loggedByUserId: userId,
    loggedAt: new Date(),
    verifiedNfcUid,
  });

  return NextResponse.json({
    _id: log._id.toString(),
    count: log.count,
    loggedAt: log.loggedAt.toISOString(),
    verifiedNfcUid: log.verifiedNfcUid,
  });
}
