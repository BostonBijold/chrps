import { NextRequest, NextResponse } from "next/server";
import { Receiver } from "@upstash/qstash";
import { connectDB } from "@/lib/mongoose";
import Company from "@/models/Company";
import Location from "@/models/Location";
import TaskList from "@/models/TaskList";
import Task from "@/models/Task";
import TaskLog from "@/models/TaskLog";
import MissedListAlert from "@/models/MissedListAlert";
import { resolveTasks } from "@/lib/task-definitions";
import { isTaskVisibleOn } from "@/lib/task-visibility";
import { DEFAULT_MISSED_LIST_GRACE_MINUTES, deriveCollapseAfter, isPastGraceWindow, minutesNowInZone, todayInZone } from "@/lib/task-list-window";
import { sendMissedListAlert } from "@/lib/notifications";

export const dynamic = "force-dynamic";

// The QStash-scheduled sweep behind missed-shift-list alerts — see
// docs/features/notifications.md. This is one of TWO alert types the
// notifications feature sends: the other, start-time reminders, is a
// structurally different mechanism (a precise per-list QStash schedule,
// see lib/qstash-schedules.ts and app/api/cron/task-list-reminder), not a
// polling sweep — the two don't share a route or a schedule. Unauthenticated
// (no user session): this route's only auth boundary is the QStash request
// signature, same conceptual role assertNfcVerified plays for a scan. Runs
// every company in one invocation — fine at current scale, revisit only if
// company count grows enough that this risks the function's max duration
// (see the doc's "Batching" note).

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY!,
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY!,
});

function fmtTime(t: string): string {
  const [h, m] = t.split(":").map(Number);
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, "0")}${suffix}` : `${h12}${suffix}`;
}

const TERMINAL_STATES = new Set(["done", "missed"]);

export async function POST(req: NextRequest) {
  const signature = req.headers.get("upstash-signature");
  const rawBody = await req.text();
  if (!signature) return NextResponse.json({ error: "Missing signature" }, { status: 401 });

  const valid = await receiver.verify({ signature, body: rawBody }).catch(() => false);
  if (!valid) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

  await connectDB();

  // Filtered in JS, not via a Mongo query match on notificationsEnabled/
  // timezone directly: every Company in this app is created by hand
  // straight in MongoDB (no self-serve creation flow — see CLAUDE.md's
  // "Multi-Tenancy"), so an existing company can easily have neither field
  // stored at all. An exact `{ notificationsEnabled: true }` match would
  // silently exclude every such company (Mongo's default is treated as
  // "enabled" everywhere else in this app via `?? true`, e.g.
  // app/api/company/settings/route.ts — a raw query needs the same
  // fallback, not schema-default reliance a hand-inserted doc never got).
  // missedAlertGraceMinutes gets the same treatment, but with an important
  // distinction: `undefined` (unset field) falls back to the original flat
  // 30-minute default, while an explicit `null` means the manager turned
  // missed alerts off for this company entirely — see models/Company.ts.
  const allCompanies = await Company.find(
    {},
    "_id timezone notificationsEnabled missedAlertGraceMinutes"
  ).lean<
    {
      _id: { toString(): string };
      timezone?: string | null;
      notificationsEnabled?: boolean;
      missedAlertGraceMinutes?: number | null;
    }[]
  >();
  const companies = allCompanies
    .filter((c) => c.notificationsEnabled !== false && !!c.timezone && c.missedAlertGraceMinutes !== null)
    .map((c) => ({
      _id: c._id,
      timezone: c.timezone as string,
      graceMinutes: c.missedAlertGraceMinutes ?? DEFAULT_MISSED_LIST_GRACE_MINUTES,
    }));

  let alertsSent = 0;

  for (const company of companies) {
    const companyId = company._id.toString();
    try {
      const today = todayInZone(company.timezone);
      const nowMinutes = minutesNowInZone(company.timezone);

      // TaskList/Task are now location-owned (each store's "Opening Shift"
      // is its own document, not a shared row every location reads
      // through) — so both queries below moved INSIDE the per-location loop
      // and gained a locationId filter. A company with no locations yet
      // (pre-migration, or one whose backfill hasn't run) falls back to a
      // single null-location pass, matching this route's pre-Locations
      // behavior exactly.
      const locations = await Location.find({ companyId, isActive: true }, "_id").lean<{ _id: { toString(): string } }[]>();
      const locationIds: (string | null)[] = locations.length > 0 ? locations.map((l) => l._id.toString()) : [null];

      for (const locationId of locationIds) {
        // Only shift-window lists (startTime non-null) — an anytime list
        // never closes, so "missed by the window" has no meaning for it.
        const lists = await TaskList.find(
          { companyId, locationId, isActive: true, startTime: { $ne: null } },
          "_id name startTime"
        ).lean<{ _id: { toString(): string }; name: string; startTime: string }[]>();
        if (lists.length === 0) continue;

        for (const list of lists) {
          const taskListId = list._id.toString();
          try {
            const rawTasks = await Task.find({ taskListId, companyId, locationId, isActive: true }).lean();
            const resolved = await resolveTasks(rawTasks);
            const visible = resolved.filter((t) => isTaskVisibleOn(t, today));
            // Nothing was expected on this list today — nothing can be missed.
            if (visible.length === 0) continue;

            const timedVisible = visible.filter((t) => t.taskType !== "checkbox");
            const totalProjected = timedVisible.reduce((s, t) => s + t.projectedMinutes, 0);
            const collapseAfter = deriveCollapseAfter(list.startTime, totalProjected);
            if (!isPastGraceWindow(nowMinutes, collapseAfter, company.graceMinutes)) continue;

            const logs = await TaskLog.find(
              { companyId, locationId, date: today, taskId: { $in: visible.map((t) => t._id) } },
              "taskId state"
            ).lean<{ taskId: { toString(): string }; state: string }[]>();
            const stateByTaskId = new Map(logs.map((l) => [l.taskId.toString(), l.state]));

            const outstanding = visible.filter((t) => {
              const state = stateByTaskId.get(t._id.toString());
              return !state || !TERMINAL_STATES.has(state);
            });
            if (outstanding.length === 0) continue;

            // Atomic "insert only if not already alerted today" — the unique
            // index on {companyId, locationId, taskListId, date} is the real
            // dedup guard, this insert is written BEFORE the push fan-out
            // (write-then-send) so a crash mid-send, or a QStash retry of
            // this whole invocation, can't cause a duplicate alert.
            try {
              await MissedListAlert.create({ companyId, locationId, taskListId, date: today });
            } catch (err: unknown) {
              if ((err as { code?: number }).code === 11000) continue; // already alerted
              throw err;
            }

            await sendMissedListAlert({
              companyId,
              locationId,
              taskListId,
              taskListName: list.name,
              outstandingCount: outstanding.length,
              windowEndLabel: collapseAfter ? fmtTime(collapseAfter) : fmtTime(list.startTime),
              date: today,
            });
            alertsSent += 1;
          } catch (err) {
            console.error(`check-missed-lists: list ${taskListId} (location ${locationId}) failed`, err);
          }
        }
      }
    } catch (err) {
      console.error(`check-missed-lists: company ${companyId} failed`, err);
    }
  }

  return NextResponse.json({ ok: true, companiesChecked: companies.length, alertsSent });
}
