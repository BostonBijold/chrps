import NfcTag from "@/models/NfcTag";

// The NFC tag registry — see docs/features/nfc.md's "Provisioning" and
// "Claiming". Two workflows, cleanly separated:
//   - provisionNfcTag: us, before a tag ships (POST /api/admin/nfc-tags/provision)
//   - claimNfcTag: the customer, once they have the physical tag
//     (POST /api/nfc-tags/claim)
// requireClaimedTag is the actual gate — lib/task-definitions.ts's
// bindNfcTag and lib/inventory.ts's bindInventoryNfcTag both call it before
// writing a UID onto a TaskDefinition/InventoryItemType.

export class NfcTagAlreadyProvisionedError extends Error {
  constructor() {
    super("This tag is already provisioned.");
    this.name = "NfcTagAlreadyProvisionedError";
  }
}

export class NfcTagNotRecognizedError extends Error {
  constructor() {
    super("Not a recognized Ch'rps tag.");
    this.name = "NfcTagNotRecognizedError";
  }
}

// Deliberately generic — matches the old tap-to-trigger system's wording
// style (see docs/features/nfc.md's "Claiming"): never reveals which other
// company/location already holds a tag.
export class NfcTagClaimedElsewhereError extends Error {
  constructor() {
    super("This tag is already linked to another company.");
    this.name = "NfcTagClaimedElsewhereError";
  }
}

// Thrown by requireClaimedTag below — distinct message from the above so a
// manager knows to claim first rather than just retrying the scan.
export class NfcTagNotClaimedError extends Error {
  constructor() {
    super("This tag hasn't been claimed for your location yet — claim it first.");
    this.name = "NfcTagNotClaimedError";
  }
}

function normalize(uid: string) {
  return uid.toLowerCase();
}

// POST /api/admin/nfc-tags/provision — developer-only, not company-scoped
// (a provisioned tag has no companyId yet). Rejects a UID that's already in
// the registry in any state, including retired — re-provisioning isn't a
// thing, a tag either exists here or it doesn't.
export async function provisionNfcTag(uid: string) {
  const normalized = normalize(uid);
  const existing = await NfcTag.findOne({ uid: normalized }).lean();
  if (existing) throw new NfcTagAlreadyProvisionedError();
  return NfcTag.create({ uid: normalized, status: "unclaimed" });
}

// POST /api/nfc-tags/claim — manager-or-above, company+location-scoped.
// Idempotent when the tag is already claimed by this exact company +
// location (a second manager scanning the same tag, or a retry).
export async function claimNfcTag(companyId: string, locationId: string | null, userId: string, uid: string) {
  const normalized = normalize(uid);
  const tag = await NfcTag.findOne({ uid: normalized });
  if (!tag) throw new NfcTagNotRecognizedError();

  if (tag.status === "claimed") {
    if (tag.companyId === companyId && tag.locationId === locationId) return tag; // already theirs
    throw new NfcTagClaimedElsewhereError();
  }
  if (tag.status === "retired") throw new NfcTagClaimedElsewhereError();

  tag.status = "claimed";
  tag.companyId = companyId;
  tag.locationId = locationId;
  tag.claimedByUserId = userId;
  tag.claimedAt = new Date();
  await tag.save();
  return tag;
}

// The actual gate — called by bindNfcTag/bindInventoryNfcTag before either
// ever writes a UID onto a TaskDefinition/InventoryItemType. A single
// message covers every rejection reason (not found, unclaimed, or claimed
// by a different company/location) — same non-disclosure precedent as
// NfcTagClaimedElsewhereError above, and the manager-facing fix is
// identical either way: claim it for this location first.
export async function requireClaimedTag(companyId: string, locationId: string | null, uid: string) {
  const normalized = normalize(uid);
  const tag = await NfcTag.findOne({ uid: normalized }).lean();
  if (!tag || tag.status !== "claimed" || tag.companyId !== companyId || tag.locationId !== locationId) {
    throw new NfcTagNotClaimedError();
  }
}

// Stamped on every successful assertNfcVerified/assertInventoryNfcVerified
// match — see lib/task-log-actions.ts / lib/inventory.ts. Best-effort: a
// UID that was bound before this registry existed, or that somehow isn't
// registered, just silently matches nothing here (updateOne on a missing
// doc is a no-op) rather than blocking the completion it's confirming.
export async function stampNfcTagUsage(uid: string, userId: string) {
  await NfcTag.updateOne(
    { uid: normalize(uid) },
    { $set: { lastUsedAt: new Date(), lastUsedByUserId: userId } }
  );
}
