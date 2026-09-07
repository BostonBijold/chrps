import mongoose, { Schema, Document, model, models } from "mongoose";

// "standard"/"stopwatch"/"checkbox" are retired timer-based item types from
// the pre-pivot personal-habit tracker, kept only for schema compatibility
// with any pre-pivot data — "form" is the only creatable type. "checkbox"
// here names a UI control style (tap to complete, no reading captured), not
// a reference to the old "check" product vocabulary.
export type TaskType = "standard" | "stopwatch" | "checkbox" | "form";

// Schema-driven field definitions for a "form" task — the "in progress"
// screen renders one control per entry instead of a timer. Kept generic
// (not hardcoded to e.g. temperature) so the next form task (bathroom
// clean, closing checklist) is just a different formFields array, no code
// change. Only populated when taskType === "form"; empty otherwise.
//
// "boolean" is a yes/no *answer* (e.g. "Were floors clean?" — "No" is a
// meaningful, savable result). "checklist" is a to-do *action* — a thing
// the user must physically do and mark off (e.g. "Take out garbage"),
// where the only state that lets the task save is checked. `items` holds
// the checklist's sub-item labels; a single-item checklist (the common
// case — one action, one check, e.g. "Take out garbage") renders as one
// big checkbox using the field's own `label` as the prompt, while multiple
// items (e.g. "Store lights" / "Music" / "Open sign") render as their own
// rows under the field's label as a group heading — a checklist nested
// inside the task's own checklist of fields. All items must be checked to
// save, same as a required boolean answer.
//
// "temperature" is a number field with unit-aware entry — unlike a plain
// "number" field, `unit` here is meaningful (only ever "F" or "C", the
// degree scale this field's `value`/`min`/`max` are stored in), and the
// worker's entry screen (components/TemperatureInput.tsx) renders a
// scroll-wheel picker instead of a bare text box so negative readings
// (freezers) are as easy to enter as positive ones — iOS's decimal keypad
// has no minus key, which a plain <input inputMode="decimal"> can't work
// around. `min`/`max` are the manager's acceptable range in that same
// unit (e.g. freezer max 0°F, hot-holding min 135°F); an out-of-range
// reading still saves (an honest record — see "Skip Types" in
// CLAUDE.md — a broken freezer is exactly the thing this should surface,
// not hide) but is flagged visually at entry and wherever it's reviewed.
export interface FormFieldDef {
  key: string;              // stable key, e.g. "temperature"
  label: string;            // display label, e.g. "Walk-in temperature"
  type: "number" | "text" | "boolean" | "checklist" | "temperature";
  unit?: string;             // "number": e.g. "$" — display only. "temperature": "F" | "C" — the storage/comparison unit.
  min?: number;               // optional pass/fail bound, number/temperature fields only
  max?: number;
  items?: string[];           // checklist fields only — sub-item labels, always >= 1 entry
}

// A checklist field's captured value is one boolean per item, keyed by that
// item's label (see FormFieldDef.items above) — everything else stays a
// single primitive. TaskLog.formData is a map of formFieldKey → this.
export type FormFieldValue = string | number | boolean | Record<string, boolean>;

export const FormFieldDefSchema = new Schema<FormFieldDef>(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    type: { type: String, enum: ["number", "text", "boolean", "checklist", "temperature"], required: true },
    unit: { type: String, default: undefined },
    min: { type: Number, default: undefined },
    max: { type: Number, default: undefined },
    items: { type: [String], default: undefined },
  },
  { _id: false }
);

// One manager-authored step of "what the finished result should look
// like" (a reference photo, a caption, or both) — see
// docs/features/task-completion-instructions.md. At least one of
// description/imageUrl is always non-empty; an entry with neither is
// dropped before it ever reaches Mongo (lib/instruction-steps.ts's
// sanitizeInstructionSteps). Order in the array is display order — a max
// of 3 entries doesn't need its own `order` field, same reasoning as
// FormFieldDef.items. Mongoose's automatic per-subdocument `_id` is the
// step identity the manager UI edits/deletes/reorders by.
export interface InstructionStep {
  _id: mongoose.Types.ObjectId;
  description: string | null;
  imageUrl: string | null;   // Vercel Blob URL; null if this step has no image
}

