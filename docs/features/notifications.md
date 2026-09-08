> **Keep this file updated after any code change in this area — do not let it drift from actual implementation.**

# Notifications (shift-window alerts)

**Status: BUILT.** Two independent push alerts, structurally different
mechanisms, both landing on the same devices:

- **Start-time reminders** — fires at a shift-window list's exact
  `startTime`, via its own standing **per-list QStash schedule** (not a
  poll). A nudge, not an escalation. Reaches **managers and employees**.
- **Missed** — fires when a list's window closes (derived end time + a
  manager-configurable grace period, `Company.missedAlertGraceMinutes`,
  company-wide for every shift-window list — see "Missed-list alerts"
  below) with tasks still outstanding, via a single **shared recurring
  QStash sweep** (a poll, every 5 minutes). An escalation. Reaches
  **managers only**. A manager can also turn missed alerts off entirely
  for their company (distinct from the broader `notificationsEnabled` kill
  switch, which covers both alert types) by setting the grace period to
  "off" in Company Settings.

See CLAUDE.md's "Notifications" section for a short summary; this doc has
the full detail.

**v1 scope**: push-only, one alert per list per day per type (start-time
reminders: naturally one per scheduled day, since each is a distinct
non-repeating QStash occurrence; missed: deduped via `MissedListAlert`).

**Explicitly out of scope for v1** (see "Deferred / open questions" below):
par-level inventory alerts (same missed-list infra, different trigger — a
fast-follow), email fallback, per-manager mute, **per-list** configurable
grace period for the missed alert (v1 is company-wide, not per-list — see
"Missed-list alerts" below), time clock (not built at all yet, unrelated).

## Two mechanisms, on purpose

These aren't the same shape of problem, so they don't share one:

- **Missed** only needs to know "has enough time passed that this is now
  late?" — a coarse poll (every 5 minutes) is fine, since the alert itself
  is inherently fuzzy ("closed *around* `N` minutes ago," `N` being the
  company's own configured grace period).
- **Start-time reminders** are explicitly about firing *at* a specific
  moment — "starts now" read oddly arriving up to several minutes early or
  late, which is what an earlier version of this feature did (a shared
  poll with its own grace period, checking "has nothing been logged N
  minutes after startTime"). That version was scrapped in favor of giving
  **each shift-window list its own QStash schedule**, evaluated by QStash
  itself at the exact minute — see "Start-time reminders" below.

## Why QStash, not Vercel Cron

This needs a background job that runs independent of any user request —
Vercel's own Cron Jobs are the obvious first thought, but the Hobby plan
caps cron at once-per-day, fired sometime within an hour window, which is
useless for either alert type here. Pro lifts that to per-minute cadence,
but only via a $20/mo/seat upgrade — and even Pro is still a *poll*,
which isn't precise enough for start-time reminders regardless (see
above).

**Upstash QStash** decouples the trigger from Vercel's plan entirely: it's
an external HTTP scheduler that calls one of our own API routes, free up
to 1,000 messages/day and 10 active schedules — comfortably covers the
missed-list sweep (one shared schedule, 288 messages/day at its 5-minute
cadence) plus one schedule per shift-window list for start-time reminders
(each list fires at most once per scheduled day, so message volume scales
with company/list count, not with polling frequency).

The tradeoff: one more third-party account/dependency, and any receiving
route needs to verify QStash's request signature (`Upstash-Signature`
header) rather than trusting Vercel's own cron auth pattern
(`CRON_SECRET` bearer token).

**Growing past the free tier is a good problem.** Both the sweep's message
volume and the per-list schedule count scale with how many paying
companies/lists exist — by the time that crosses QStash's free limits
(10 active schedules total today — see "Deferred" below), the business
should comfortably support QStash's usage-based pricing.

## `Company.timezone`

**`models/Company.ts` has `timezone: string | null`** — an IANA zone name
(`"America/Chicago"`), not a raw UTC offset. Used two ways:

- The missed-list sweep's own `Intl`-based math (`lib/task-list-window.ts`'s
  `minutesNowInZone`/`todayInZone`).
- Baked directly into each start-time reminder schedule's cron expression
  as a `CRON_TZ=<zone>` prefix (`lib/qstash-schedules.ts`) — QStash
  evaluates the schedule against that zone itself, so DST is handled for
  free without this app doing any offset math for that path at all.

