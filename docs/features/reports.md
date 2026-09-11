> **Keep this file updated after any code change in this area — do not let it drift from actual implementation.**

# Reports

Renamed from "Analytics" — a real-world label managers and employees recognize. `app/(app)/reports/page.tsx` → `ReportsView` → `ReportsContent` (`components/ReportsContent.tsx`, `"use client"`), a thin segmented-control dispatcher over two sub-tabs: **Overview** (chart-based trends, split by role below) and **Logs** (a chronological history, new — see "Logs tab" below). Both are backed by `GET /api/reports` (`app/api/reports/route.ts`, renamed from `/api/analytics`) and, for Logs, the new `GET /api/task-logs/history` (`app/api/task-logs/history/route.ts`).

These live inside the Reports page itself, **not** a new bottom-nav slot — the nav's 4th placeholder (see [team-invites.md](team-invites.md)'s "Team tab UI" section) is untouched.

## Location scoping

Every query in `GET /api/reports`/`/api/reports/leaderboard`/`/api/reports/inventory`/`GET /api/task-logs/history` resolves its `locationId` via `pickActiveLocationId` (`lib/session.ts`) — for an employee/manager this is always just their own location; for an owner it's their location-switcher selection, defaulting to their own location if unset. `ReportsView` renders `components/LocationSwitcher.tsx` under its `<Header>` so an owner can actually change it — see [`locations.md`](locations.md)'s "Location switcher". Since each of `ReportsContent`'s four sub-tabs (`ManagerOverview`/`EmployeeOverview`/`LogsTab`/`InventoryTab`) fetches its own data once on mount, `ReportsView` remounts the whole `ReportsContent` subtree (via a `key` bump) when the switcher changes, rather than threading a refetch callback through all four.

## Role split

- **Managers** see the company-wide dashboard that existed before this split, unchanged.
- **Employees** see a personal-only view scoped to their own logs — a way to review their own work, not the whole team's.

`app/api/reports/route.ts` branches on `resolveSessionUser().role`: when `role === "employee"`, the `TaskLog` query gets an extra `performedByUserId: session.userId` filter. Every downstream aggregate (`taskListStats`, `taskStats`, `weeklyProgress`) folds over that filtered log set without touching `performedByUserId` itself, so this one filter personalizes the whole response automatically — no per-field special-casing needed. `TaskList.find({companyId})` and `Task.find({companyId, isActive:true})` stay unscoped by user in both branches — they're the shared catalog (what's expected), not activity (who did it).

One consequence worth knowing: `taskListStats[].totalTasks`/`totalProjectedMins` stay **company-wide catalog counts** even for an employee — a list with 5 tasks still shows `totalTasks: 5` even if this employee personally only logs 2 of them because of shift patterns (Task has no assignee concept — any employee can complete any task, see `models/Task.ts`). The denominator is "the schedule," matching `computeWeeklyProgress`'s existing philosophy, not a new special case. This means an employee's completion % can legitimately reflect a teammate's shift-shared task, not something they personally missed.

Role gates this outright for v1 — a manager always gets company-wide, an employee always gets self-only; there's no "view my own numbers" opt-in for a manager who also works shifts.

## Overview tab

### Manager — the pre-split dashboard, unchanged

`components/reports/ManagerOverview.tsx`. Two windows, both computed server-side by `getDates(days, anchorDate)`:

