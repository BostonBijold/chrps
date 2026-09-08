import mongoose, { Schema, Document, model, models } from "mongoose";

// "Arm, then tap" NFC linking: a manager tapping "Link a Physical Tag" in
// Manage Task List upserts one of these, then physically taps an unclaimed
// tag — app/nfc/[tagCode]/page.tsx checks for a fresh row here to know
// which task a cold tap should claim the tag for. One per user (a manager
// is only ever holding one tag at a time). Treated as stale and ignored if
// armedAt is older than a few minutes at read time — see
// PENDING_LINK_MAX_AGE_MS in app/nfc/[tagCode]/page.tsx — no TTL index
// needed for correctness, just hygiene.
export interface IPendingNfcLink extends Document {
  userId: string;
  companyId: string;
  // Stamped from the armed Task's own resolved locationId at arm time —
  // lets the eventual claim step assert the claiming manager's own
  // resolved location still matches what was armed, defensive against an
  // owner switching locations between arming and physically tapping.
  locationId: string | null;
  taskId: mongoose.Types.ObjectId;
  armedAt: Date;
}

const PendingNfcLinkSchema = new Schema<IPendingNfcLink>({
  userId: { type: String, required: true, unique: true, index: true },
  companyId: { type: String, required: true },
  locationId: { type: String, default: null },
  taskId: { type: Schema.Types.ObjectId, ref: "Task", required: true },
  armedAt: { type: Date, required: true, default: () => new Date() },
});

export default models.PendingNfcLink || model<IPendingNfcLink>("PendingNfcLink", PendingNfcLinkSchema);