- **No self-serve company *creation* UI exists in this codebase** (see
  CLAUDE.md's "Multi-Tenancy" — a company's first manager is still attached
  by hand in MongoDB), so there is no signup-time form field to capture a
  browser-guessed timezone from. **What's actually built**: `timezone` is a
  plain manager-editable field on Company Settings
  (`components/CompanySettingsView.tsx`, `GET`/`PATCH
  /api/company/settings`), including a "Detect" button that reads
  `Intl.DateTimeFormat().resolvedOptions().timeZone` from whichever
  manager's browser clicks it.
- **A company with `timezone: null` is skipped entirely by the missed-list
  sweep**, and `upsertStartTimeSchedule` refuses to create/update a
  schedule without one (deleting any existing schedule instead) — never
  guessed at, never defaulted silently.
- **Changing a company's timezone re-upserts every one of its shift-window
  lists' schedules** (`app/api/company/settings/route.ts`'s `PATCH`) —
  each schedule has the OLD timezone baked into its own `CRON_TZ` prefix,
  so a correction needs to propagate to all of them immediately, not wait
  for the next time each list happens to be edited.
- **Existing companies** (pre-dating this field being load-bearing) are
  backfilled by `scripts/backfill-company-timezone.mjs` — defaults every
  company with a null timezone to `America/Chicago` and logs each one so a
  developer can correct it by hand once its real zone is known.

## Data model

- **`models/PushToken.ts`** — `{ userId, companyId, token, environment:
  "sandbox" | "production", platform: "ios", createdAt, lastSeenAt }`. One
  row per device, not per user. Distinct from the Live Activity push token
  (`User.liveActivityPushToken`, ephemeral and tied to one running timer)
  — this is a persistent, standing device token for ordinary remote
  notifications. Registered by any signed-in company user, manager or
  employee (see "Device registration" below) — this route/model doesn't
  know or care which alert type(s) a given token ends up receiving.
  Index: `{ token: 1 }` unique, `{ companyId: 1 }` (the alert fan-out
  query).
- **`models/MissedListAlert.ts`** — `{ companyId, taskListId, date,
  sentAt }`. Dedup guard for the **missed** sweep only — unique index on
  `{ companyId: 1, taskListId: 1, date: 1 }`, enforced via a `try`/`catch`
  on the Mongo duplicate-key error (`code 11000`) around `create()`, not a
  separate find-then-write. Doubles as a lightweight audit trail. **No
  equivalent table exists for start-time reminders** — each QStash fire of
  a per-list schedule is already a distinct, non-repeating occurrence by
  construction, so there's no "did we already send today" to check.
- **`TaskList.qstashScheduleId: string | null`** — the QStash schedule ID
  backing this list's own start-time reminder. Deterministic
  (`tasklist-<this list's _id>`, see `lib/qstash-schedules.ts`), so this
  field is really a cache/audit trail rather than the source of truth —
  but storing it means a delete can skip calling QStash at all for a list
  that never had one. `null` = no live schedule (an anytime list, a list
  with an empty `scheduledDays`, or a company with no timezone set).
- **`Company.notificationsEnabled: boolean`** (default `true`) — a single
  company-wide kill switch covering **both** alert types. For missed-list
  alerts this is checked by the sweep itself (a disabled company is
  filtered out before any list is even evaluated). For start-time
  reminders, schedules keep firing regardless of this flag (deleting/
  recreating every list's schedule on every toggle wasn't worth the
  churn) — `app/api/cron/task-list-reminder` checks the flag at send
  time instead and no-ops if it's off. No per-manager mute in v1 (see
  "Deferred" below).
- **`Company.missedAlertGraceMinutes: number | null`** (default `30`) —
  manager-editable from Company Settings (`GET`/`PATCH
  /api/company/settings`), one value for the whole company, applied to
  every shift-window list (not per-list — see "Deferred" below). Fed
  straight into `lib/task-list-window.ts`'s `isPastGraceWindow` by the
  sweep in place of the old hardcoded `MISSED_LIST_GRACE_MINUTES`
  constant. **`null` turns missed alerts off entirely for this company**
  — a strictly narrower switch than `notificationsEnabled` above, since it
  leaves start-time reminders untouched. `undefined` (a company document
  that predates this field) is treated as the original flat 30-minute
  default everywhere this is read — `DEFAULT_MISSED_LIST_GRACE_MINUTES` in
  `lib/task-list-window.ts` — not as "off"; only an *explicit* `null`
  means off. Validated server-side to `null` or an integer `0`–`240`.

No changes to `Task`/`TaskDefinition`/`TaskLog` — this reads existing
state, it doesn't add fields to the things it's checking.