- **7-day** — a **fixed Sunday–Saturday calendar week** containing `anchorDate` (`lib/week-dates.ts`'s `calendarWeekDates`, the same helper `StreakDots` uses — see [task-lists.md](task-lists.md#streaks--variance)). This can include dates *after* `anchorDate` (later this week) — the client renders those as a distinct pending state rather than pretending they're "no data" days. The frame is always 7 slots wide regardless of what day of the week `anchorDate` is.
- **30-day** — a trailing window of the 30 days ending at `anchorDate`. By construction this never contains a future date, so none of the pending-state logic below ever applies to it.

`anchorDate` is the client's local date (`?localDate=`, computed client-side via `toLocaleDateString("en-CA")`) — never derived from server UTC. The response echoes it back as `today`.

**Denominators exclude days that haven't happened yet**: per-day breakdowns (`daily`) always include every date in the window, including future ones, for a consistent chart width. Aggregate denominators (`tasks[].totalDays`, `tasks[].unloggedCount`) are computed over `elapsedDates` (`dates.filter(d => d <= anchorDate)`) instead.

**Rendering**: `components/reports/TaskListChart.tsx` renders each task list's `daily` array as a bar chart, with a dashed hollow placeholder for future dates and a bolded gold today-marker when `showLabels` (7-day view only). `components/reports/TaskStatRow.tsx` (renamed from the old inline `TaskRow` inside `AnalyticsContent.tsx` — **not** `components/TaskRow.tsx`, the Tasks page's own per-day row) renders, for the 7-day view, a schedule-aware 7-segment day strip + pacing badge via `lib/task-progress.ts`'s `computeWeeklyProgress` (see [task-lists.md](task-lists.md#weekly-schedule--success-threshold)); the 30-day view falls back to a flat completion-rate bar.

### Employee — personal, new

`components/reports/EmployeeOverview.tsx`. Fetches the identical `/api/reports` endpoint (already personalized server-side by the role split above) and renders, top to bottom:

1. **Summary strip** — three at-a-glance stats in a single card:
   - **Current streak** — see "Current streak" below.
   - **This week's completion rate** — a single %, aggregated across every task's own `weeklyProgress.successCount`/`successThreshold` (only meaningful in the 7-day view — hidden in the 30-day view, since a weekly threshold has no clean meaning against a trailing 30-day window).
   - **Tasks logged today** — a count of this person's tasks with a `done` state on `today`.
2. **Charts, scoped to self** — the exact same `TaskListChart`/`TaskStatRow` components the manager view uses, reused as-is, fed the already-personalized data. No employee-specific chart code exists — only the summary strip above is new UI.

### Current streak

