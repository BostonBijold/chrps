> **Keep this file updated after any code change in this area — do not let it drift from actual implementation.**

# Locations (multi-location companies)

**Status: BUILT** — schema, permissions, invite/team location assignment,
Location CRUD, TaskLog/InventoryLog/TaskListSession/MissedListAlert
location-scoping, and (as of the location-switcher feature) a real
**switcher UI** for an owner — a control on each of the 4 bottom-nav pages
(Tasks, Team, Reports, Inventory) to change which location's data they're
looking at (and, on Tasks, acting against) — are all implemented. See
"Location switcher" below.

Every `Company` was implicitly a single restaurant before this feature.
`Location` is a new one-to-many child of `Company`, so one company (one
legal business, one Ch'rps account) can run multiple physical stores — e.g.
"Via 313 — Salt Lake City" and "Via 313 — Sugar House" both under one
company. **Scope is deliberately narrow**: this is *one company with many
locations*, not "one owner with many companies." An owner who wants to run
two legally-separate businesses on Ch'rps still needs two separate
`Company` accounts — that broader "one login, many companies" model was
discussed and explicitly deferred, see [Open questions](#open-questions--deferred).

This also introduces a third `User.role` tier (`owner`, alongside the
existing `employee`/`manager`) and a second, independent axis on `User` —
**job tags** (server/cook/busser/host/…) — for assigning different task
lists to different job functions without overloading the permission role.
The `jobTags` field's catalog and assignment UI (built as an Admin Console
add-on) exist; the task-list-targeting half that would actually use a tag
does not (see [Job tags](#job-tags)).

## Data model

### `models/Location.ts`

```ts
Location {
  companyId,                    // ref Company (plain String, not ObjectId — same convention as
                                 //   every other tenant-scoped collection)
  name: string,                 // e.g. "Salt Lake City" — required
  address: string | null,
  timezone: string | null,      // IANA name, e.g. "America/Denver" — not yet read anywhere (see
                                 //   Open questions re: per-location business hours)
  isActive: boolean (default true),  // soft-delete/close a location without losing its historical logs
  createdAt,
}
```

Index: `{ companyId: 1, isActive: 1 }`.

### `models/User.ts`

- **`role`**: widened to `"employee" | "manager" | "owner" | null`. `owner`
  is a strict superset of `manager` — every former `role !== "manager"` gate
  now reads `!isManagerOrAbove(role)` (`lib/session.ts`/`lib/roles.ts`).
  `owner` is never assigned through any in-app flow (invite redemption,
  `PATCH /api/team/[userId]`) — only by hand in MongoDB, same as a
  company's very first manager.
- **`locationId`** (ref `Location`, nullable): this user's primary location.
  Set at invite redemption from the invite's own `locationId`, or by an
  owner via `PATCH /api/team/[userId]`. For `employee`/`manager` this is
  also their *only* visible/actionable location. An owner's visible-
  locations set is **computed**, not stored — every active `Location` under
  their `companyId` (`lib/locations.ts`'s `listActiveLocations`) — their own
  `locationId` is just their default context.
- **`jobTags: string[]`** (default `[]`) — assignable from the Admin
  Console's Team page (see [Job tags](#job-tags)); not yet read by any
  task-list-visibility logic.

### `models/Invite.ts`

- **`locationId`** (plain String, nullable — same convention as
  `companyId`): stamped from the creating manager's own `User.locationId`
  at `POST /api/invites` time. An **owner** creating an invite must pass
  `locationId` explicitly in the request body (validated against the
  company); `InviteSheet.tsx` shows a location picker only when the creator
  is an owner. On redemption (`app/invite/[token]/page.tsx`), the invite's
  `locationId` is written onto the redeeming `User.locationId`.

### `models/TaskLog.ts`, `models/TaskListSession.ts`, `models/InventoryLog.ts`, `models/MissedListAlert.ts`

Each gained a plain-String `locationId` field (nullable, for pre-migration
rows) and their compound uniqueness/lookup indexes now include it:

- `TaskLog`: `{ companyId, locationId, taskId, date }` unique — was
  `{ companyId, taskId, date }`. Two locations running the same
  shared-catalog task on the same day now get independent logs instead of
  colliding.
- `TaskListSession`: `{ companyId, locationId, taskListId, date, status }`
  lookup index — a session opened at one store no longer reads as
  "already open" at another.
- `InventoryLog`: `{ companyId, locationId, itemTypeId, loggedAt }` — the
  catalog (`InventoryItemType`) stays company-wide/shared (see
  [Open questions](#open-questions--deferred)), but a "current count" is
  now tracked independently per location.
- `MissedListAlert` (not in the original spec — added during
  implementation): `{ companyId, locationId, taskListId, date }` unique —
  same collision reasoning as `TaskLog`, needed once the missed-list cron
  sweep started iterating per-location (see
  [Notifications](#notifications-fan-out) below).

`Todo` is unchanged — still scoped by `companyId` + `userId` only, no
`locationId` (see the original reasoning: a user belongs to exactly one
location, so it'd be redundant).

## Role tiers & permissions

| Role | Sees | Administers |
|---|---|---|
| `employee` | Their own `locationId` only | Nothing |
| `manager` | Their own `locationId` only | Their own location's catalog, team, invites, reports |
| `owner` | Every active `Location` under their `companyId` | Everything a manager can, at any of their company's locations |

`lib/roles.ts` (client-safe, no server-only imports) defines
`isManagerOrAbove(role)`/`isOwner(role)`; `lib/session.ts` re-exports both
for server call sites. Every API route and page that used to check
`role === "manager"` / `role !== "manager"` now uses `isManagerOrAbove`.
Two actions are gated tighter, **owner-only**:

- `POST /api/locations` (creating a store) and `PATCH`/`DELETE
  /api/locations/[id]` (rename/close it).
- `PATCH /api/team/[userId]`'s `locationId` field (reassigning a teammate
  between locations) — `role` changes on that same route stay manager-or-
  above, but only an owner may act on a fellow **owner** row at all (change
  their role or remove them), and the "last manager" lockout guard now also
  checks for at least one owner before blocking a demotion/removal (a
  company with an owner is never locked out even at zero managers).

## Location assignment

- **Invite-time stamping** (default): a manager's own `locationId` is baked
  into every invite they create. An owner picks a location explicitly in
  `InviteSheet.tsx`.
- **Manual reassignment**: owner-only, via `PATCH /api/team/[userId]` (body:
  `{ locationId }`), validated against the company's active locations.
  `TeamMemberActionSheet.tsx` itself only ever toggles manager/employee —
  location reassignment isn't wired into that sheet's UI yet (the API
  supports it; no button calls it — see [Known gaps](#known-gaps)).
- No self-serve "switch my own location" — always a manager/owner action on
  someone else's account.

## Location CRUD

`app/api/locations/route.ts` — `GET` (any signed-in company user; the
company's active locations, `{ _id, name, address, timezone }[]`) and
`POST` (owner-only create). `app/api/locations/[id]/route.ts` — `PATCH`
(owner-only rename/re-address/re-zone) and `DELETE` (owner-only soft-delete,
`isActive: false`). UI: `components/console/LocationsPanel.tsx`, an
owner-only create/rename/archive panel embedded in the Admin Console's
Team & Access page (`/console/team`) — no `timezone` field in that UI yet,
only `PATCH` supports setting it. See
[`admin-console.md`](admin-console.md)'s "Removed: Locations CRUD... then
reintroduced" for why this lives there rather than its own page.

## TaskLog/TaskListSession/Inventory write-path propagation

`locationId` is threaded as a parameter alongside `companyId` through every
function in `lib/task-log-actions.ts`, `lib/task-list-session-actions.ts`,
and the relevant functions in `lib/inventory.ts`
(`getLatestInventoryLogs`/`writeInventoryLogsForTaskCompletion`), and
through `lib/task-trigger.ts`'s `triggerTask` (the NFC Universal Link entry
point) and `lib/task-definitions.ts`'s `resolveMostRelevantPlacement`.
Every route that calls into these resolves `locationId` from the caller's
own session (`sessionUser.locationId`) for employee/manager, or via
`pickActiveLocationId(sessionUser, validatedRequestedLocationId)` for an
owner who passed `?locationId=`/body `locationId` (`lib/session.ts`,
`lib/locations.ts`'s `validateLocationId`).

A few queries are **deliberately not** location-scoped, on purpose:

- `completeStrayInProgressLogs`/`startTask`'s "any other in_progress log for
  this person" lookups, `GET /api/task-logs/active`, and `triggerTask`'s own
  active-log lookup — the single-active-timer invariant is about the
  *person*, not which location a log happens to carry.
- `lib/streak.ts`'s `computeCurrentStreakForUser` — same reasoning, scoped
  by `performedByUserId` already.

### Notifications fan-out

`app/api/cron/check-missed-lists/route.ts` now iterates every active
`Location` under each company (falling back to a single `null`-location
pass for a company with none yet), running the missed-check independently
per location — its own `TaskList.find`/`Task.find` queries are now
`locationId`-filtered too (moved inside the per-location loop), since
`TaskList`/`Task` are location-owned rather than shared, so the same list
name can genuinely differ, or simply not exist, from one store to the
next. `lib/notifications.ts`'s `sendMissedListAlert`/`sendStartTimeReminder`
both grew a `locationId` param: managers/employees are filtered to that
location, owners always included regardless (they administer every
location). `POST /api/cron/task-list-reminder` is now naturally
location-split too, as a side effect rather than a deliberate change: each
location's own shift-window `TaskList` is a separate document with its own
`qstashScheduleId`, so a fire for one store's "Opening Shift" was always
going to be independent of another store's — no code change was needed
here once the underlying `TaskList` model itself became location-owned
(see [Known gaps](#known-gaps)).

## Location switcher

A `<select>` control backed by the same data/session/API layer described
below, in two different UI homes depending on surface:

- **Mobile — the 4 bottom-nav pages** (Tasks, Team, Reports, Inventory):
  merged directly into `components/Header.tsx`'s title area as of
  [`header-location-switcher.md`](header-location-switcher.md) — there is
  no longer a separate switcher row under the header. See that doc for the
  header's exact behavior (interactive `<select>` vs. static location-name
  text vs. the plain "Ch'rps" wordmark, depending on role/location count).
- **Desktop Admin Console** (`/console/tasks`, `/console/reports`,
  `/console/inventory`): still `components/LocationSwitcher.tsx`, rendered
  directly by `TaskManagementView.tsx`/`ConsoleReportsView.tsx`/
  `ConsoleInventoryManagementView.tsx` exactly as before — untouched by the
  mobile header merge.

Both surfaces render nothing unless `isOwner` and the company has 2+ active
locations — a manager/employee, or an owner at a single-location company,
sees no interactive picker on either surface.

- **Persisted server-side, not in a URL param or `localStorage`** (see
  CLAUDE.md's "Notes for Claude Code" — all state lives in MongoDB):
  `User.activeLocationId: ObjectId | null` (new field, same storage shape
  as the existing `User.locationId`). Set only via `PATCH
  /api/session/active-location` (owner-only, validated with
  `lib/locations.ts`'s `validateLocationId` — same silent-fallback-to-null
  convention as every other call site of that helper).
- **`null` resolves differently per page**, matching each page's
  *pre-switcher* default exactly, so shipping this changed no default
  behavior for anyone who's never touched the switcher:
  - **Tasks/Reports/Inventory** — `lib/session.ts`'s `pickActiveLocationId`
    gained one more fallback tier for owners:
    `requestedLocationId || sessionUser.activeLocationId ||
    sessionUser.locationId`. `null` still means "my own location."
  - **Team** (`GET /api/team`) — reads `sessionUser.activeLocationId`
    directly, **not** `pickActiveLocationId`: `null` means "no filter, show
    the whole company" (today's original, unfiltered behavior — this is
    the first time Team has ever been location-scoped at all), a specific
    id filters to `{ companyId, locationId }`. Team's switcher instance
    passes `allowAll`, adding an "All Locations" entry that simply
    `PATCH`es `activeLocationId` back to `null` — not a separate sentinel
    value. **Gated on `isOwner(role)`, not just `activeLocationId` being
    truthy** (`app/api/team/route.ts`): the field is meant to be
    owner-only, set exclusively by the owner-gated `PATCH
    /api/session/active-location`, but nothing clears it if a hand-edit in
    MongoDB later demotes that user away from `owner` — without the role
    check, a stale `activeLocationId` left over from before the demotion
    would silently filter a manager's or employee's own roster view down
    to one location instead of showing the whole company.
- **Tasks writes need no separate wiring.** `/api/task-logs`'s
  start/complete/miss handlers already resolved their location via
  `pickActiveLocationId` before this feature existed (originally only
  reachable via a raw `?locationId=`/body param nothing in the UI ever
  sent) — so once the session-level fallback was added, switching location
  on the Tasks page makes starting/completing/missing a task act against
  that location automatically, no `TasksView.tsx` mutation call needed
  updating.
- **Reports/Inventory refresh via remount, not `router.refresh()` alone.**
  Their data comes from a client-side `fetch()` in a `useEffect` that only
  runs once on mount, so a plain server-component refresh doesn't
  re-trigger it. Both `LocationSwitcher` (Console) and `Header`'s
  `location` prop (mobile) take an optional changed-callback, fired after a
  successful `PATCH` alongside `router.refresh()`: `InventoryView`/
  `TeamView` pass their own existing `fetchAll`/`fetchTeam` functions;
  `ReportsView` has no single equivalent (4 separate sub-tab components
  each own their fetch), so it instead bumps a counter used in
  `<ReportsContent key={...}>` to force the whole subtree to remount and
  refetch.
- **Out of scope**: no cross-location aggregate/"all stores" rollup for
  Tasks/Reports/Inventory (the backend has no such concept — Team's "All
  Locations" is a plain unfiltered list, not an aggregate); no
  re-validation if a location is deactivated while still selected as
  someone's `activeLocationId` (same risk profile as the pre-existing
  `User.locationId` field); the native offline SQLite cache doesn't know
  about this at all — it only affects which location an *online* request
  resolves to.

## Migration / backfill

`scripts/backfill-locations.mjs` — one-off, manually run
(`node --env-file=.env.local scripts/backfill-locations.mjs`), idempotent.
In order:

1. Creates one default `Location` ("Main Location") per existing `Company`.
2. Sets every existing `User.locationId` to that company's default.
3. Backfills `locationId` onto every existing `TaskLog`/`InventoryLog`/
   `TaskListSession`/`MissedListAlert` row from the same default.

**Must run before deploying app code that depends on `TaskLog`'s new
unique `{companyId, locationId, taskId, date}` index** — an existing
company's own `POST /api/invites` will also start failing (no valid
`locationId` to stamp) until this has run, since invite creation now
requires the creating manager to have a `locationId`.

## Job tags

`User.jobTags: string[]` (default `[]`) now has a real catalog and
assignment UI, built as an add-on to the Admin Console rather than
`TeamMemberActionSheet.tsx` — see
[`admin-console.md`](admin-console.md)'s "Job Tags catalog" section for
the full implementation (`models/JobTag.ts`, `GET`/`POST /api/job-tags`,
`PATCH`/`DELETE /api/job-tags/[id]`, the `jobTags` field on `PATCH
/api/team/[userId]`, `components/console/JobTagsPanel.tsx` and
`TeamTable.tsx`'s per-row toggle pills). **Still unbuilt**: a
`TaskList`/`Task.visibleToJobTags` field that would actually use a tag to
gate which task lists a tagged employee sees — a tag today is pure
metadata, read nowhere outside the console's own display. Also still
unbuilt: any mobile assignment UI (`TeamMemberActionSheet.tsx` has no tag
picker) — tagging is console-only for now, same as the rest of the Admin
Console's owner-only surface.

## Known gaps

Deliberately left unbuilt or unresolved in this pass — flag before treating
this feature as fully "done":

- **Offline SQLite cache (`lib/offline-db.ts`) has no `locationId` column.**
  Harmless today (every company has exactly one location post-migration),
  but the native cache schema needs its own migration before offline sync
  is correct for a company running more than one location — see
  `docs/features/offline.md`.
- **`TeamMemberActionSheet.tsx` has no location-reassignment control** —
  `PATCH /api/team/[userId]`'s `locationId` field is implemented and
  owner-gated, but no UI button calls it yet.
- ~~Start-time reminders (`task-list-reminder` cron) are not split per
  location~~ — **closed as a side effect of the location-scoped task
  catalog fix below**: since `TaskList` itself became location-owned (each
  store's "Opening Shift" is now its own document with its own
  `qstashScheduleId`), a shift-window list's start-time reminder is
  correctly per-location by construction, with no notifications-code
  change needed. See [Notifications fan-out](#notifications-fan-out) above.
- Everything already listed as deferred in the original design pass, still
  true: restricting an owner to a subset of locations; the broader
  "one person, many companies" model; a combined multi-location rollup
  view in Reports; and per-location business hours/timezone actually being
  read anywhere.
- **The NFC/`TaskDefinition` "shared catalog vs. per-location catalog"
  question — RESOLVED, `TaskList`/`Task`/`TaskDefinition`/`NfcTag`/
  `PendingNfcLink` are now location-owned**, not company-wide. A physical
  NFC tag (either `TaskDefinition.nfcTagUid`'s in-app scan-to-complete
  binding, or the separate tap-to-trigger `NfcTag` collection) now binds to
  exactly one location's `TaskDefinition`/task, never leaking across
  stores; `instructionSteps`/`requiresPhoto` are the same. Browsing another
  location's (or the company's) saved tasks is still possible, but only as
  read-only example data (`GET /api/task-definitions?scope=company`) that
  gets CLONED into a new, same-location definition on add — never a live
  cross-location reference. See CLAUDE.md's "Task Lists" section,
  `docs/features/task-lists.md`'s "Company Task Catalog" section, and the
  migration script `scripts/backfill-task-catalog-locations.mjs`.
  **`InventoryItemType`/`InventoryGroup` did NOT get this same treatment** —
  they remain company-wide shared catalog with only per-location
  `InventoryLog` rows, so an Inventory item's own NFC binding (distinct
  from a task's) can still, in principle, be scanned meaningfully from any
  location. If Inventory ever needs the same per-location catalog
  ownership, that's a separate, still-unbuilt redesign, following the same
  shape as the task-catalog fix above.

## Depends on

[`api/task-lists-api.md`](../api/task-lists-api.md), [`features/nfc.md`](nfc.md),
[`features/inventory.md`](inventory.md), [`features/team-invites.md`](team-invites.md),
and [`features/notifications.md`](notifications.md) — this feature adds a
filtering dimension on top of all of these rather than replacing any of
their existing auth/session-resolution patterns.