## Device registration (client side)

Reuses the general shape already established for Live Activity's push-token
forwarding (`components/NativeBootstrap.tsx`,
`lib/native/routine-activity.ts`), but this is a genuinely new capability,
not a reuse of the existing ActivityKit token flow — ordinary remote
notifications need their own explicit permission grant:

1. **`@capacitor/push-notifications`** (official Capacitor plugin) is
   installed and synced into the iOS project (`npx cap sync ios`) — same
   "prefer an official/community plugin over hand-written native code"
   pattern already used for `@capacitor-community/sqlite` and
   `@capacitor/network`.
2. **`lib/native/push-notifications.ts`**'s `registerAlertPushNotifications()`,
   called from `components/NativeBootstrap.tsx` on every native cold
   start. It first checks `GET /api/session/role` for a non-null
   `companyId` — a small, deliberately narrow endpoint kept just for this
   gate — and bails silently for anyone not attached to a company. **Both
   managers and employees are prompted**, since start-time reminders reach
   employees too; missed-list alerts stay manager-only via a filter at
   send time (`lib/notifications.ts`), not a registration-time
   restriction.
3. It checks/requests permission (`PushNotifications.checkPermissions()` /
   `requestPermissions()`). iOS shows its own system permission prompt —
   not skippable, not customizable, same category of OS-owned prompt as
   the NFC Universal Link confirmation.
4. On grant, `PushNotifications.register()` yields a token via the
   `registration` listener → `POST /api/push-tokens { token }`.
   **Deviation from the original spec**: `environment` is not sent by the
   client at all — `app/api/push-tokens/route.ts` **hardcodes it to
   `"sandbox"`**. An earlier version inferred it from
   `process.env.NODE_ENV` (mirroring `LiveActivityPlugin.swift`'s own
   `#if DEBUG` tagging in spirit), which was backwards: server environment
   has nothing to do with which APNs host a device token is valid
   against, and it produced a 100% failure rate in practice, not a rare
   edge case — every token got tagged `"production"` (Vercel prod always
   sets `NODE_ENV=production`) while `ios/App/App/App.entitlements`
   hardcodes `aps-environment: development` for **every** build, Debug or
   Release, so every real device token is only ever valid against APNs'
   sandbox host regardless of which server answered the registration
   request. Confirmed as the actual cause of a real "no notifications
   despite everything else working" report in production. Revisit the
   moment that entitlement becomes genuinely build-configuration-dependent
   (a real Release/Distribution/TestFlight/App Store path) — until then,
   `"sandbox"` is simply correct, not a compromise.
5. A denied/undetermined permission is not re-prompted automatically on
   every launch. **Not yet built**: a dismissible in-app banner for a
   manager whose company has `notificationsEnabled: true` but no
   registered token — deferred, see "Deferred / open questions" below.

