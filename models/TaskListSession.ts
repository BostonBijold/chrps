import mongoose, { Schema, Document, model, models } from "mongoose";

// "assigned" — a manager pre-named today's shift lead before anyone
// actually started the list; see docs/features/shift-lead-preassignment.md.
// It's the only status with a null startedAt/performedByUserId — those two
// only take on their normal meaning once ensureOpenSession upgrades the
// record to "in_progress".
export type TaskListSessionStatus = "assigned" | "in_progress" | "completed";
// "rest" is a legacy value only — see models/TaskLog.ts's LogState. Kept so
// a pre-existing session's completionSequence stays type-safe to read; no
// code path writes a new one (recordSessionCompletion's callers only ever
// pass "done"/"missed" now — see app/api/task-logs/route.ts).
export type CompletionState = "done" | "missed" | "rest";

export interface ICompletionEntry {
  taskId: mongoose.Types.ObjectId;
  completedAt: Date;
  state: CompletionState;
}

export interface ITaskListSession extends Document {
  // String, not ObjectId, matching every other model's companyId (TaskLog,
  // Task, TaskList) — this is the id a session or API key resolves to, and
  // SKIP_AUTH's local dev company isn't a valid ObjectId at all, so it must
  // stay a plain string here too.
  companyId: string;
  // Which store this session run belongs to — see docs/features/locations.md.
  // Part of the "find the open session for this list/date" lookup below,
  // same reasoning as TaskLog.locationId: otherwise a session opened at one
  // store would incorrectly appear "already open" at another. Null only for
  // sessions predating Locations, backfilled by the one-off migration.
  locationId: string | null;
  // Who opened this particular guided "Start Tasks" walkthrough — an
  // attribute only, never an exclusivity lock over the list's tasks (see
  // docs/features/task-lists.md's "Per-task claiming" — that used to be
  // this field's job, before per-task claiming replaced it). Stamped once
  // on creation and never reassigned; who's actually claimed/completed any
  // given task lives on that task's own TaskLog.performedByUserId instead.
  performedByUserId: string | null;
  taskListId: mongoose.Types.ObjectId;
  date: string; // YYYY-MM-DD
  // Nullable — null only while status === "assigned" (nobody has actually
  // started the list yet). ensureOpenSession fills this in the moment an
  // "assigned" record is upgraded to "in_progress".
  startedAt: Date | null;
  completedAt: Date | null;
  status: TaskListSessionStatus;
  totalActualMinutes: number;
  completionSequence: ICompletionEntry[];
  pauseOrJumpCount: number;
  // Pre-assignment fields — see docs/features/shift-lead-preassignment.md.
  // Never cleared by the "assigned" -> "in_progress" upgrade: they stay on
  // the record as a permanent "who was assigned, and by whom" alongside the
  // run itself, even after performedByUserId/startedAt take on their own,
  // separate meaning (who actually ran it / when it actually started).
  assignedUserId: string | null;
  assignedByUserId: string | null;
  assignedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const CompletionEntrySchema = new Schema<ICompletionEntry>(
  {
    taskId: { type: Schema.Types.ObjectId, ref: "Task", required: true },
    completedAt: { type: Date, required: true },
    state: { type: String, enum: ["done", "missed", "rest"], required: true },
  },
  { _id: false }
);

const TaskListSessionSchema = new Schema<ITaskListSession>(
  {
    companyId: { type: String, required: true },
    locationId: { type: String, default: null },
    performedByUserId: { type: String, default: null },
    taskListId: { type: Schema.Types.ObjectId, ref: "TaskList", required: true },
    date: { type: String, required: true },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    status: { type: String, enum: ["assigned", "in_progress", "completed"], default: "in_progress" },
    totalActualMinutes: { type: Number, default: 0 },
    completionSequence: { type: [CompletionEntrySchema], default: [] },
    pauseOrJumpCount: { type: Number, default: 0 },
    assignedUserId: { type: String, default: null },
    assignedByUserId: { type: String, default: null },
    assignedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// No unique index — a list can legitimately be started, finished, and
// started again the same day (e.g. redoing it), and each run gets its own
// session record rather than colliding with the last one. This index just
// makes "find the open session for this company/location/list/date" (the
// lookup every write path below needs) cheap — locationId is part of it so
// a session opened at one store never reads as "already open" at another.
TaskListSessionSchema.index({ companyId: 1, locationId: 1, taskListId: 1, date: 1, status: 1 });

export default models.TaskListSession || model<ITaskListSession>("TaskListSession", TaskListSessionSchema);
