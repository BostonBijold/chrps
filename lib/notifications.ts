import { connectDB } from "@/lib/mongoose";
import PushToken from "@/models/PushToken";
import User from "@/models/User";
import { sendAlertPush, ApnsPushError } from "@/lib/apns";

// Shared send loop for both alert types below — looks up every registered
// PushToken for the given userIds and fans a push out to each, pruning any
// token APNs reports as dead. Callers (the cron sweep) are responsible for
// the write-then-send ordering: write the dedup row BEFORE calling either
// function below, not after, so a crash mid-send can't cause a duplicate
// alert on retry.
async function sendPushToUsers(params: {
  companyId: string;
  userIds: string[];
  title: string;
  body: string;
  data: Record<string, unknown>;
}): Promise<void> {
  const { companyId, userIds, title, body, data } = params;
  if (userIds.length === 0) return;

  const tokens = await PushToken.find({ companyId, userId: { $in: userIds } }).lean<
    { _id: { toString(): string }; token: string; environment: "sandbox" | "production" }[]
  >();
  console.log(`sendPushToUsers: ${tokens.length} token(s) found for companyId ${companyId} (${userIds.length} user(s) targeted)`);
  if (tokens.length === 0) return;

  await Promise.all(
    tokens.map(async (t) => {
      try {
        await sendAlertPush({ pushToken: t.token, environment: t.environment, title, body, data });
        console.log(`sendPushToUsers: sent to token ${t._id} (${t.environment})`);
      } catch (err) {
        // Always logged now — this used to be silent even for failures
        // this branch doesn't specifically handle, which made a real APNs
        // rejection (e.g. a sandbox-registered token sent against the
        // production host, or vice versa — see app/api/push-tokens/route.ts's
        // environment-inference caveat) invisible anywhere.
        console.error(`sendPushToUsers: send failed for token ${t._id} (${t.environment})`, err);
        // A dead token (uninstalled app, reissued token) should stop being
        // retried rather than accumulate as permanent dead weight — see
        // docs/features/notifications.md's "Failure handling". Any other
        // failure (network blip, APNs outage) is left alone: this run's
        // send simply doesn't go out, and the dedup row already written by
        // the caller means there's no retry this run — accepted tradeoff,
        // a missed push is lower-stakes than a missed task.
        if (err instanceof ApnsPushError && (err.reason === "BadDeviceToken" || err.reason === "Unregistered")) {
          await PushToken.deleteOne({ _id: t._id });
        }
      }
    })
  );
}

// Fans a missed-shift-list digest out to every manager at the given
// company — see docs/features/notifications.md's "Push payload" and
// "Failure handling". Manager-only: this is the escalation alert (the
// window closed with tasks still outstanding), distinct from
// sendStartTimeReminder below, which also reaches employees.
export async function sendMissedListAlert(params: {
  companyId: string;
  // Which store this list's window closed at — see
  // docs/features/locations.md. Reaches managers at that specific location
  // plus every owner (an owner administers every location, so they get the
  // escalation regardless of which store it's for); null (a pre-Locations
  // company, or one that never got a default location backfilled) falls
  // back to every manager/owner company-wide, same as before this feature.
  locationId: string | null;
  taskListId: string;
  taskListName: string;
  outstandingCount: number;
  windowEndLabel: string; // e.g. "10:30pm" — already formatted, this module doesn't know time-of-day formatting
  date: string; // YYYY-MM-DD
  // Company.missedAlertIncludeOwner — see
  // docs/features/notification-job-tag-targeting.md. Default true (today's
  // behavior): the owner is included alongside managers. false: managers
  // only. Unaffected by job-tag targeting — missed alerts stay role-based,
  // never per-tag.
  includeOwner?: boolean;
}): Promise<void> {
  const { companyId, locationId, taskListId, taskListName, outstandingCount, windowEndLabel, date, includeOwner = true } = params;

  await connectDB();
  const roles = includeOwner ? ["manager", "owner"] : ["manager"];
  const managers = await User.find(
    {
      companyId,
      role: { $in: roles },
      ...(locationId ? { $or: includeOwner ? [{ locationId }, { role: "owner" }] : [{ locationId }] } : {}),
    },
    "_id"
  ).lean<{ _id: { toString(): string } }[]>();

  await sendPushToUsers({
    companyId,
    userIds: managers.map((m) => m._id.toString()),
    title: taskListName,
    body: `${outstandingCount} task${outstandingCount === 1 ? "" : "s"} not finished — window closed at ${windowEndLabel}`,
    data: { taskListId, date, alertType: "missed" },
  });
}

// Fans a "start-time reminder" out to EVERY company user (managers and
// employees both) — see docs/features/notifications.md's "Start-time
// reminders." A lightweight nudge fired at a shift-window list's exact
// startTime via its own QStash schedule (app/api/cron/task-list-reminder),
// not conditioned on anything being late — distinct from
// sendMissedListAlert above, which is the manager-only escalation once the
// window has actually closed with tasks still outstanding.
export async function sendStartTimeReminder(params: {
  companyId: string;
  // Same reasoning as sendMissedListAlert above — reaches everyone at this
  // specific location plus every owner; null falls back to the whole
  // company, same as before this feature.
  locationId: string | null;
  taskListId: string;
  taskListName: string;
  date: string; // YYYY-MM-DD
  // TaskList.notifyTags — see
  // docs/features/notification-job-tag-targeting.md. Empty/omitted =
  // today's behavior (everyone at the location, owner always included).
  // Non-empty narrows the audience to users at this location whose
  // jobTags intersects notifyTags — the owner is NOT auto-included on
  // this path, only if they themselves carry a matching tag, same as
  // anyone else.
  notifyTags?: string[];
}): Promise<void> {
  const { companyId, locationId, taskListId, taskListName, date, notifyTags = [] } = params;

  await connectDB();
  const query: Record<string, unknown> = { companyId };
  if (notifyTags.length > 0) {
    query.jobTags = { $in: notifyTags };
    if (locationId) query.locationId = locationId;
  } else if (locationId) {
    query.$or = [{ locationId }, { role: "owner" }];
  }
  const everyone = await User.find(query, "_id").lean<{ _id: { toString(): string } }[]>();

  await sendPushToUsers({
    companyId,
    userIds: everyone.map((u) => u._id.toString()),
    title: taskListName,
    body: `Time to start ${taskListName}`,
    data: { taskListId, date, alertType: "start_time" },
  });
}
