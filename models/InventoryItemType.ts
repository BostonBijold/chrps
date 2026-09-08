import mongoose, { Schema, Document, model, models } from "mongoose";

// The manager-defined catalog entry for something a location keeps a
// running count of — toilet paper, cases of meat, ice packs. Owned by
// exactly one Location (see locationId below), same as TaskDefinition —
// see docs/features/locations.md's "Location scoping". NOT a decrement
// ledger: nothing in the app subtracts from this automatically when a task
// completes (see docs/features/inventory.md's "Why not
// decrement-on-task-completion"). The "current count" for an item type,
// wherever shown, is just its most recent InventoryLog row — see that
// model — this document only holds the catalog entry itself.
export interface IInventoryItemType extends Document {
  companyId: string;
  // Owned by exactly one Location — mirrors TaskDefinition.locationId: an
  // item type's NFC binding is a physical tag stuck at one store, so the
  // catalog entry itself belongs to one store too, not the whole company.
  // null only for a pre-migration row until scripts/backfill-inventory-
  // locations.mjs runs. See docs/features/locations.md's "Location
  // scoping".
  locationId: string | null;
  name: string;
  unit: string | null;      // free-text display label ("rolls", "cases", "lbs") — display only, never used in a calculation
  parLevel: number | null;  // informational only in this pass — no low-stock alerting yet, see docs/features/inventory.md
  // Raw hardware UID (lowercase hex) of a physical NFC tag bound to this
  // item type's storage location — see docs/features/nfc.md's "Multi-target
  // binding". Optional: an item type can be logged purely by hand with no
  // tag at all. Unlike TaskDefinition.nfcTagUid, binding this one never
  // GATES logging a count — it's a shortcut/verification, never a
  // requirement, so there is no inventory equivalent of assertNfcVerified.
  nfcTagUid: string | null;
  createdByUserId: string;
  // Soft-delete/archive — same convention as TaskDefinition.isActive, kept
  // consistent rather than the timestamp-based `archivedAt` field name
  // floated when this model was speced, so historical InventoryLog rows
  // stay meaningful without introducing a second archival convention.
  isActive: boolean;
  // Ref InventoryGroup, or null for the implicit "Ungrouped" bucket — one
  // group per item, matching how it actually sits in one physical place.
  // See docs/features/inventory.md's "Grouping".
  groupId: mongoose.Types.ObjectId | null;
  // Manager-controlled per item, default false (matches every pre-existing
  // row's actual behavior). When true, logging a count REQUIRES a scan of
  // this item's own nfcTagUid — see lib/inventory.ts's
  // assertInventoryNfcVerified. Unlike nfcTagUid this isn't a binding
  // lifecycle, just a boolean — no separate bind/unbind endpoint.
  nfcRequiredToLog: boolean;
}

const InventoryItemTypeSchema = new Schema<IInventoryItemType>(
  {
    // Company's shared configuration — same reasoning as TaskList.companyId
    // for why this stays a plain String rather than an ObjectId ref.
    companyId: { type: String, required: true, index: true },
    locationId: { type: String, default: null, index: true },
    name: { type: String, required: true },
    unit: { type: String, default: null },
    parLevel: { type: Number, default: null },
    nfcTagUid: { type: String, default: null },
    createdByUserId: { type: String, required: true },
    isActive: { type: Boolean, default: true },
    groupId: { type: Schema.Types.ObjectId, ref: "InventoryGroup", default: null },
    nfcRequiredToLog: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export default models.InventoryItemType || model<IInventoryItemType>("InventoryItemType", InventoryItemTypeSchema);
