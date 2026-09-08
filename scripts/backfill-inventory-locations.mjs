// One-off, manually-run script — NOT wired into app boot. Extends
// scripts/backfill-locations.mjs's original Locations rollout to the
// Inventory catalog layer (InventoryItemType/InventoryGroup), which shipped
// company-wide-only and is now becoming location-owned — see CLAUDE.md's
// "Inventory"/"Locations" sections and docs/features/locations.md's
// (formerly) "Known gaps". Direct copy of scripts/backfill-task-catalog-
// locations.mjs's own pattern, one layer over.
//
//   node --env-file=.env.local scripts/backfill-inventory-locations.mjs
//
// (swap .env.local for whatever env file / secrets source holds MONGODB_URI
// in the target environment).
//
// MUST run after scripts/backfill-locations.mjs (needs every company to
// already have a resolvable primary Location) and MUST complete before the
// app ships code that relies on InventoryItemType/InventoryGroup's new
// locationId-aware scoping — Mongoose builds indexes lazily on first model
// use, so simply running this before that code serves production traffic
// is enough.
//
// Migration decision (same as the task-catalog fix): every company's
// EXISTING shared InventoryItemType/InventoryGroup data is assigned to that
// company's PRIMARY location only (its "Main Location", or an owner/
// manager's own locationId as a fallback). Any OTHER existing active
// Location under that company gets NOTHING carried over — a manager there
// just adds their own item types/groups from scratch (with "From Other
// Locations" available as a cloning shortcut once this script has run),
// exactly like a brand-new Location created after this migration runs.
// This script deliberately does not clone or touch data for any location
// other than the primary.
//
// Idempotent — every step only touches documents that don't already have a
// locationId, so it's safe to re-run.

import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is not set. Run with: node --env-file=.env.local scripts/backfill-inventory-locations.mjs");
  process.exit(1);
}

const DEFAULT_LOCATION_NAME = "Main Location";

const client = new MongoClient(uri);
await client.connect();
const db = client.db();
const companies = db.collection("companies");
const locations = db.collection("locations");
const users = db.collection("users");
const inventoryItemTypes = db.collection("inventoryitemtypes");
const inventoryGroups = db.collection("inventorygroups");

const allCompanies = await companies.find({}).toArray();
console.log(`Found ${allCompanies.length} compan${allCompanies.length === 1 ? "y" : "ies"}.`);

// Resolve each company's primary location: its "Main Location" (created by
// the original backfill-locations.mjs, or by hand under the same name), or
// failing that, an owner/manager's own locationId. A company with neither
// is skipped entirely — nothing to backfill onto; a manager there just adds
// item types/groups fresh at whichever location they're viewing.
const primaryLocationIdByCompany = new Map();
let skipped = 0;

for (const company of allCompanies) {
  const companyId = company._id.toString();

  let location = await locations.findOne({ companyId, name: DEFAULT_LOCATION_NAME });
  if (!location) {
    const managerUser = await users.findOne({
      companyId: company._id,
      role: { $in: ["owner", "manager"] },
      locationId: { $ne: null },
    });
    if (managerUser?.locationId) {
      location = { _id: managerUser.locationId };
    }
  }

  if (!location) {
    console.warn(`  ${companyId} (${company.companyName ?? "unnamed"}) -> no resolvable primary location, skipping.`);
    skipped++;
    continue;
  }

  primaryLocationIdByCompany.set(companyId, location._id.toString());
}
console.log(`Resolved a primary location for ${primaryLocationIdByCompany.size} compan${primaryLocationIdByCompany.size === 1 ? "y" : "ies"} (${skipped} skipped).`);

// String locationId here, same convention as companyId on every one of
// these collections (see CLAUDE.md's Multi-Tenancy section) — not an
// ObjectId.
async function backfillCollection(collection, label) {
  let total = 0;
  for (const [companyId, locationId] of primaryLocationIdByCompany) {
    const result = await collection.updateMany(
      { companyId, locationId: null },
      { $set: { locationId } }
    );
    total += result.modifiedCount;
  }
  console.log(`Backfilled locationId onto ${total} ${label} row${total === 1 ? "" : "s"}.`);
}

await backfillCollection(inventoryItemTypes, "InventoryItemType");
await backfillCollection(inventoryGroups, "InventoryGroup");

console.log("Done. Safe to deploy app code that relies on InventoryItemType/InventoryGroup's new locationId scoping.");
await client.close();
