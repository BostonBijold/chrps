import mongoose from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongoose";
import InventoryItemType from "@/models/InventoryItemType";
import InventoryGroup from "@/models/InventoryGroup";
import User from "@/models/User";
import Location from "@/models/Location";
import { getLatestInventoryLogs } from "@/lib/inventory";
import { resolveSessionUser, isManagerOrAbove, pickActiveLocationId } from "@/lib/session";
import { validateLocationId } from "@/lib/locations";

export const dynamic = "force-dynamic";

// GET /api/inventory-item-types?scope=own|company — a location's inventory
// catalog. Two modes (mirrors GET /api/task-definitions exactly — see
// docs/features/task-lists.md's "Company Task Catalog" section):
//
// - `scope=own` (default, unchanged access — any signed-in company user):
//   this location's own catalog, joined with each item's most recent
//   InventoryLog (the "current count") and that log's author's display
//   name, so the Inventory tab's list view (components/InventoryView.tsx)
//   needs no further round trips.
// - `scope=company` (new, manager-or-above only): a read-only browse of
//   EVERY location's item types in the company — "example data" a manager
//   can clone from for their own store (see POST /api/inventory-item-types'
//   cloneFromItemTypeId). nfcTagUid is always nulled out here regardless of
//   the stored value (not portable), and no live count/log data is
//   included (currentCount/lastLoggedAt/lastLoggedByName/belowPar) since
//   this is reference data, not this manager's own catalog to act on.
export async function GET(req: NextRequest) {
  const sessionUser = await resolveSessionUser();
  if (!sessionUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { companyId, role } = sessionUser;
  if (!companyId) return NextResponse.json({ error: "No company assigned" }, { status: 403 });

  await connectDB();

  const scope = req.nextUrl.searchParams.get("scope") === "company" ? "company" : "own";

  if (scope === "company") {
    if (!isManagerOrAbove(role)) return NextResponse.json({ error: "Managers only" }, { status: 403 });

    const itemTypes = await InventoryItemType.find({ companyId, isActive: true }).sort({ name: 1 }).lean();
    const locationIds = Array.from(new Set(itemTypes.map((it) => it.locationId).filter((id): id is string => !!id)));
    const locationNameById = new Map(
      locationIds.length > 0
        ? (await Location.find({ _id: { $in: locationIds } }, { name: 1 }).lean()).map((l) => [l._id.toString(), l.name])
        : []
    );

    return NextResponse.json(
      itemTypes.map((it) => ({
        _id: it._id.toString(),
        companyId,
        locationId: it.locationId ?? null,
        locationName: it.locationId ? locationNameById.get(it.locationId) ?? null : null,
        name: it.name,
        unit: it.unit ?? null,
        parLevel: it.parLevel ?? null,
        nfcTagUid: null,
        nfcRequiredToLog: false,
        groupId: null,
        currentCount: null,
        lastLoggedAt: null,
        lastLoggedByName: null,
        belowPar: false,
      }))
    );
  }

  const requestedLocationId = await validateLocationId(companyId, req.nextUrl.searchParams.get("locationId"));
  const locationId = pickActiveLocationId(sessionUser, requestedLocationId);

  const itemTypes = await InventoryItemType.find({ companyId, locationId, isActive: true }).sort({ name: 1 }).lean();
  const latestLogs = await getLatestInventoryLogs(companyId, locationId, itemTypes.map((it) => it._id));

  // Excludes SKIP_AUTH's non-ObjectId dev sentinel (same filter as
  // app/api/task-logs/history/route.ts's identical join) — User._id is a
  // real ObjectId schema type, so an unfiltered $in throws a CastError.
  const loggerIds = Array.from(new Set(Array.from(latestLogs.values()).map((l) => l.loggedByUserId))).filter((id) =>
    mongoose.isValidObjectId(id)
  );
  const loggers = loggerIds.length > 0 ? await User.find({ _id: { $in: loggerIds } }, "name").lean() : [];
  const loggerNameById = new Map(loggers.map((u) => [u._id.toString(), u.name ?? "Unknown"]));

  return NextResponse.json(
    itemTypes.map((it) => {
      const latest = latestLogs.get(it._id.toString());
      // Below par: latest logged count <= parLevel — see
      // docs/features/inventory.md's "Par-level alerting". parLevel: null
      // (or nothing logged yet) can never be below par.
      const belowPar = it.parLevel !== null && latest !== undefined && latest.count <= it.parLevel;
      return {
        _id: it._id.toString(),
        name: it.name,
        unit: it.unit ?? null,
        parLevel: it.parLevel ?? null,
        nfcTagUid: it.nfcTagUid ?? null,
        nfcRequiredToLog: it.nfcRequiredToLog ?? false,
        groupId: it.groupId ? it.groupId.toString() : null,
        currentCount: latest?.count ?? null,
        lastLoggedAt: latest ? new Date(latest.loggedAt).toISOString() : null,
        lastLoggedByName: latest ? loggerNameById.get(latest.loggedByUserId) ?? "Unknown" : null,
        belowPar,
      };
    })
  );
}

// POST /api/inventory-item-types — create a new catalog entry, one of two
// ways (mirrors POST /api/task-definitions' own cloneFromDefinitionId
// split):
//
// - `name`/`unit`/`parLevel`/`groupId` supplied (the existing
//   AddInventoryItemTypeSheet flow) — creates a brand-new item type at the
//   caller's own location.
// - `cloneFromItemTypeId` supplied — browse-to-clone an item type saved at
//   a DIFFERENT location (or anywhere in the company — see GET
//   /api/inventory-item-types?scope=company, "example data" other stores
//   can draw from). Creates a brand-new item type scoped to the caller's
//   own location, copying only the physically-portable fields (name/unit/
//   parLevel) — groupId/nfcTagUid/nfcRequiredToLog are never copied, since
//   a new store's groups are a different set and hasn't put up its own tag
//   yet.
//
// Manager-only, same gate as creating a TaskDefinition. NFC binding is a
// separate step (POST /api/inventory-item-types/[id]/nfc-tag, once the item
// exists) — mirrors the task catalog's own create-then-bind flow.
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

  await connectDB();

  let itemType;
  if (typeof body.cloneFromItemTypeId === "string" && body.cloneFromItemTypeId) {
    // Cross-location clone — deliberately NO locationId filter on this
    // lookup (that's the whole point: browsing another store's, or the
    // company's, catalog as example data). See the comment above.
    const source = await InventoryItemType.findOne({ _id: body.cloneFromItemTypeId, companyId, isActive: true });
    if (!source) return NextResponse.json({ error: "Item type not found in catalog" }, { status: 404 });
    itemType = await InventoryItemType.create({
      companyId,
      locationId,
      name: source.name,
      unit: source.unit,
      parLevel: source.parLevel,
      groupId: null,
      nfcTagUid: null,
      createdByUserId: userId,
    });
  } else {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });
    const unit = typeof body.unit === "string" && body.unit.trim() ? body.unit.trim() : null;
    const parLevel = typeof body.parLevel === "number" && Number.isFinite(body.parLevel) ? body.parLevel : null;
    const groupId = typeof body.groupId === "string" && body.groupId ? body.groupId : null;

    if (groupId) {
      if (!mongoose.isValidObjectId(groupId)) {
        return NextResponse.json({ error: "Invalid groupId" }, { status: 400 });
      }
      // A group is location-owned too — a groupId from a different
      // location is silently invalid, same "not found" treatment as any
      // other cross-tenant reference. See docs/features/locations.md's
      // "Location scoping".
      const group = await InventoryGroup.findOne({ _id: groupId, companyId, locationId }).select("_id").lean();
      if (!group) return NextResponse.json({ error: "Invalid groupId" }, { status: 400 });
    }

    itemType = await InventoryItemType.create({
      companyId,
      locationId,
      name,
      unit,
      parLevel,
      groupId,
      createdByUserId: userId,
    });
  }

  return NextResponse.json({
    _id: itemType._id.toString(),
    name: itemType.name,
    unit: itemType.unit,
    parLevel: itemType.parLevel,
    nfcTagUid: itemType.nfcTagUid,
    nfcRequiredToLog: itemType.nfcRequiredToLog,
    groupId: itemType.groupId ? itemType.groupId.toString() : null,
    currentCount: null,
    lastLoggedAt: null,
    lastLoggedByName: null,
    belowPar: false,
  });
}