**Native rebuild required**: adding `@capacitor/push-notifications` means
`npx cap sync ios` alone isn't enough to actually get this running on a
device — the plugin's native code has to be compiled into the app binary
via Xcode (Clean Build Folder, then Build & Run to a **physical device** —
the Simulator can't receive real APNs pushes) before the permission
prompt can appear at all.

## Start-time reminders

An earlier version of this feature considered a nightly batch job that
pre-schedules the next day's reminders as one-off delayed messages.
**Rejected**: anything created or edited *after* that night's run — a
company signing up mid-morning, a manager adding or rescheduling a list at
10am for an 11am start — would silently get no reminder until the
following day. A shared polling sweep (checked next) was also considered
and briefly built, then scrapped: a poll rounds to its own interval, and
"starts now" read oddly arriving several minutes early or late.

**What's actually built: each shift-window list gets its own standing
QStash schedule**, created/updated the moment the list's `startTime`/
`scheduledDays` (or its company's `timezone`) changes — never batched:

- **`lib/qstash-schedules.ts`**'s `upsertStartTimeSchedule({ taskListId,
  startTime, scheduledDays, timezone })` builds a `CRON_TZ=<timezone> M H
  * * <days>` cron expression from the list's `startTime`/`scheduledDays`
  (`M`/`H` from splitting `"HH:MM"`; `<days>` is `scheduledDays.join(",")`
  — `0=Sun..6=Sat`, exactly matching standard cron day-of-week syntax) and
  `POST`s to QStash's `/v2/schedules/{destination}` with an
  `Upstash-Schedule-Id: tasklist-<taskListId>` header — a deterministic,
  self-chosen ID. **QStash overwrites in place when a schedule with that
  ID already exists**, so "upsert" is genuinely just "call create again" —
  no separate read-then-decide-update-or-create step needed. Returns
  `null` (deleting any existing schedule instead) for an anytime list, an
  empty `scheduledDays`, or a company with no `timezone` yet.
- **`deleteStartTimeSchedule(taskListId)`** — `DELETE`s the deterministic
  schedule ID. Best-effort: swallows any error (missing schedule, missing
  `QSTASH_TOKEN`, network hiccup) rather than letting it block the caller.
- **Wired into every place a list's schedule-relevant fields can change**:
  - `POST /api/task-lists` (create) — upserts after the list is created,
    stores the returned ID.
  - `PATCH /api/task-lists/[taskListId]` — re-upserts only when
    `startTime` and/or `scheduledDays` was actually part of the request
    body (a pure rename skips this entirely).
  - `DELETE /api/task-lists/[taskListId]` (soft delete) — deletes the
    schedule outright (not soft — nothing reads a deleted schedule's
    history) and clears `qstashScheduleId`.
  - `POST /api/task-lists/[taskListId]/duplicate` — the duplicate inherits
    the source's `startTime`/`scheduledDays`, so it gets its own
    independent schedule too.
  - `PATCH /api/company/settings` (timezone change) — re-upserts every
    active shift-window list's schedule for that company, since each
    schedule's `CRON_TZ` prefix is now stale otherwise.
  - Every one of these is **best-effort**: a QStash failure is logged, not
    thrown — it shouldn't block the underlying task-list/settings mutation
    itself, same "accepted tradeoff" reasoning as a missed push being
    lower-stakes than a missed task.
- **Because a schedule computes its own next occurrence from whenever it's
  created**, a list made at 10am for an 11am start fires correctly at
  11am *today* — no batch run to have missed, no special-casing for "is
  this happening today."

### Route + payload

- **Route**: `app/api/cron/task-list-reminder/route.ts`. Verifies the
  QStash signature (same `Receiver.verify()` pattern as the sweep). The
  request body carries `{ taskListId }` (set once at schedule-creation
  time, not derived at fire time) — so this route just looks that list up,
  it doesn't need to figure out "which list is this" from a timestamp.
  Skips silently (still `200`, so QStash doesn't retry a legitimate
  no-op) when: the list is missing/inactive, its company has
  `notificationsEnabled: false` or no `timezone`, nothing's scheduled on
  the list today (`isTaskVisibleOn`), or every visible task already has a
  terminal `TaskLog` (`done`/`missed`) for today — an early-arriving
  employee may have already worked through everything before the
  scheduled time, and a reminder to start something already finished would
  read as a bug, not a nudge.
- **Payload**: title = list name, body = `"Time to start <list name>"`,
  `{ taskListId, date, alertType: "start_time" }` custom data.
- **Audience**: `lib/notifications.ts`'s `sendStartTimeReminder()` — every
  company user, managers and employees both (via the shared
  `sendPushToUsers` helper, same one `sendMissedListAlert` uses).
- **No dedup table** — see "Data model" above.

## Missed-list alerts

### What counts as "missed"

Only **shift-window lists** (`startTime` non-null) are eligible — an
anytime list never closes, so "missed by the window" has no meaning for
it (see [task-lists.md](task-lists.md)'s "Time-aware collapse"). The
condition, evaluated per `(company, list, today)` in
`app/api/cron/check-missed-lists/route.ts`:

1. Compute the list's derived end time via `lib/task-list-window.ts`'s
   `deriveCollapseAfter(startTime, totalProjectedMinutes)` — the exact
   same pure function `components/TaskListCard.tsx` calls client-side for
   its own collapse logic (extracted out of that component specifically
   so the two can never diverge — same "one pure function, two callers"
   pattern as `lib/task-progress.ts`/`lib/placement-resolution.ts`).
   `totalProjectedMinutes` is summed only over today's **visible**,
   non-checkbox tasks (`lib/task-visibility.ts`'s `isTaskVisibleOn`,
   applied before the sum — unlike the client's own inline computation in
   `TaskListCard.tsx`, which currently sums over every task regardless of
   today's visibility; a known, pre-existing divergence between the two,
   not introduced by this feature).
2. **Grace period**: end time + `Company.missedAlertGraceMinutes` (a
   manager-configurable, company-wide value — default 30, editable from
   Company Settings; `DEFAULT_MISSED_LIST_GRACE_MINUTES` in
   `lib/task-list-window.ts` is only the fallback for a company document
   that predates this field). Before that, nothing fires, even if the list
   is behind. **A company with this set to `null` is skipped by the sweep
   entirely** (filtered out alongside `notificationsEnabled`/`timezone` —
   see "The sweep job" below) — the manager turned missed alerts off.
3. Now (via `minutesNowInZone(company.timezone)`, **not** server UTC or
   any requesting device's own offset) must be past that grace-adjusted
   time.
4. At least one task scheduled today (`isTaskVisibleOn`) on that list is
   **not** in a terminal state (`done`/`missed`) — i.e. still
   `pending`/`in_progress`/`paused`, or has no `TaskLog` row at all for
   today.
5. A list with **zero** tasks scheduled today is skipped entirely.
6. No `MissedListAlert` row already exists for `(companyId, taskListId,
   today's date)`.

**One alert per list per day, a digest, not one push per missed task.**

### The sweep job

- **Schedule**: `*/5 * * * *` (every 5 minutes — 288 messages/day, well
  within QStash's free-tier 1,000/day cap), targeting `POST
  https://chrps.vercel.app/api/cron/check-missed-lists`. Created via the
  `@upstash/qstash` schedule API — schedule id
  `scd_78Le9ufNBjK2MwErCFtrNz4nsfXH` (see "Setting it up" below). This is
  the ONE shared schedule this alert type needs — start-time reminders
  above are a structurally separate mechanism with their own
  per-list schedules, not additional cadence on this one.
- **Route**: `app/api/cron/check-missed-lists/route.ts`. Verifies the
  request came from QStash via `@upstash/qstash`'s `Receiver.verify()`
  against the `Upstash-Signature` header, using `QSTASH_CURRENT_SIGNING_KEY`
  / `QSTASH_NEXT_SIGNING_KEY` (both, since Upstash rotates signing keys).
  Rejects (`401`) anything that doesn't verify — this route is otherwise
  unauthenticated, so signature verification **is** the auth boundary
  here, same conceptual role `assertNfcVerified` plays for a scan.
- **Logic**: for every `Company` with `notificationsEnabled !== false`, a
  non-empty `timezone`, and `missedAlertGraceMinutes !== null` — filtered
  in application code, not via an exact Mongo match, since every Company
  in this app is hand-inserted directly in MongoDB and can easily be
  missing any of these fields entirely; an exact `{ notificationsEnabled:
  true }` query would silently exclude those, same reasoning as the `?? true`
  fallback used elsewhere (an *unset* `missedAlertGraceMinutes` still
  passes this filter and resolves to `DEFAULT_MISSED_LIST_GRACE_MINUTES` —
  only an explicit `null` is treated as "off") — compute "now"
  in that company's zone, find its shift-window lists, apply the "what
  counts as missed" conditions above (using that company's own resolved
  grace minutes), and for every list that qualifies:
  write the `MissedListAlert` row **first** (write-then-send — a crash
  mid-send can't cause a duplicate on the next run), then fan out a push
  (`lib/notifications.ts`'s `sendMissedListAlert()`) to every registered
  `PushToken` belonging to that company's managers. Each company and each
  list is wrapped in its own `try`/`catch` (logged, not thrown) so one bad
  list/company can't abort the whole sweep.
- **Batching**: one job run processes every company in a single request —
  fine at current scale, revisit only if company count grows enough that
  one route invocation risks the function's max duration.

### Push payload

- **Title**: the task list's own name (e.g. "Closing Shift").
- **Body**: `"N task(s) not finished — window closed at H:MMam/pm"`.
- **Custom data**: `{ taskListId, date, alertType: "missed" }`.
- **Tap behavior**: **not yet built.** A `pushNotificationActionPerformed`
  listener navigating to `/tasks?openTaskListId=<id>&date=<date>` would
  expand straight to the relevant list; no such listener wiring exists in
  `lib/native/push-notifications.ts` or elsewhere yet — a tap today just
  opens the app to wherever it would normally land. Flagged in "Deferred /
  open questions" below since it's a real gap, not a deliberate v1 cut.

## Failure handling

- **APNs `BadDeviceToken` / `Unregistered`** response for a given token →
  `lib/apns.ts`'s `sendAlertPush` throws an `ApnsPushError` carrying the
  parsed `reason`; `lib/notifications.ts`'s shared `sendPushToUsers` send
  loop (used by both `sendStartTimeReminder` and `sendMissedListAlert`)
  deletes that `PushToken` row inline when it matches either reason. A
  stale token (uninstalled app, reissued token) stops being retried rather
  than accumulating as dead weight.
- **QStash's own retry, missed-list sweep**: if `check-missed-lists`
  itself errors or times out, QStash retries the whole invocation on its
  own schedule — the write-then-send ordering means a retried run won't
  re-alert a list that already got its dedup row written, even if the
  *push send* itself is what failed originally. Accepted tradeoff: a send
  failure after the dedup row is written means that list silently doesn't
  get a retry push this run.
- **QStash's own retry, start-time reminders**: there's no dedup row here
  at all — a retried delivery is exactly QStash's documented
  at-least-once behavior, and could in rare cases double-send the same
  reminder. Harmless enough for a "starts now" nudge to not be worth
  guarding against in v1.
- **`upsertStartTimeSchedule`/`deleteStartTimeSchedule` failures** — every
  call site (task-list CRUD, company settings) wraps these in its own
  `try`/`catch` and only logs; a QStash outage means that particular list's
  schedule doesn't get created/updated/deleted, but the underlying
  mutation (the list itself, the settings change) still succeeds.

## Gotcha: `middleware.ts` must exclude `api/cron`

**Found in production, fixed**: `middleware.ts`'s global auth gate rejects
any `/api/*` request with no signed-in session as `{"error":"Unauthorized"}`
— which is exactly what QStash's calls to both cron routes look like, since
they authenticate via the `Upstash-Signature` header instead, checked
*inside* the route handler. Without an explicit exclusion, the middleware
short-circuits the request before either route's own `Receiver.verify()`
ever runs, so the route's own "Missing signature"/"Invalid signature"
responses never actually appear — every call just gets the middleware's
generic 401 instead. Confirmed via QStash's own delivery logs (`GET
{QSTASH_URL}/v2/events?scheduleId=<id>`): the response body decoded to
`{"error":"Unauthorized"}` with NextAuth `Set-Cookie` headers attached,
not either message the route code actually returns. Repeated failures
caused QStash to auto-pause the missed-list sweep's schedule entirely
(`isPaused: true`) — **check `GET {QSTASH_URL}/v2/schedules/<id>` and
resume it (`POST {QSTASH_URL}/v2/schedules/<id>/resume`) after deploying
the fix**, since a paused schedule stays paused on its own.

**The fix**: `middleware.ts`'s `matcher` config now excludes `api/cron`
alongside the pre-existing `api/auth` exclusion. Any future route that
authenticates itself (an API key, a webhook signature, anything other than
a NextAuth session) needs the same treatment — this middleware's default
is deny-without-session, not opt-in.

## API routes

| Route | Method | Gate | Purpose |
|---|---|---|---|
| `/api/push-tokens` | POST | any signed-in company user | register/refresh this device's token |
| `/api/session/role` | GET | any signed-in user | tiny session lookup, used only to gate the native permission prompt to signed-in company users |
| `/api/cron/check-missed-lists` | POST | QStash signature only | the missed-list sweep |
| `/api/cron/task-list-reminder` | POST | QStash signature only | one list's exact-startTime fire |
| `/api/company/settings` | GET/PATCH | any signed-in user (GET) / manager (PATCH) | gains `timezone`/`notificationsEnabled`/`missedAlertGraceMinutes`; a timezone change re-upserts every list's schedule |
| `/api/task-lists` | POST | manager (existing route) | gains the schedule-upsert side effect |
| `/api/task-lists/[taskListId]` | PATCH / DELETE | manager (existing route) | gains the schedule upsert / delete side effect |
| `/api/task-lists/[taskListId]/duplicate` | POST | manager (existing route) | gains the schedule-upsert side effect |

## Files

- `models/PushToken.ts`, `models/MissedListAlert.ts` — new.
- `models/Company.ts` — gained `notificationsEnabled`, then later
  `missedAlertGraceMinutes` (`number | null`, default `30`); `timezone`
  already existed (stubbed) and is now load-bearing.
- `models/TaskList.ts` — gained `qstashScheduleId`.
- `lib/task-list-window.ts` — new. The extracted, shared window math for
  the missed-list sweep — `deriveCollapseAfter`, `isPastGraceWindow`/
  `DEFAULT_MISSED_LIST_GRACE_MINUTES` (originally a single hardcoded
  `MISSED_LIST_GRACE_MINUTES` constant every company shared; `
  isPastGraceWindow` now takes the caller's resolved per-company
  `graceMinutes` as a required parameter instead). (An earlier version of
  this file also had `isPastStartGrace`/`NOT_STARTED_GRACE_MINUTES` for a
  polling-based start-time check — removed when that approach was replaced
  by per-list QStash schedules.) `components/TaskListCard.tsx` was
  refactored to call the shared `deriveCollapseAfter`/`isPastWindow`/
  `isBeforeWindow` instead of its own local copies (it does not call
  `isPastGraceWindow` — that's sweep-only).
- `lib/qstash-schedules.ts` — new. `upsertStartTimeSchedule()`/
  `deleteStartTimeSchedule()`, the per-list QStash schedule management
  backing start-time reminders.
- `lib/notifications.ts` — new. A shared `sendPushToUsers()` send loop plus
  two thin callers, `sendStartTimeReminder()` (fans out to every company
  user) and `sendMissedListAlert()` (managers only) — both wrap
  `lib/apns.ts`'s signing/HTTP2 send with their own payload shape.
- `lib/apns.ts` — gained `sendAlertPush()` and the `ApnsPushError` class,
  alongside the pre-existing `sendLiveActivityPush()`.
- `lib/native/push-notifications.ts` — new. `registerAlertPushNotifications()`,
  gated on having a company (not on role).
- `app/api/cron/check-missed-lists/route.ts`, `app/api/cron/task-list-reminder/route.ts`,
  `app/api/push-tokens/route.ts`, `app/api/session/role/route.ts` — new.
- `app/api/company/settings/route.ts` — gained `timezone`/
  `notificationsEnabled`/`missedAlertGraceMinutes` on `GET`/`PATCH`, plus
  the schedule re-upsert side effect on a timezone change.
- `app/api/task-lists/route.ts`, `app/api/task-lists/[taskListId]/route.ts`,
  `app/api/task-lists/[taskListId]/duplicate/route.ts` — gained the
  schedule upsert/delete side effects.
- `components/CompanySettingsView.tsx` — gained a timezone `<select>` (plus
  a browser-detect button), a single "Checklist Alerts" toggle switch
  covering both alert types, and a "Missed Alert Timing" section (its own
  on/off toggle plus a minutes input, mapping to
  `Company.missedAlertGraceMinutes`), alongside the existing
  `notificationSound` control.
- `components/NativeBootstrap.tsx` — gained a call to
  `registerAlertPushNotifications()` alongside the existing Live Activity
  push-token forwarding call.
- `scripts/backfill-company-timezone.mjs` — new, one-off migration script.

## Setting it up

1. ~~Create an Upstash account, a QStash instance — free tier.~~ Done.
2. ~~Set `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`,
   `QSTASH_NEXT_SIGNING_KEY` on Vercel's production env.~~ Done, confirmed
   working. **Also required and initially missed: `QSTASH_URL`** — the
   Upstash account's own *regional* endpoint (e.g.
   `https://qstash-us-east-1.upstash.io`), needed by
   `lib/qstash-schedules.ts`'s outbound calls (creating/deleting a list's
   start-time reminder schedule). Without it, that code falls back to the
   generic `https://qstash.upstash.io` endpoint, which misroutes for some
   accounts ("user not found in this region") — the failure is swallowed
   by the best-effort `try`/`catch` at every call site, so a task list
   still saves fine, it just silently gets no schedule and nothing shows
   up in QStash's logs. All four vars are documented in
   `project-structure.md`'s Secrets Policy list and CLAUDE.md's
   Environment Variables section.
3. ~~Create the missed-list sweep's schedule.~~ Done — one-time, manual:
   `scd_78Le9ufNBjK2MwErCFtrNz4nsfXH`, `*/5 * * * *`, targeting
   `https://chrps.vercel.app/api/cron/check-missed-lists`. Manage/inspect
   via the Upstash console (QStash → Schedules) or `GET
   {QSTASH_URL}/v2/schedules/scd_78Le9ufNBjK2MwErCFtrNz4nsfXH`. **Confirmed
   working in production**: `lastScheduleStates` on that schedule shows a
   `SUCCESS` delivery after the `api/cron` middleware exclusion (see
   "Gotcha" below) deployed and the schedule — which QStash had
   auto-paused after enough consecutive 401s — was manually resumed
   (`POST {QSTASH_URL}/v2/schedules/<id>/resume`). **Start-time reminder
   schedules need no manual setup at all** — they're created/updated/
   deleted automatically by the task-list CRUD/company-settings routes
   above, one per shift-window list, the first time each is saved through
   the app (once `QSTASH_TOKEN`/`QSTASH_URL` are both set — see step 2).
4. **Still outstanding**: run `scripts/backfill-company-timezone.mjs`
   against production once, so pre-existing companies aren't silently
   skipped forever (both alert types need a timezone; the missed-list
   sweep already correctly skips a company with none, and
   `upsertStartTimeSchedule` refuses to create a schedule without one —
   this step is about actually getting them a timezone).
5. Xcode: **the `App` target's `aps-environment` entitlement already
   exists** (added for the Live Activity work), so no new entitlement is
   needed for ordinary alert push. **Background Modes → Remote
   notifications** isn't strictly required for a visible alert push (that
   capability is for *silent*/background-waking pushes) — left undone,
   add later only if a future feature needs it.
6. **A fresh native rebuild is required** — see "Device registration"
   above's last paragraph.
7. A physical device is required to test end to end — the Simulator can't
   receive real pushes.

## Deferred / open questions

- **Tap-to-deep-link behavior** — see "Push payload" above. This is a real
  gap in the current build, not a deliberate v1 cut.
- **In-app "no token registered" banner** — see "Device registration"
  above. Not yet built.
- **QStash's 10-active-schedules cap on the free tier** — every
  shift-window list consumes one schedule (the missed-list sweep's own
  shared schedule is the 1 extra). At more than ~9 concurrent
  shift-window lists across all companies, `upsertStartTimeSchedule` calls
  will start failing (logged, not thrown — a list just silently has no
  start-time reminder until this is addressed). Revisit once real usage
  approaches this, either by upgrading QStash's plan (usage-based past
  1,000 schedules) or reconsidering the polling approach for the busiest
  companies. Not designed around pre-emptively.