No numeric "current streak" existed anywhere in this codebase before this feature — only `StreakDots`' 7-dot weekly visual and `computeWeeklyProgress`'s weekly %. `lib/streak.ts` adds one, computed employee-only (bundled into `/api/reports`'s response as `currentStreak`, `undefined` for a manager):

- Walking backward from `today` (or from **yesterday** if today still has an unresolved scheduled task — an in-progress day shouldn't prematurely break the streak), a day counts toward the streak if **every one of the company's active tasks scheduled on that weekday** has a `done` log from this specific person. (A `rest` state existed here too until it was retired — see CLAUDE.md's "Skip Types"; a pre-existing `TaskLog` with that state no longer protects a streak.)
- A day with zero scheduled tasks is skipped over — it neither extends nor breaks the streak.
- The streak ends at the first fully-in-the-past day with a missed or unlogged scheduled task, or after `maxLookbackDays` (default 365).
- Deliberately checks the **full active task catalog**, not "tasks this person has personally ever logged" — same "denominator is the schedule, not who logged it" philosophy as the role split above. This means an employee's streak can legitimately break because a teammate left a shift-shared task unlogged, not something the employee themselves missed — a known, accepted quirk, not a bug.
- `computeCurrentStreak` (pure, unit-testable) does the walk; `computeCurrentStreakForUser` (DB-fetching wrapper) resolves the "today or yesterday" start date and fetches a bounded window of this person's `TaskLog`s.
- Supported by a new index on `models/TaskLog.ts`: `{ companyId: 1, performedByUserId: 1, date: 1 }` — neither pre-existing index covered `performedByUserId`.

## Logs tab

A flat, chronological, filterable history — the audit-trail / "verifiable proof" view, most recent first. New: `GET /api/task-logs/history` (`app/api/task-logs/history/route.ts`), rendered by `components/reports/LogsTab.tsx`.

This is a **separate route from `GET /api/task-logs`**, not an extension of it — that existing route only supports a single `date` param and returns the whole company's logs for that one day (built for "what happened today" screens: the FAB, `TasksView`, `TaskListSessionView`, all of which depend on its current simple contract). The new route is a date-**range**, paginated, denormalized query built for history browsing.

**Query params**: `startDate`, `endDate` (`YYYY-MM-DD`, both required — no unbounded "all time" query; 400 if `startDate > endDate`); `userId?` (manager-only); `taskListId?`; `page?` (default 1), `limit?` (default 30, capped at 100).

**Scoping** (`resolveSessionUser()`, never trusted from the client):
- Employee → always forced to `performedByUserId: session.userId`, regardless of any `userId` the client sends.
- Manager + `userId` given → that one teammate's logs.
- Manager + no `userId` → **no** `performedByUserId` filter at all — company-wide, every employee's logs. This is the default, matching the manager Overview's own company-wide default.

`taskListId` filtering resolves to a `taskId` set first (`Task.find({companyId, taskListId}, "_id")`) since `TaskLog` has no `taskListId` of its own — same join-direction pattern `/api/reports` already uses for its per-list start-time attribution.

**Sort**: `{ date: -1, completedAt: -1, startedAt: -1, createdAt: -1 }` — grouping by day first, then falling through completedAt/startedAt/createdAt as tiebreakers, gives "most recent first" including logs with no `completedAt` (missed) without needing a computed sort key.

**Denormalization**: three batch queries regardless of page size — `Task` (joined through `resolveTasks` for name/icon/taskType), `TaskList` (for `taskListName`), `User` (for `performedByName`, skipping any non-ObjectId id such as `SKIP_AUTH`'s dev sentinel).

**Response**:
```ts
{
  logs: Array<{
    _id, date, state, actualMinutes, completedAt, startedAt,
    taskId, taskName, taskIcon, taskType, taskListId, taskListName,
    performedByUserId, performedByName, note, isBackEntry,
  }>;
  page, limit, hasMore, totalCount,
}
```

**Pagination**: simple page/limit with a `hasMore` boolean — no cursor. This is the first paginated route in the codebase; cursor pagination on a sometimes-null `completedAt` field wasn't worth the added complexity at current data scale.

**UI** (`components/reports/LogsTab.tsx`): manager gets a team-member `<select>` (from `GET /api/team`, "All team members" default) and a task-list `<select>` (from `GET /api/task-lists`, "All lists" default), plus two date inputs defaulting to a trailing 14-day window; employee gets the same minus the team-member dropdown (their own logs are already the only ones the server ever returns to them). Every row's per-log performer name is shown regardless of role — an employee's own history just always shows their own name, same as it would to a manager browsing that same teammate's history. "Load more" appends the next page; no infinite-scroll observer (no such pattern exists elsewhere in this app either).

Deferred: exact retention/paging limits for very old date ranges, and a CSV/export option — neither scoped for v1.

## Data shape (`GET /api/reports?days=7|30&localDate=YYYY-MM-DD`)

```ts
{
  dates: string[];   // all dates in the window, oldest → newest
  days: number;
  today: string;     // == localDate, echoed back
  taskLists: Array<{ _id, name, totalTasks, daily: DailyStat[], avgCompletionRate, avgActualMins, totalProjectedMins, avgStartMinutesUtc, startTimeSampleSize }>;
  tasks: Array<{
    _id, name, icon, taskListId, taskListName, projectedMinutes, daily,
    doneCount, missedCount, unloggedCount, avgActualMins, avgVariance,
    completionRate, engagedDays, totalDays, taskType,
    weeklyProgress?: WeeklyProgress; // only when days === 7 — see lib/task-progress.ts
  }>;
  currentStreak?: number; // employee-only — see "Current streak" above; absent for a manager
}
```

`avgStartMinutesUtc` is a task list's average earliest `startedAt` across days it was logged (personal-only for an employee, once role-scoped), still in UTC minutes-since-midnight — the client (`utcMinsToLocalTime`) converts using the browser's own timezone offset, the same UTC-storage/local-display split used throughout the timer system (see [timer.md](timer.md)).

## Files

- `app/api/reports/route.ts` — all Overview aggregation; `getDates` (7-day fixed week vs. 30-day trailing), `elapsedDates` denominator handling, per-task `weeklyProgress`, the role-scoping filter, and the employee-only `currentStreak` call.
- `app/api/task-logs/history/route.ts` — the Logs tab's paginated date-range query.
- `lib/streak.ts` — `computeCurrentStreak` (pure) / `computeCurrentStreakForUser` (DB wrapper).
- `lib/week-dates.ts` — `calendarWeekDates`, shared with `StreakDots`'s date range.
- `lib/task-progress.ts` — `computeWeeklyProgress`, shared with `StreakDots` — see [task-lists.md](task-lists.md#weekly-schedule--success-threshold).
- `components/ReportsView.tsx` — thin wrapper adding `Header`, threads `role` down.
- `components/ReportsContent.tsx` — the Overview|Logs segmented control + role dispatch.
- `components/reports/ManagerOverview.tsx` / `EmployeeOverview.tsx` — the two Overview variants.
- `components/reports/LogsTab.tsx` — both Logs variants.
- `components/reports/TaskListChart.tsx`, `TaskStatRow.tsx`, `shared.ts` — shared chart/row/helper code between the two Overview variants.

## Depends on

[`api/task-lists-api.md`](../api/task-lists-api.md) for the `TaskLog` states this all aggregates over, and the `scheduledDays`/`successThreshold` fields on `Task`. [`team-invites.md`](team-invites.md) for the bottom-nav layout this feature doesn't modify, and `GET /api/team` (used by the Logs tab's team-member filter).

## Reports v2 — leaderboard, exceptions, inventory (Stories 1–6)

Six of the seven "Reports v2" stories are built: team leaderboard + outcome
breakdown (Stories 1–2), worst-list/variance-outlier callouts (Stories
3–4), and inventory trend + below-par callout (Stories 5–6). **Story 7
(a monthly-rollup trend window beyond 30 days) is deliberately deferred**
— it needs a genuinely new aggregation path (monthly buckets, not a wider
daily array) and a minimum-account-age gate that isn't yet meaningful to
build against; it gets its own plan later. Multi-location rollup remains
out of scope entirely, per the original addendum — it's a data-model
change (`Company` has no parent-organization concept), not a reports story.

### Leaderboard (Stories 1–2)

`GET /api/reports/leaderboard?days=7|30&localDate=YYYY-MM-DD`, manager-only
(403 for an employee). Shares `lib/report-dates.ts`'s `getDates`/
`elapsedDates` with `GET /api/reports` (pulled out of that route into this
shared module specifically so the two windows can never drift apart) —
aggregates only over `elapsedDates`, never a not-yet-happened day.

**Resolved denominator** (the addendum's own flagged open question):
option (b) — a person's completion rate is `doneCount / (doneCount +
missedCount)` over tasks *they themselves* logged (the query itself
filters to `state: { $in: ["done", "missed"] }` — a pre-existing `rest`
log, now retired, was never counted here either, see CLAUDE.md's "Skip
Types"). Below **5 engaged tasks** in
the window, a person moves to an unranked "Not enough data" group instead
of showing a misleadingly perfect (or empty) percentage. Ties in the
ranked list break on raw `doneCount` descending.

The response also carries the Story 2 outcome breakdown per ranked user —
`onTimeCount`/`lateCount` alongside `doneCount`/`missedCount` — computed
per-log rather than a second endpoint, since it's the same log set just
re-bucketed. "Late" uses the identical actual-vs-projected threshold
`avgVariance` already applies in `GET /api/reports`, just per-log instead
of averaged; checkbox/stopwatch tasks (no real time target) never count as
late. `components/reports/Leaderboard.tsx` renders this above "Task List
Performance" in `ManagerOverview.tsx`, row tap expands the breakdown.

### Exception callouts (Stories 3–4)

`components/reports/ExceptionCallouts.tsx`, rendered at the top of
`ManagerOverview.tsx`. Pure client-side sorts over the `ReportsData`
`ManagerOverview.tsx` already has from `GET /api/reports` — no new route.
Worst task lists: `totalTasks > 0 && avgCompletionRate < 0.9`, ascending,
top 3; suppressed entirely when nothing clears that bar. Variance
outliers: `engagedDays >= 3` (a minimum-sample guard against one fluke
slow log headlining the callout) sorted by `|avgVariance|` descending, top
3, labeled by direction ("running long" vs. "suspiciously fast" — the
latter can mean rubber-stamping, not efficiency). Each entry is a
scroll-to-anchor shortcut, not a new destination: the Task List
Performance cards (`ManagerOverview.tsx`) and `TaskStatRow.tsx` rows both
now carry a stable `id` (`tasklist-<id>` / `task-<id>`) that
`document.getElementById(...).scrollIntoView(...)` targets.

### Inventory in Reports (Stories 5–6)

New "Inventory" segmented-control pill in `components/ReportsContent.tsx`,
manager-only (no employee-personal equivalent — inventory counts aren't
attributed to "your" work the way tasks are), rendering
`components/reports/InventoryTab.tsx`.

Story 6 (below-par callout) needed **no new query**: `GET
/api/inventory-item-types` already computes `belowPar`/`lastLoggedAt` per
active item for the existing Inventory tab (`app/api/inventory-item-types/
route.ts`) — `InventoryTab.tsx` just fetches that same endpoint and
filters `belowPar`, linking each entry to the existing `/inventory/
[itemTypeId]` detail page. This is the same comparison flagged as
deferred "push" alerting in [`inventory.md`](inventory.md)'s "Par-level
alerting" — this is its read-only, pull precursor, not the push version.

Story 5 (trend chart) is the one new route: `GET
/api/reports/inventory?days=7|30[&itemTypeId=]`, manager-only, querying
`InventoryLog` directly — kept separate from `GET /api/reports`, same
"different query shape, different consumer" reasoning `GET
/api/task-logs/history` already used to stay separate from `GET
/api/task-logs`. Since `InventoryLog.loggedAt` is a `Date`, not a stored
`YYYY-MM-DD` string like `TaskLog.date`, the window's date strings
(`lib/report-dates.ts`) get converted to local-midnight boundaries rather
than compared directly. `itemTypeId` omitted — `InventoryTab.tsx`'s only
caller, since every item's chart renders at once rather than one at a
time — returns **every active item's trend in one batched response**
(`{ items: [{ itemTypeId, name, unit, parLevel, logs }] }`): one query for
the catalog, one query for every matching log across all of them, grouped
in memory, not an N+1 round trip per item. Passing `itemTypeId` narrows to
that single item's shape instead, kept for any future single-item consumer.

`InventoryTab.tsx`'s browsing structure mirrors
`components/InventoryView.tsx` (the Inventory tab itself) rather than a
single-item picker — same search box, same manager-defined
`GET /api/inventory-groups` collapsible sections with an implicit
"Ungrouped" last, same `ItemRow` visuals (below-par red tint, current/par
fraction, "logged Xh ago" subtitle), fed by the identical `GET
/api/inventory-item-types` response. Every item's trend chart renders
directly under its row, all at once — no per-item tap-to-expand — with one
shared 7d/30d toggle for the whole tab rather than a control per item. The
row itself links to `/inventory/[itemTypeId]` (the log-a-count flow) since
there's nothing left to expand/collapse on it. The chart itself is a
custom-CSS bar chart — same no-library approach as
`components/reports/TaskListChart.tsx` — bar height normalized to that
item's own window max, a below-par bar tinted red.

### Files

- `lib/report-dates.ts` — `getDates`/`elapsedDates`, shared by `GET
  /api/reports`, the leaderboard route, and the inventory route.
- `app/api/reports/leaderboard/route.ts`, `components/reports/
  Leaderboard.tsx`.
- `components/reports/ExceptionCallouts.tsx` (no new route).
- `app/api/reports/inventory/route.ts`, `components/reports/
  InventoryTab.tsx`.
