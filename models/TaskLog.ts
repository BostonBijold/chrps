import mongoose, { Schema, Document, model, models } from "mongoose";
import type { FormFieldValue } from "@/models/TaskDefinition";

// "rest" is a legacy value only — see CLAUDE.md's "Skip Types". A
// restaurant work task has no personal "rest day" concept, so no code path
// can write a new TaskLog with this state anymore (enforced at
// app/api/task-logs/route.ts's POST, the only write boundary). Kept here
// so any pre-existing TaskLog document that already has state: "rest"
// (never migrated — see docs/features/reports.md) stays type-safe to
// read/display; every calculation (streaks, weekly progress, Reports
// aggregates) now treats it the same as "no log at all," not as a
// protected success.
export type LogState = "in_progress" | "paused" | "done" | "missed" | "rest";

export interface ITaskLog extends Document {
  companyId: string;
  // Which store this happened at — see docs/features/locations.md. Part of
  // the uniqueness key alongside companyId+taskId+date (not an attribute
  // like performedByUserId): two locations both running the same
  // shared-catalog task on the same day must each get their own log, not
  // collide into one. Plain String, same convention as companyId — carries
  // whatever the acting user's own locationId resolves to. Null only for
  // logs written before Locations shipped, backfilled by the one-off
  // migration (scripts/backfill-locations.mjs).
  locationId: string | null;
  // Which specific user actually did the task — an attribute, not part of
  // the uniqueness key: any employee on shift might complete a given task,
  // so the meaningful uniqueness is one log per task per day for the whole
  // location (see the index below), not per user.
  performedByUserId: string;
  taskId: mongoose.Types.ObjectId;
  date: string;              // YYYY-MM-DD
  actualMinutes?: number;    // null if missed/rest; derived from timestamps on timer completions
  startedAt?: Date;          // set when state → in_progress; null while paused
  completedAt?: Date;        // set when state → done via timer
  // Elapsed seconds banked from prior running segments of this same log —
  // e.g. jumping away from a task inside a Task List Session pauses it and
  // banks whatever it had accumulated so far, rather than completing it.
  // Total elapsed while running = pausedSeconds + (now - startedAt).
  pausedSeconds: number;
  state: LogState;
  note?: string;
  isBackEntry: boolean;
  // Set only while state === "in_progress" and this timer was started with
  // a taskListId — set by TaskListSessionView.tsx's own per-item effect
  // when a session's task starts (the primary path; a now-deleted external
  // API used to be able to set it too, for anchoring a session on an
  // anytime list specifically, see docs/features/anytime-tasks.md). Tells
  // the client to reopen this task inside a Task List Session for that list
  // on resume, instead of the standalone timer. Cleared whenever the log
  // leaves in_progress.
  sessionTaskListId?: mongoose.Types.ObjectId | null;
  // Set only on the terminal log for a "form" task (see
  // components/TaskFormScreen.tsx) — every other log leaves this null.
  formData?: Record<string, FormFieldValue> | null;
  // Blob URL of the employee-captured completion photo — set only when the
  // completing write actually included one (see
  // docs/features/task-completion-photo.md). Required by
  // lib/task-log-actions.ts's assertPhotoProvided before a "done" write is
  // accepted for a task whose resolved TaskDefinition.requiresPhoto is
  // true; null/unset otherwise, including every "missed" log (never
  // required — a missed task was never done, nothing to photograph).
  photoUrl?: string | null;
  // NFC/card identifier that triggered this log, if any — populated when a
  // log is started via a tag-triggered external path; null for an in-app
  // manual start. Field exists ahead of the NFC reader itself (separate
  // work) so this isn't a later migration.
  tagId?: string | null;
  createdAt: Date;
}

const TaskLogSchema = new Schema<ITaskLog>(
  {
    companyId: { type: String, required: true, index: true },
    locationId: { type: String, default: null },
    performedByUserId: { type: String, required: true },
    taskId: { type: Schema.Types.ObjectId, ref: "Task", required: true },
    date: { type: String, required: true },
    actualMinutes: { type: Number, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    pausedSeconds: { type: Number, default: 0 },
    state: { type: String, enum: ["in_progress", "paused", "done", "missed", "rest"], required: true },
    note: { type: String, default: null },
    isBackEntry: { type: Boolean, default: false },
    sessionTaskListId: { type: Schema.Types.ObjectId, ref: "TaskList", default: null },
    formData: { type: Schema.Types.Mixed, default: null },
    photoUrl: { type: String, default: null },
    tagId: { type: String, default: null },
  },
  { timestamps: true }
);

TaskLogSchema.index({ companyId: 1, date: 1 });
// One log per task per day per LOCATION — not per user (performedByUserId
// is an attribute, not part of this key) and, since the task catalog is
// shared company-wide (see docs/features/locations.md's open questions),
// not per company alone either: two locations both running the same
// shared "Opening Checklist" on the same day must each get their own log.
// Requires every row's locationId to be backfilled before this index is
// created against existing data — see scripts/backfill-locations.mjs.
TaskLogSchema.index({ companyId: 1, locationId: 1, taskId: 1, date: 1 }, { unique: true });
// Supports the Reports Logs tab's per-employee date-range history query
// (GET /api/task-logs/history) and lib/streak.ts's backward day-by-day
// walk — neither existing index above covers performedByUserId, so either
// would collection-scan without this one.
TaskLogSchema.index({ companyId: 1, performedByUserId: 1, date: 1 });

export default models.TaskLog || model<ITaskLog>("TaskLog", TaskLogSchema);
