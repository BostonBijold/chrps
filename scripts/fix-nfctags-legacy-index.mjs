// One-off, manually-run script — NOT wired into app boot. Fixes a
// production error hit provisioning a second NFC tag after the registry
// rework (see docs/features/nfc.md's "The tag registry"): the live
// `nfctags` collection still carries the OLD tap-to-trigger schema's
// unique index on `tagCode` (models/NfcTag.ts no longer has that field at
// all), so a second new-shape document — which never sets `tagCode`, so
// it's implicitly `null` — collides with the first on that stale index
// ("E11000 duplicate key error ... tagCode_1 dup key: { tagCode: null }").
// Mongoose never drops an index just because a schema changed.
//
//   node --env-file=.env.local scripts/fix-nfctags-legacy-index.mjs
//
// Drops the stale `tagCode_1` index only — does NOT touch any documents.
// Safe to re-run (no-ops if the index is already gone). The app will
// re-create the correct new indexes (`uid_1` unique, `{companyId,locationId}`)
// on its own the next time the NfcTag model is used, same as any other
// Mongoose index.

import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is not set. Run with: node --env-file=.env.local scripts/fix-nfctags-legacy-index.mjs");
  process.exit(1);
}

const client = new MongoClient(uri);

async function main() {
  await client.connect();
  const db = client.db();
  const collection = db.collection("nfctags");

  const indexes = await collection.indexes();
  const stale = indexes.find((idx) => idx.name === "tagCode_1");

  if (!stale) {
    console.log("No stale tagCode_1 index found — nothing to do.");
    return;
  }

  await collection.dropIndex("tagCode_1");
  console.log("Dropped stale tagCode_1 index on nfctags.");
}

main()
  .catch((err) => {
    console.error("Failed:", err);
    process.exitCode = 1;
  })
  .finally(() => client.close());