export const InstructionStepSchema = new Schema<InstructionStep>(
  {
    description: { type: String, default: null },
    imageUrl: { type: String, default: null },
  }
);

// The company's reusable, physical-location-bound "saved task" — the check
// itself (fridge temp, restroom clean, opening cash count), independent of
// any one TaskList placement. A `Task` (models/Task.ts) is a lightweight
// join connecting one of these into a specific list; the same
// TaskDefinition can be placed in more than one list (e.g. fridge temp
// checked in both the opening and closing lists), and its NFC binding,
// name, icon, and form fields are shared across every placement — the same
// physical check, done more than once. See the "Company Task Catalog"
// design in docs/features/task-lists.md.
export interface ITaskDefinition extends Document {
  companyId: string;
  // Which TaskTemplate this was cloned from, if any — informational only,
  // used to exclude an already-in-use template from the catalog browser
  // (see app/api/task-templates/route.ts). Null for a fully custom task.
  templateId: mongoose.Types.ObjectId | null;
  name: string;
  icon: string;
  taskType: TaskType;
  formFields: FormFieldDef[];
  // Default time budget — a placement (Task.projectedMinutes) may override
  // this per list; null there means "inherit this default."
  projectedMinutes: number;
  // Raw hardware UID (lowercase hex) of a physical NFC tag bound to this
  // saved task, scanned in-app — see docs/features/nfc.md's "In-app
  // scan-to-complete binding". Binding lives here, one layer above any
  // single list placement, so every list this task is placed in shares the
  // same tag automatically. null/unset = completes normally, no scan
  // required. Distinct from models/NfcTag.ts's tagCode/URL-based
  // tap-to-trigger system.
  nfcTagUid: string | null;
  // Up to 3 manager-authored "what this should look like when done"
  // steps (photo and/or caption) — see
  // docs/features/task-completion-instructions.md. Same layer as
  // formFields/name/icon: content of the check itself, cascades to every
  // list this definition is placed in. Default [].
  instructionSteps: InstructionStep[];
  // Whether an employee must attach a completion photo (captured via
  // components/TaskPhotoCaptureButton.tsx) before a "done" write for this
  // task is accepted — see docs/features/task-completion-photo.md. Same
  // layer as instructionSteps/formFields: content of the check itself,
  // cascades to every list this definition is placed in. Applies to every
  // taskType, not just "form" — enforced at the TaskLog write boundary
  // (lib/task-log-actions.ts's assertPhotoProvided), not inside formFields.
  // Default false.
  requiresPhoto: boolean;
  // Archived once a manager deletes it from the catalog — blocked while any
  // active Task placement still references it (see
  // app/api/task-definitions/[id]/route.ts), so an isActive: false
  // definition should never have live placements pointing at it.
  isActive: boolean;
}

const TaskDefinitionSchema = new Schema<ITaskDefinition>(
  {
    // Company's shared task configuration — see TaskList.companyId for why
    // this stays a plain String rather than an ObjectId ref.
    companyId: { type: String, required: true, index: true },
    templateId: { type: Schema.Types.ObjectId, ref: "TaskTemplate", default: null },
    name: { type: String, required: true },
    icon: { type: String, default: "list-checks" },
    taskType: { type: String, enum: ["standard", "stopwatch", "checkbox", "form"], default: "form" },
    formFields: { type: [FormFieldDefSchema], default: [] },
    projectedMinutes: { type: Number, default: 0 },
    nfcTagUid: { type: String, default: null },
    instructionSteps: { type: [InstructionStepSchema], default: [] },
    requiresPhoto: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default models.TaskDefinition || model<ITaskDefinition>("TaskDefinition", TaskDefinitionSchema);
