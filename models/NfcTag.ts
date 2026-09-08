import mongoose, { Schema, Document, model, models } from "mongoose";

// A physical NFC tag, pre-manufactured with a URL of the form
// https://<domain>/nfc/<tagCode> written to it by an external NFC writer
// app — this app never writes tags itself. tagCode is generated ahead of
// time (see scripts/generate-nfc-tags.mjs) and exists as an unclaimed row
// before any task owns it. A separate collection (not a field on Task) so
// one task can have multiple tags pointing at it — e.g. a tag by the
// walk-in and one by the prep line, both starting the same task.
//
// Scoped by companyId, not a user: a tag belongs to the restaurant's shared
// task configuration, same as Task/TaskList — any employee on shift can
// trigger an already-linked tag (see lib/task-trigger.ts's triggerTask()),
// matching the rest of the app's "any employee can complete any task"
// model. claimedByUserId is attribution only (who set the tag up), not an
// ownership/access restriction.
export interface INfcTag extends Document {
  tagCode: string;
  companyId: string | null;
  // Stamped from the claimed Task's own resolved locationId at claim time
  // (never straight from the claiming user's session) — a physical tag is
  // an address at one store, same reasoning as TaskDefinition.locationId.
  // null while unclaimed, same lifecycle as companyId.
  locationId: string | null;
  taskId: mongoose.Types.ObjectId | null;
  taskListId: mongoose.Types.ObjectId | null;
  claimedByUserId: string | null;
  claimedAt: Date | null;
}

const NfcTagSchema = new Schema<INfcTag>(
  {
    tagCode: { type: String, required: true, unique: true, index: true },
    companyId: { type: String, default: null, index: true },
    locationId: { type: String, default: null },
    taskId: { type: Schema.Types.ObjectId, ref: "Task", default: null },
    taskListId: { type: Schema.Types.ObjectId, ref: "TaskList", default: null },
    claimedByUserId: { type: String, default: null },
    claimedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

NfcTagSchema.index({ companyId: 1, locationId: 1 });

export default models.NfcTag || model<INfcTag>("NfcTag", NfcTagSchema);
