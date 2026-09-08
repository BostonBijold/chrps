import { Schema, Document, model, models } from "mongoose";

export interface ITaskList extends Document {
  companyId: string;
  // Which physical store this list belongs to — see CLAUDE.md's "Locations"
  // section. String, not ObjectId ref, same convention as companyId. null
  // only for a pre-migration row (scripts/backfill-task-catalog-locations.mjs
  // backfills every existing row onto its company's primary location).
  locationId: string | null;
  name: string;
  timeOfDay: "morning" | "evening" | "custom" | "anytime";
  startTime: string | null;    // 'HH:MM' — when the task list's window opens (end is derived from projected mins)
  order: number;
  isDefault: boolean;
  // Soft-delete flag, same convention as Task.isActive — a removed list
  // drops out of the active set (and off the Tasks page) but its history
  // (TaskLog/TaskListSession records referencing it) is left untouched.
  isActive: boolean;
  // List-level default for each task's own scheduledDays — pushed down onto
  // every task in the list whenever this changes (see lib/seed.ts and the
  // task-lists API route). A task can still be edited afterward to diverge
  // from this default; it's a default-then-override relationship, not a
  // hard lock. Defaults to every day so existing lists are unaffected until
  // a manager opts in.
  scheduledDays: number[];
  // The QStash schedule ID backing this list's own start-time reminder
  // push (see docs/features/notifications.md's "Start-time reminders") —
  // deterministic (`tasklist-<this list's _id>`), so this field is really
  // a cache/audit trail rather than the source of truth, but storing it
  // avoids callers having to recompute or guess the ID, and lets a delete
  // skip calling QStash at all for a list that never had one (an anytime
  // list, or one with an empty scheduledDays). null = no live schedule.
  qstashScheduleId: string | null;
  // Job-tag values (from the company's JobTag catalog, matched by name —
  // same string-not-ref convention as User.jobTags) that narrow this
  // list's start-time reminder audience — see
  // docs/features/notification-job-tag-targeting.md. Empty = notify
  // everyone at this location (today's behavior, unchanged). Inert for an
  // anytime list (startTime: null), which has no start-time reminder to
  // target — same "harmless no-op" pattern qstashScheduleId already
  // follows for those lists.
  notifyTags: string[];
}

const TaskListSchema = new Schema<ITaskList>(
  {
    // Company's shared task-list configuration — not any individual's
    // personal data. String, not ObjectId, matching every other model's
    // company/user id fields — this travels as the string a session or API
    // key resolves to, and SKIP_AUTH's dev company id isn't a valid ObjectId
    // at all, so it must stay a plain string here too.
    companyId: { type: String, required: true, index: true },
    locationId: { type: String, default: null },
    name: { type: String, required: true },
    timeOfDay: { type: String, enum: ["morning", "evening", "custom", "anytime"], required: true },
    startTime: { type: String, default: null },
    order: { type: Number, default: 0 },
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    scheduledDays: { type: [Number], default: [0, 1, 2, 3, 4, 5, 6] },
    qstashScheduleId: { type: String, default: null },
    notifyTags: { type: [String], default: [] },
  },
  { timestamps: true }
);

TaskListSchema.index({ companyId: 1, locationId: 1, isActive: 1 });

export default models.TaskList || model<ITaskList>("TaskList", TaskListSchema);
