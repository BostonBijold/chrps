import NfcTag from "@/models/NfcTag";

// The NFC tag registry — see docs/features/nfc.md's "Provisioning" and
// "Claiming". Two workflows:
//   - provisionNfcTag: us, before a tag ships (POST /api/admin/nfc-tags/provision)
//   - claimNfcTag: the customer — called directly by lib/task-definitions.ts's
//     bindNfcTag and lib/inventory.ts's bindInventoryNfcTag as the first thing
//     either does, so a manager's first "Scan to Link" on a fresh tag claims
//     it for their own company/location AND binds it in one step, no
//     separate claim UI/action at all. Idempotent, so a tag already claimed
//     by this same company/location just passes through.

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

// Called at the top of bindNfcTag/bindInventoryNfcTag — manager-or-above,
// company+location-scoped, same as those. Idempotent when the tag is
// already claimed by this exact company + location (a second manager
// binding the same tag to a different task, or a retry).
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