- **Par-level inventory alerts** — same missed-list QStash infra, a
  different condition (`InventoryLog` latest count vs.
  `InventoryItemType.parLevel`) and a different dedup key. Natural
  fast-follow once this ships.
- **Per-list configurable grace period (missed alert only)** — **built at
  the company level** (`Company.missedAlertGraceMinutes`, including an
  "off" state — see "Data model" and "Missed-list alerts" above), but
  still one value for every shift-window list within a company, not
  configurable per individual list. A company running very different
  shift lengths across lists (e.g. a 10-minute Anytime-style check vs. a
  long Closing Shift) can't give them different grace periods yet. Start-
  time reminders have no grace period to configure — they fire exactly at
  `startTime` by construction.
- **Email fallback** for a user who never grants push permission — no
  transactional email provider exists in this stack yet.
- **Per-user mute, or per-alert-type toggle** — v1 is a single
  all-or-nothing `Company.notificationsEnabled`. Deferred.
- **A "resolved" follow-up push** once a late list finally gets finished —
  not built; felt like it'd add noise more than value.
- **Multi-location digest** (a single cross-location summary push for an
  owner) — still deferred, but the underlying multi-location data model
  this bullet used to wait on now exists (see CLAUDE.md's "Locations"
  section, and `docs/features/locations.md`'s "Notifications fan-out" for
  how both alert types already fan out per-location today, including the
  start-time-reminder per-list QStash schedule becoming naturally
  per-location once `TaskList` itself became location-owned). This bullet
  is now about a genuinely new feature (a rollup digest), not a
  data-model blocker.
- **Self-serve company creation / signup-time timezone capture** — not
  built because the underlying company-creation flow itself doesn't exist
  yet in this codebase.
- **Reconciling schedule drift** — nothing currently re-verifies that
  every shift-window list's `qstashScheduleId` still matches a live QStash
  schedule (e.g. if one was deleted out-of-band via the Upstash console,
  or a webhook call to create one failed silently mid-request before the
  ID could be saved). A periodic reconciliation pass is the obvious fix
  but is itself the nightly-batch-shaped job this design otherwise avoids
  — worth a deliberate look once this has run in production for a while.

## Depends on

[`task-lists.md`](task-lists.md) — `TaskList.startTime`/`scheduledDays`,
the derived collapse/end-time math, `isTaskVisibleOn`, and the `TaskLog`
states this checks for completeness. [`live-activity.md`](live-activity.md) —
`lib/apns.ts`'s signing/send logic, reused rather than rebuilt.
[`offline.md`](offline.md) — none functionally, but worth noting: a list
finished entirely offline and not yet synced back to the server will look
"still open" to the missed-list sweep until the device reconnects and
flushes its queue; an edge case, not treated as a bug to fix here.
