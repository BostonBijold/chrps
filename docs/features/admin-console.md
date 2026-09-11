> **Keep this file updated after any code change in this area — do not let it drift from actual implementation.**

# Admin Console (Desktop) — Owner Multi-Location Management

**Status: BUILT.** Phases 1a, 1b, and 2 are all shipped — see the Phase
sections below for what actually exists vs. the original spec's phrasing.

## Purpose & scope

A dedicated, desktop-first section of the app for an **owner** to manage
their company across every location: team roster and access, invites, and
a cross-location rollup dashboard (the console's own homepage — see
"Entry point"/"Phase 2" below). Nothing about the mobile experience
changed — Tasks/Team/Reports/Inventory on the Capacitor app and in a
mobile browser stay exactly as documented in
[`team-invites.md`](team-invites.md), [`locations.md`](locations.md),
[`reports.md`](reports.md), and [`inventory.md`](inventory.md). This is
additive.

**Locations CRUD was removed from the console, then partially reintroduced**
— see "Removed: Locations CRUD" below for the full history. It briefly
existed as its own Phase 1a page (`/console/locations`), was removed once
that stand-alone page proved unneeded, and later came back in a smaller
shape as `components/console/LocationsPanel.tsx`, a create/rename/archive
panel embedded directly in Team & Access (`/console/team`) rather than a
page/nav item of its own — an owner needs somewhere to add a company's
first location or a new store before there's anyone to invite there, and
Team & Access's own pickers (the invite panel's location select, the
roster's per-row reassignment dropdown) had nothing to source options from
otherwise. `GET`/`POST`/`PATCH`/`DELETE /api/locations` were never touched
through any of this — both the removal and the reintroduction were UI-only.

**Why a separate section instead of responsive breakpoints on the
existing pages:** the mobile UI is built around bottom-sheet modals,
single-column card lists, a `<select>`-based location switcher, and
bottom-nav chrome (`app/(app)/layout.tsx`). Retrofitting that with desktop
breakpoints would mean branching two component trees inside the same
files. A separate route group gets a clean owner-only gate at the layout
level, a natural home for real tables and bulk actions, and — critically —
a natural home for the rollup dashboard, which had **no existing
precedent to retrofit at all** (see Phase 2 below). Team/Location
management screens in the new section call the *existing* mobile APIs —
no backend duplication for those (Phase 2's rollup route is the one
genuinely new backend surface).

## Architecture

### Route structure

`app/(console)/console/**` — a route group, parallel to `app/(app)/`, not
nested inside it. Pages:

- `app/(console)/console/layout.tsx` — manager-or-above gate + sidebar
  shell (loosened from owner-only — see
  [`console-task-management.md`](console-task-management.md)'s "Change:
  the console is no longer owner-only").
- `app/(console)/console/page.tsx` — role-aware: an owner renders the
  cross-location rollup dashboard directly (Phase 2's `RollupTable`,
  self-gated, no longer a separate `/console/rollup` route — see "Entry
  point" and Phase 2 below); a manager, who can't see it, redirects to
  `/console/tasks`.
- `app/(console)/console/team/page.tsx` — Roster, invites, access (Phase 1b).
  Owner-only, self-gated.
- `app/(console)/console/tasks/page.tsx` — Task & task-list management.
  Manager-or-above — see
  [`console-task-management.md`](console-task-management.md).

### Auth gate

`app/(console)/console/layout.tsx` (server component) calls the existing
`resolveSessionUser()` (`lib/session.ts`):

- No `companyId` → renders `components/NoCompanyMessage.tsx`, same as the
  mobile app (not an owner-specific case — reused as-is).
- `companyId` present but not manager-or-above → `redirect("/tasks")`. An
  employee never sees this section exist; no "upgrade your role"/teaser
  messaging, just a plain redirect, matching the app's existing pattern of
  not exposing UI a role can't use. (Originally owner-only; loosened when
  Task Management shipped, since that capability is manager-and-up on
  mobile already — see
  [`console-task-management.md`](console-task-management.md).)
- Manager or owner → renders `components/console/ConsoleShell.tsx`.

This is a layout-level check, not a `middleware.ts` matcher addition —
`middleware.ts`'s existing matcher already covers `/console` for the
plain "is there a session at all" check (it excludes only static assets,
`api/auth`, and `api/cron`), so no middleware change was needed; the
company/role-tier check happens one layer in, inside this server
component, same precedent as `NoCompanyMessage.tsx`. Since the blanket
gate above is now manager-or-above rather than owner-only, the two
remaining owner-only pages (`page.tsx` itself — the rollup dashboard —
and `team`) each additionally check `!isOwner(sessionUser.role)`
themselves and redirect a manager to `/console/tasks` — `team/page.tsx`'s
`resolveSessionUser()` call already existed (for `currentUserId`, the
roster's "(you)" label). Same non-concern the original spec flagged about
a second DB read per navigation, confirmed by building it: every other
page in the app already does its own `resolveSessionUser()` call
regardless of any layout-level check.

### Nav & shell

`components/console/ConsoleSidebar.tsx` — a fixed 240px sidebar (not
bottom nav), now role-aware via an `isOwner: boolean` prop threaded from
the layout through `ConsoleShell`: an owner sees **Dashboard** (the rollup
view, `/console` itself — first in the list, since it's the section's
homepage), **Team & Access**, **Task Management**, **Reports**, and
**Inventory**; a manager sees only **Task Management**, **Reports**, and
**Inventory** — see [`console-reports.md`](console-reports.md) and
[`console-inventory.md`](console-inventory.md). The Dashboard nav item
needs an exact-match `pathname === "/console"` check for its active state
rather than the `startsWith` every other item uses, since every console
route is itself prefixed with `/console`. The signed-in user's name and
a **Sign Out** button stay pinned at the bottom regardless of role
(`next-auth/react`'s `signOut()`, same call `ProfileView.tsx` uses).
`components/console/ConsoleShell.tsx` wraps the sidebar and a
`max-w-5xl` centered content area — desktop layout, no mobile safe-area
handling. Components live under `components/console/` — a sibling to
`components/`, not mixed into it, so nothing here risks touching a shared
mobile component by accident. No new UI dependency was needed — same
Tailwind setup as the rest of the app, same `lucide-react` icon set.

### Entry point

Logging in always lands on `/tasks`, same as before this feature — there
is no auto-redirect into the console based on role or device.
`components/ProfileView.tsx` gets a **manager-or-above** "Admin Console"
card (above the Manage Tasks/Manage Inventory/Company Settings cards;
originally owner-only, loosened alongside the layout gate — see
[`console-task-management.md`](console-task-management.md)), linking to
`/console` with role-aware subtitle copy. No native-platform check
needed on the card itself — tapping it from inside the Capacitor iOS
shell still navigates, and `ConsoleShell.tsx`'s own
`Capacitor.isNativePlatform()` check (see "Reachability from the iOS app"
below) is what actually blocks it there with the "open this on a
computer" message, so the logic isn't duplicated.

**`/console` itself is the owner's homepage**: `app/(console)/console/page.tsx`
renders `RollupTable` directly (an owner's first screen is the
cross-location snapshot, not a redirect elsewhere) rather than forwarding
to a separate page — see Phase 2 below. This replaced an earlier version
that redirected an owner to `/console/locations`, back when Locations CRUD
still existed (see "Removed: Locations CRUD" above) and Rollup lived at
its own `/console/rollup` route.

### Reachability from the iOS app

**Resolved** (was Open Question #1): `components/console/ConsoleShell.tsx`
checks `Capacitor.isNativePlatform()` client-side on mount and, if native,
renders an in-place "Open this on a computer" message instead of the
sidebar/table content — no redirect to `/tasks` (simpler than plumbing a
message through a query param, and avoids a jarring auto-navigation away
from a URL the owner explicitly opened).

## Removed: Locations CRUD (was Phase 1a), then reintroduced inside Team & Access

Originally shipped as the console's thinnest first slice — a
`components/console/LocationsTable.tsx` page at `/console/locations`
wrapping the existing `GET`/`POST /api/locations`, `PATCH`/`DELETE
/api/locations/[id]` routes. Removed once the console's actual usage
showed a location-CRUD *page* wasn't needed there: this owner's company
runs a small, effectively-fixed set of locations that don't get
created/renamed/closed often enough to justify a standing nav item, and
Team & Access's own per-row location `<select>` (Phase 1b, unchanged)
already covers the recurring need — reassigning a teammate to a location
that already exists.

**What was actually removed**: `app/(console)/console/locations/page.tsx`
and `components/console/LocationsTable.tsx` (deleted), and the sidebar's
Locations nav item. **What was unaffected**: the `Location` model, every
`/api/locations` route, and the mobile location switcher
(`components/LocationSwitcher.tsx`) — this was a console-page removal
only.

**Reintroduced, in a different shape**: removing the standing page left a
real gap — a brand-new company (or one opening its second store) had no
way to create a `Location` at all without a developer doing it by hand in
MongoDB, and Team & Access's invite panel/roster reassignment dropdowns
had nothing to list until one existed. `components/console/LocationsPanel.tsx`
fills that gap as a panel embedded directly at the top of `/console/team`
(Phase 1b, below) rather than a page or nav item of its own — it doesn't
resurrect `/console/locations`, `LocationsTable.tsx`, or the sidebar item,
only a scoped create/rename/archive UI over the same `/api/locations`
routes the removed page used to call. Create (name + optional address),
inline rename, and archive (`DELETE /api/locations/[id]`, soft-deletes via
`Location.isActive: false` — same convention as `TaskList.isActive`) with
a `window.confirm()` warning that an archived location drops off every
picker while teammates already assigned there keep their history. Owner-only,
same gate as the rest of Team & Access.

## Phase 1b — Team & Access (built)

Reuses existing mobile APIs: `GET`/`POST /api/invites`, `DELETE
/api/invites/[id]`, `GET /api/team`, `PATCH /api/team/[userId]`, `DELETE
/api/team/[userId]`, `GET /api/locations` (for pickers).

**Two net-new pieces of UI, plus one small additive API field**: a
location-reassignment control, and (added later) the `LocationsPanel`
described above. `PATCH /api/team/[userId]`'s owner-only `locationId`
field has existed since the Locations feature shipped, but — per
`team-invites.md`'s "Known gaps" — `TeamMemberActionSheet.tsx` (the
mobile action sheet) has no button that calls it. `components/console
/TeamTable.tsx`'s roster now has a per-row location `<select>` that calls
this endpoint directly. This needed one additive field on `GET /api/team`
that didn't exist before: the response now includes each member's
`locationId` (`app/api/team/route.ts`) so the dropdown can show a current
selection — the mobile `TeamView.tsx` ignores the new field, unaffected.

`TeamConsoleView.tsx` (the page-level coordinator described just below)
now also fetches locations through its own `fetchLocations()` (split out
so `LocationsPanel`'s create/rename/archive handlers can re-trigger it
independently of the initial mount effect) and passes the list to
`LocationsPanel` alongside `TeamTable`/`InvitePanel`. Archiving a location
also re-fetches the roster: a deactivated location isn't retroactively
cleared off any teammate/invite already pointing at it, so the roster's
own dropdown gets a fresh read rather than risking a stale selection
lingering in state.

Roster table (`TeamTable.tsx`): Name, Role, Location (editable dropdown,
owner-only per above), Joined date, Actions (make manager/employee,
remove — same guards as mobile: can't touch a fellow owner's role, can't
demote/remove the last manager with zero owners as backstop).
**Unfiltered by location** — the console's `GET /api/team` call never
sends `activeLocationId`, so this table always shows the whole company,
unlike the mobile Team tab's owner-switcher-scoped view.

Invite panel (`components/console/InvitePanel.tsx`): role select,
location select (required, same validation `POST /api/invites` already
enforces for an owner), one-time vs. reusable checkbox, Generate → shows
the link with a **Copy** button (no Web Share API call — that was a
mobile-only fallback path; desktop just copies to clipboard). Pending
invites table in the same component: Role, Uses remaining, Expiry,
Created by, Revoke button (`DELETE /api/invites/[id]`).

`components/console/TeamConsoleView.tsx` is the page-level coordinator
(client component) holding the shared `team`/`invites`/`locations` state
both `TeamTable` and `InvitePanel` need and wiring their callbacks to the
API routes above — not one of the spec's originally-named components, but
needed to avoid duplicating that fetch/refresh logic across two files.

## Job Tags catalog (built, add-on to Phase 1b)

The candidate add-on flagged in the original spec's Open Question #3,
built after Phase 2 shipped. Gives the company-wide `User.jobTags` field
(schema-only since the Locations feature — see
[`locations.md`](locations.md)'s "Job tags") an actual catalog and
assignment UI, homed in the console rather than wedged into a mobile
bottom sheet, per that question's reasoning.

**New model** — `models/JobTag.ts`: `{ companyId, name, createdByUserId,
isActive }`, same shape/conventions as `InventoryGroup`. Manager-or-above
gated (`isManagerOrAbove`), not owner-only — job tags are a company
configuration concern like the task/inventory catalogs, not a
location-visibility one, even though the only UI consuming it today is
the owner-only console.

**New routes**: `GET`/`POST /api/job-tags` (list active tags; create,
manager+) and `PATCH`/`DELETE /api/job-tags/[id]` (rename; archive,
manager+). Because `User.jobTags` stores plain tag-name strings rather
than a `JobTag._id` ref (matching the pre-existing schema — no join
needed to display a member's tags), a rename or archive must cascade into
every `User.jobTags` array that references the old name or the catalog
and assignments silently drift apart. `lib/job-tags.ts`'s
`renameJobTag`/`archiveJobTag` do this in the same request (positional
`$` update for rename, `$pull` for archive) — mirrors
`lib/inventory.ts`'s `archiveInventoryGroup` cascade pattern, though a job
tag has no "Ungrouped" fallback the way an archived `InventoryGroup`'s
members get one; it's just removed from whoever had it.

**Assignment**: `PATCH /api/team/[userId]` gained a third optional field,
`jobTags: string[]` (alongside the pre-existing `role`/`locationId`),
validated against the company's active `JobTag` catalog and gated the
same as the role-change field (manager-or-above, not owner-only — unlike
`locationId` reassignment, tagging has no location-visibility concern).
`GET /api/team` now also returns each member's `jobTags` (additive,
ignored by mobile's `TeamView.tsx`, same convention as the earlier
`locationId` addition).

**UI**: `components/console/TeamTable.tsx`'s roster gained a Job Tags
column — one toggle pill per catalog tag, filled when assigned — calling
`onUpdateJobTags` per click. `components/console/JobTagsPanel.tsx` (new,
rendered below `InvitePanel` on `/console/team`) is the catalog manager
itself: an inline "+ Add Tag" input plus a pill list with inline
rename/archive icons, mirroring `InvitePanel.tsx`'s desktop-inline style
rather than a mobile bottom sheet.

**Scope note**: this ships only the catalog + assignment half. Actually
*using* a tag to control which task lists a tagged employee sees
(`TaskList`/`Task.visibleToJobTags`) is not part of this pass — flagged
in `locations.md` as "a distinct future pass" and left that way here too.

**Consumed by**: [`notification-job-tag-targeting.md`](notification-job-tag-targeting.md)
(narrows a list's start-time reminder audience) and
[`shift-lead-preassignment.md`](shift-lead-preassignment.md) (groups the
shift-lead picker's roster by tag) both read this catalog — neither
touches task-list visibility either.

## Phase 2 — Cross-location rollup dashboard (built)

The genuinely new part — the piece with no existing precedent.
`reports.md` and `locations.md` both flagged multi-location rollup as
explicitly out of scope; this is where it was built. **Now the console's
own homepage** (`/console` itself, not a separate `/console/rollup`
route — see "Entry point" above) rather than a standalone sidebar page;
`components/console/RollupTable.tsx` is unchanged, just mounted one level
higher.

### `GET /api/reports/rollup?days=7|30&localDate=YYYY-MM-DD`

`app/api/reports/rollup/route.ts` — owner-only (`403` otherwise — a
manager/employee only ever has one location, so this view has no meaning
for them). Response shape:

```ts
{
  dates: string[];
  days: number;
  today: string;
  locations: Array<{
    locationId, locationName,
    avgCompletionRate: number,   // doneCount / (doneCount + missedCount) — see lib/reports.ts
    totalTasksLogged: number,    // doneCount + missedCount + restCount
    missedTaskListCount: number, // MissedListAlert rows in the window
    belowParItemCount: number,   // InventoryItemType par comparison, this location's logs
    activeEmployeeCount: number,
  }>;
  companyTotals: {
    avgCompletionRate: number,   // summed doneCount/engagedCount across every location, NOT an
                                 // average of each location's own percentage — a low-volume
                                 // location would otherwise skew the total as much as a
                                 // high-volume one
    totalTasksLogged: number,
    missedTaskListCount: number,
    belowParItemCount: number,
  };
}
```

**Implementation**: `lib/reports.ts` (new) holds two small,
`locationId`-parameterized helpers shared with the rest of the reports
surface so the numbers can never quietly drift apart:

- `getLocationTaskCounts(companyId, locationId, dates)` — fetches this
  company's active `Task`s and every matching `TaskLog` in the window,
  returns raw `{ doneCount, engagedCount, totalTasksLogged }` counts
  (never a pre-divided rate — the rollup route sums numerators/
  denominators across locations before dividing for `companyTotals`,
  rather than averaging percentages).
- `getBelowParCountForLocation(companyId, locationId)` — same "latest
  logged count ≤ parLevel" comparison `GET /api/inventory-item-types`
  already makes per-row, parameterized by location via the existing
  `getLatestInventoryLogs` helper in `lib/inventory.ts`.

This is deliberately narrower than the full `GET /api/reports` payload —
no per-task daily breakdown, no weekly-progress/streak math — since the
rollup table only ever needs one number per location. `GET /api/reports`
itself was **not** refactored to call these helpers; it keeps its own
existing, more detailed aggregation untouched to avoid regressing a
working route with many other consumers (charts, weekly progress,
per-task variance). The drift risk this raised in the original spec is
scoped to `avgCompletionRate`/`totalTasksLogged` specifically, and both
routes computing "done state" the same way (`TaskLog.state === "done"`
etc.) makes silent divergence unlikely even without a forced shared code
path for the single-location view.

- `missedTaskListCount`: `MissedListAlert.countDocuments({ companyId,
  locationId, date: { $in: window } })` — already location-scoped, no
  model change.
- `activeEmployeeCount`: `User.countDocuments({ companyId, locationId,
  role: { $ne: null } })`.

### UI: `components/console/RollupTable.tsx`

- **Top strip**: four `StatTile`s — company-wide avg completion, tasks
  logged, missed lists, below-par items (the "at a glance across every
  store" view — see Phase 2's opening note).
- **Table**: one row per location; `missedTaskListCount`/
  `belowParItemCount` render in burgundy when `> 0`, matching the
  existing red-tint convention (`InventoryTab.tsx`, `ExceptionCallouts.tsx`).
- **Row click** → `PATCH /api/session/active-location` (same endpoint the
  mobile switcher calls) then `router.push("/console/reports")` — the
  console's own single-location Reports page (see
  [`console-reports.md`](console-reports.md)), not mobile's `/reports`.
  (Originally pushed to `/reports` before that console page existed —
  updated once it shipped, since that mobile page visibly shrinks the
  whole browser window down to phone-width chrome.)
- 7-day / 30-day toggle, matching the existing Reports convention.

### Deferred (unchanged from the original spec)

No trend-over-time rollup chart, no CSV export, no per-location target/
goal overrides — all still out of scope, same reasoning as the original
draft.

## Resolved open questions

1. **`/console` inside the Capacitor iOS shell** — resolved: blocked via
   `ConsoleShell.tsx`'s client-side `Capacitor.isNativePlatform()` check,
   rendering an in-place message rather than redirecting to `/tasks`. See
   "Reachability from the iOS app" above.
2. **Single-location owner visibility** — resolved as recommended: the
   console is visible regardless of location count. Nothing in the layout
   gate checks location count at all.
3. **Job tags catalog UI** — built. `components/console/JobTagsPanel.tsx`
   (below the roster/invite panel on `/console/team`) manages a company-
   level `JobTag` catalog (create/rename/archive, manager-or-above gated
   same as `InventoryGroup`), and `TeamTable.tsx` gained a Job Tags column
   of toggleable pills per teammate, wired through `PATCH
   /api/team/[userId]`'s new `jobTags` field. This is the tag-catalog half
   of `locations.md`'s "Job tags" only — the `TaskList`/
   `Task.visibleToJobTags` targeting half (actually gating which tasks a
   tagged employee sees) remains unbuilt, a distinct future pass. See the
   new "Job Tags" section below.
4. **`missedTaskListCount`/`belowParItemCount` as the two "at a glance"
   signals** — kept as the first-shipped pair. An avg-variance outlier
   column (borrowing `ExceptionCallouts.tsx`'s logic) remains a plausible
   future third column, not built.
5. **Auth gate mechanics** — confirmed as built: a layout-level
   `redirect()`, not a `middleware.ts` matcher.

## Depends on

[`features/locations.md`](locations.md) — `Location` model, `owner` role,
`listActiveLocations`, `validateLocationId`, the existing location-switcher
`PATCH /api/session/active-location` endpoint this reuses for the
rollup's row-click deep link. [`features/team-invites.md`](team-invites.md)
— `Invite` model, `GET`/`PATCH`/`DELETE /api/team*` this reuses directly.
[`features/reports.md`](reports.md) — `lib/report-dates.ts`'s
`getDates`/`elapsedDates`, and the single-location aggregation this phase
draws its own narrower helpers from rather than duplicating the counting
logic; also the explicit prior "multi-location rollup out of scope" notes
this doc supersedes. [`features/inventory.md`](inventory.md) — the
below-par comparison logic `getBelowParCountForLocation` is built from.
