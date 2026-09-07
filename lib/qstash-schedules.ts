// Manages the per-TaskList QStash schedule backing start-time reminders —
// see docs/features/notifications.md's "Start-time reminders". Distinct
// from the missed-list sweep (app/api/cron/check-missed-lists), which uses
// one shared, manually-created recurring schedule; this one creates/
// updates/deletes a schedule per shift-window list, driven by application
// code rather than a one-time manual setup step, since a list's own
// startTime/scheduledDays can change at any time.
//
// Talks to the QStash HTTP API directly via fetch rather than the
// @upstash/qstash SDK's schedule client — this is the same small set of
// calls already proven out manually (see docs/features/notifications.md's
// "Setting it up" for the missed-list sweep's own schedule, created the
// same way from a shell), and avoids depending on SDK surface this
// codebase hadn't otherwise needed.

const QSTASH_BASE_URL = process.env.QSTASH_URL ?? "https://qstash.upstash.io";

// Hardcoded rather than derived from a request — this runs from API routes
// that have no reliable "public origin" of their own (and, unlike a
// user-facing page, always needs to mean the real deployed app regardless
// of where the code creating/deleting the schedule happens to run, dev
// included) — same convention as capacitor.config.ts's server.url and the
// Associated Domains entitlement. See docs/features/nfc.md's "Domain
// permanence" note for the same caveat applied elsewhere: if this domain
// ever changes, every list's schedule needs re-pointing.
const PRODUCTION_ORIGIN = "https://chrps.app";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} env var — see docs/features/notifications.md`);
  return value;
}

function scheduleIdFor(taskListId: string): string {
  return `tasklist-${taskListId}`;
}

// "HH:MM" + 0=Sun..6=Sat days + an IANA zone -> a QStash cron expression.
// QStash evaluates the CRON_TZ prefix itself (all IANA zones supported),
// so DST is handled for free, same reasoning as lib/task-list-window.ts's
// Intl-based math for the missed-list sweep.
function cronFor(startTime: string, scheduledDays: number[], timezone: string): string {
  const [hour, minute] = startTime.split(":").map(Number);
  return `CRON_TZ=${timezone} ${minute} ${hour} * * ${scheduledDays.join(",")}`;
}

// Creates or, via QStash's own "same Upstash-Schedule-Id overwrites"
// behavior, updates this list's start-time reminder schedule. Returns the
// schedule ID to store on TaskList.qstashScheduleId, or null if no
// schedule should exist (deleting any existing one instead) — an anytime
// list (no startTime), a list with nothing on its scheduledDays, or a
// company with no timezone set yet (nothing to evaluate CRON_TZ against).
export async function upsertStartTimeSchedule(params: {
  taskListId: string;
  startTime: string | null;
  scheduledDays: number[];
  timezone: string | null;
}): Promise<string | null> {
  const { taskListId, startTime, scheduledDays, timezone } = params;

  if (!startTime || scheduledDays.length === 0 || !timezone) {
    await deleteStartTimeSchedule(taskListId);
    return null;
  }

  const scheduleId = scheduleIdFor(taskListId);
  const destination = `${PRODUCTION_ORIGIN}/api/cron/task-list-reminder`;
  const cron = cronFor(startTime, scheduledDays, timezone);

  const res = await fetch(`${QSTASH_BASE_URL}/v2/schedules/${destination}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("QSTASH_TOKEN")}`,
      "Upstash-Cron": cron,
      "Upstash-Schedule-Id": scheduleId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ taskListId }),
  });
  if (!res.ok) {
    throw new Error(`QStash schedule upsert failed for list ${taskListId}: ${res.status} ${await res.text()}`);
  }

  // Success case wasn't logged at all before — every call site only
  // logged its own catch block, so a working upsert left no trace
  // anywhere. This is the confirmation a Vercel function-log search for
  // "qstash-schedules" gives you that a save actually queued a schedule,
  // without needing to check the QStash console's Schedules tab instead.
  console.log(`qstash-schedules: upserted ${scheduleId} for list ${taskListId} (${cron})`);

  return scheduleId;
}

// Best-effort delete — a 404 (already gone, or never existed), a missing
// QSTASH_TOKEN, or a transient network failure shouldn't block the caller
// (task-list create/update/delete routes), since a stray orphaned schedule
// is a much smaller problem than a task-list mutation failing over a
// QStash hiccup. The whole body is inside the try (not just the fetch)
// specifically so requireEnv()'s synchronous throw is caught here too, not
// left to propagate past this function's own "best-effort" promise. Still
// swallowed either way (never rethrown) — only now also logged, so a
// silent failure here doesn't stay invisible in Vercel's function logs
// the way it did before.
export async function deleteStartTimeSchedule(taskListId: string): Promise<void> {
  try {
    const scheduleId = scheduleIdFor(taskListId);
    const res = await fetch(`${QSTASH_BASE_URL}/v2/schedules/${scheduleId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${requireEnv("QSTASH_TOKEN")}` },
    });
    console.log(`qstash-schedules: delete ${scheduleId} for list ${taskListId} -> ${res.status}`);
  } catch (err) {
    console.error(`qstash-schedules: delete failed for list ${taskListId}`, err);
  }
}
