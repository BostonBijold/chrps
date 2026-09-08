import mongoose, { Schema, Document, model, models } from "mongoose";

// A Task is a list PLACEMENT — a join connecting one of the company's saved
// checks (models/TaskDefinition.ts — name, icon, form fields, NFC binding)
// into a specific TaskList, carrying only what actually varies per
// placement: schedule, threshold, order, and an optional time-budget
// override. The same TaskDefinition can have more than one placement (the
// fridge-temp check placed in both the opening and closing lists) — each
// placement gets its own independent TaskLog history/streak, since they're
// different obligations at different times, even though they're "the same
// physical check." See the "Company Task Catalog" design in
// docs/features/task-lists.md.
//
// This is deliberately still called `Task` (not renamed to e.g.
// "TaskPlacement") — CLAUDE.md's product vocabulary already defines Task as
// "an individual item within" a TaskList, which is exactly what this is.
// TaskLog.taskId, the external API's routineItemId, and every streak/
// analytics computation key off THIS document's _id, unchanged from before
// the catalog split.
export interface ITask extends Document {
  taskListId: mongoose.Types.ObjectId;
  companyId: string;
  // Denormalized from taskListId's own TaskList.locationId (and always
  // matching definitionId's TaskDefinition.locationId) — same house style
  // as TaskLog/TaskListSession/InventoryLog/MissedListAlert, which all
  // denormalize locationId directly rather than relying on a join, so
  // every read/write path here can filter by it in one query. See
  // CLAUDE.md's "Locations" section. null only for a pre-migration row.
  locationId: string | null;
  definitionId: mongoose.Types.ObjectId;
  // Overrides TaskDefinition.projectedMinutes for this placement only; null
  // means "inherit the definition's default." Resolved server-side by
  // lib/task-definitions.ts's resolveTasks/resolveTask before ever reaching
  // the client — every client-facing shape still sees a plain number.
  projectedMinutes: number | null;
  order: number;
  isActive: boolean;
  // 0=Sun..6=Sat — which days this task is expected. Defaults to (and can be
  // pushed down from) its TaskList's own scheduledDays — see
  // models/TaskList.ts — but can be edited independently afterward.
  scheduledDays: number[];
  // How many of this week's *scheduled* days need to be done/rest to read
  // as 100% — never allowed to exceed scheduledDays.length (see the API
  // routes, which clamp on write; this field alone doesn't enforce it).
  successThreshold: number;
}

const TaskSchema = new Schema<ITask>(
  {
    taskListId: { type: Schema.Types.ObjectId, ref: "TaskList", required: true },
    // Company's shared task configuration — see TaskList.companyId for why
    // this stays a plain String rather than an ObjectId ref.
    companyId: { type: String, required: true, index: true },
    locationId: { type: String, default: null },
    definitionId: { type: Schema.Types.ObjectId, ref: "TaskDefinition", required: true, index: true },
    projectedMinutes: { type: Number, default: null },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    scheduledDays: { type: [Number], default: [0, 1, 2, 3, 4, 5, 6] },
    successThreshold: { type: Number, default: 7 },
  },
  { timestamps: true }
);

TaskSchema.index({ taskListId: 1, locationId: 1, isActive: 1 });
TaskSchema.index({ companyId: 1, locationId: 1, definitionId: 1, isActive: 1 });

export default models.Task || model<ITask>("Task", TaskSchema);
