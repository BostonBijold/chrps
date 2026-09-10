import { Schema, model, models } from "mongoose";

// The NFC tag registry — see docs/features/nfc.md's "Provisioning" and
// "Claiming". Replaces the old tagCode/Universal-Link "tap-to-trigger"
// NfcTag shape entirely (removed along with the rest of that system, see
// the doc's "History: Tap-to-trigger (removed)" section) — this is a
// closed-loop registry keyed by the tag's own raw hardware UID (the same
// value already used by the in-app scan-to-complete binding,
// TaskDefinition.nfcTagUid/InventoryItemType.nfcTagUid), not an
// app-generated tagCode.
//
// A UID must exist here and be `claimed` by the binder's own company +
// location before lib/task-definitions.ts's bindNfcTag / lib/inventory.ts's
// bindInventoryNfcTag will let it be bound to anything — this is what
// closes the hole where any NFC tag from anywhere could be scanned and
// bound to a task with no check it was ever a real Ch'rps tag.
export type NfcTagStatus = "unclaimed" | "claimed" | "retired";

export interface INfcTag {
  // Raw hardware UID, lowercase hex — the registry key. Factory-burned,
  // read-only; this app never writes to a tag, only reads via
  // NFCTagReaderSession (see lib/native/nfc-scan.ts).
  uid: string;
  status: NfcTagStatus;
  // Plain String, not an ObjectId ref — same convention as every other
  // location-owned collection's companyId (see CLAUDE.md's Multi-Tenancy
  // section and models/Location.ts). null until claimed.
  companyId: string | null;
  // A tag is single-company, single-location — many tasks/item types can
  // still share one UID (TaskDefinition.nfcTagUid /
  // InventoryItemType.nfcTagUid are many-to-one pointers at this uid,
  // unchanged by this registry). null until claimed.
  locationId: string | null;
  claimedByUserId: string | null;
  claimedAt: Date | null;
  // Optional manager-given name/photo — fields exist so a later pass can
  // build tag-management UI without a migration, but nothing sets or reads
  // these yet (v1 scope explicitly left this inert).
  label: string | null;
  imageUrl: string | null;
  // Stamped on every successful assertNfcVerified/assertInventoryNfcVerified
  // match (task completion or inventory log) — see
  // lib/task-log-actions.ts/lib/inventory.ts. Answers "do we lose tags" /
  // "when was this last actually scanned" from the admin side, cheaply.
  lastUsedAt: Date | null;
  lastUsedByUserId: string | null;
}

const NfcTagSchema = new Schema<INfcTag>(
  {
    uid: { type: String, required: true, unique: true, index: true },
    status: { type: String, enum: ["unclaimed", "claimed", "retired"], default: "unclaimed" },
    companyId: { type: String, default: null, index: true },
    locationId: { type: String, default: null },
    claimedByUserId: { type: String, default: null },
    claimedAt: { type: Date, default: null },
    label: { type: String, default: null },
    imageUrl: { type: String, default: null },
    lastUsedAt: { type: Date, default: null },
    lastUsedByUserId: { type: String, default: null },
  },
  { timestamps: true }
);

NfcTagSchema.index({ companyId: 1, locationId: 1 });

export default models.NfcTag || model<INfcTag>("NfcTag", NfcTagSchema);
