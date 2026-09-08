import { Schema, Document, model, models } from "mongoose";

// A manager-defined organizational label for InventoryItemTypes — "Freezer,"
// "Cold Storage," "Dry Storage," "Bar." Purely organizational: no NFC tag of
// its own, no par level of its own — see docs/features/inventory.md's
// "Grouping". Archiving a group does NOT archive its items; see
// lib/inventory.ts's archiveInventoryGroup, which sets every member item's
// groupId back to null ("Ungrouped") as part of the same request.
export interface IInventoryGroup extends Document {
  companyId: string;
  // Owned by exactly one Location, same as InventoryItemType — a group is
  // an organizational container for that location's own physical space
  // ("Freezer" at Location A has nothing to do with "Freezer" at Location
  // B), so it gets no cross-location browse/clone the way an item type
  // does. See docs/features/locations.md's "Location scoping". null only
  // for a pre-migration row until scripts/backfill-inventory-locations.mjs
  // runs.
  locationId: string | null;
  name: string;
  createdByUserId: string;
  // Soft-delete/archive — same convention as InventoryItemType.isActive.
  isActive: boolean;
}

const InventoryGroupSchema = new Schema<IInventoryGroup>(
  {
    companyId: { type: String, required: true, index: true },
    locationId: { type: String, default: null, index: true },
    name: { type: String, required: true },
    createdByUserId: { type: String, required: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default models.InventoryGroup || model<IInventoryGroup>("InventoryGroup", InventoryGroupSchema);
