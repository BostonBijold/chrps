> **Keep this file updated after any code change in this area — do not let it drift from actual implementation.**

# Notification targeting by job tag

**Status: BUILT.**

Narrows the two existing push alert types
([`notifications.md`](notifications.md)) so a task list's **start-time
reminder** can be aimed at a subset of the company via the existing
`JobTag` catalog, instead of always reaching every company user at a
location. Also adds a company-level toggle for whether missed-list alerts
include the owner.

This is the notification-only half of the tag work. It deliberately does
**not** touch task-list *visibility* (which employees can see/act on a
list at all) — that remains the separate, still-deferred piece flagged in
[`locations.md`](locations.md#job-tags) ("a distinct future pass"). This
spec only changes who gets pushed to.

## Why this shape

`User.jobTags` and the company-level `JobTag` catalog already existed and
were already assignable from the Console's Team & Access page
(`JobTagsPanel.tsx`, `TeamTable.tsx`'s toggle pills) — see
[`admin-console.md`](admin-console.md#job-tags-catalog-built-add-on-to-phase-1b). Nothing before this read a
tag for anything beyond display. This is the first consumer: a task list
gets an optional list of tags, and reminder audience is computed by
intersecting a user's `jobTags` against the list's.

## Data model changes

- **`TaskList.notifyTags: string[]`** (`models/TaskList.ts`, default `[]`)
  — job-tag values from the company `JobTag` catalog, matched by name (same
  string-not-ref convention as `User.jobTags`, so a rename/archive in the
  catalog must cascade here too — see "JobTag rename/archive cascade"
  below). **Empty = notify everyone**, i.e. pre-existing behavior,
  unchanged. Non-empty = only company users whose `jobTags` intersects this
  array (any overlap) are in the audience. Multiple tags per list are
  supported (e.g. a list relevant to both Cooks and Prep). Inert for an
  anytime list (`startTime: null`), which has no start-time reminder to
  target at all — same "harmless no-op" pattern `qstashScheduleId` already
  follows for those lists.
- **`Company.missedAlertIncludeOwner: boolean`** (`models/Company.ts`,
  default `true`, to preserve pre-existing behavior on every existing
  company without a migration) — when `false`, the missed-list sweep
  excludes the owner from the push, managers only.

## Audience logic changes (`lib/notifications.ts`)

### `sendStartTimeReminder(taskList, locationId, notifyTags?)`

- **`notifyTags` empty/omitted** → unchanged from before: every company
  user at that location, employee/manager/owner alike, owner always
  included regardless of location (existing "owner administers every
  location" rule, see [`locations.md`](locations.md#notifications-fan-out)).
- **`notifyTags` non-empty** → audience narrows to users at that location
  (`User.jobTags: { $in: notifyTags }`, plus a `locationId` filter when one
  is set) whose `jobTags` intersects `notifyTags`. **The owner is not
  auto-included on this path** — an owner only receives a tag-scoped
  reminder if they themselves carry a matching tag, same rule as everyone
  else. Decided explicitly, since it's a change from the untagged path's
  "owner always included" behavior.
- An employee/manager/owner with **zero** `jobTags` never matches a
  tag-scoped list, by construction — they simply won't be in that list's
  audience ("line cooks only see their own ping").

Fixed as part of this change: `app/api/cron/task-list-reminder/route.ts`
previously hardcoded `locationId: null` on every call regardless of the
firing list's own `locationId` — a leftover from before task lists became
location-owned (see [`locations.md`](locations.md)'s "Locations" section).
Since each shift-window list is now its own location-owned document with
its own independent QStash schedule, this route now reads and passes the
firing list's actual `locationId` (and its `notifyTags`) through to
`sendStartTimeReminder`. Without this fix, a tag-scoped list's reminder
would incorrectly span every location company-wide instead of narrowing to
the one location that list belongs to.

### `sendMissedListAlert(taskList, locationId, includeOwner?)`

- **Unaffected by tags** — stays role-based (managers, plus owner unless
  the toggle says otherwise). Missed alerts are an escalation to whoever
  administers the location/company, not a per-team routing concern.
- Reads `Company.missedAlertIncludeOwner` (defaulted `?? true` at every
  read site, so an unset field on a pre-existing company keeps today's
  behavior). `true`/unset → owner included. `false` → owner excluded,
  managers only.

## UI changes

### Console → Task Management (task list edit view)

`components/console/TaskListsPane.tsx`'s `NotifyTagsPicker` — lives
alongside where a shift-window list's `startTime`/`scheduledDays` are
already configured (both the create form and each list's inline edit
form), not Team & Access, even though the tag *catalog* itself lives
there. A multi-select chip picker sourced from `GET /api/job-tags` (the
company's active `JobTag` catalog). No tags selected shows "Notifies:
everyone (default)"; one or more selected shows the tag chips, each
labeled with its current `userCount` (how many active teammates hold it)
so a manager can see at a glance whether a tag is actually populated. If
every currently-selected tag has zero holders, a warning line renders
below the picker: "No teammate currently holds a selected tag — this list
would notify nobody." The collapsed list row in `TaskListsPane.tsx` also
appends `· notifies <tags>` to its summary line when `notifyTags` is
non-empty. Anytime lists can still carry `notifyTags` in the data model
(the picker isn't hidden for them) even though the field is inert there —
matches the model comment's own "harmless no-op" framing.

`GET /api/job-tags` now returns `userCount` per tag (an aggregation over
active `User` documents in the company) alongside `_id`/`name`, purely to
power this picker's hint — additive field, every other consumer
(`JobTagsPanel.tsx`, `TeamConsoleView.tsx`) ignores it.

### Missed-alert owner toggle

`components/CompanySettingsView.tsx` — a second switch inside the existing
"Missed Alert Timing" card, directly below the grace-minutes input, right
under the same manager-only settings surface where
`missedAlertGraceMinutes` already lives. Disabled (opacity-dimmed, same as
the minutes input) whenever missed alerts are off entirely
(`missedAlertGraceMinutes === null`). `PATCH /api/company/settings` gained
a matching `missedAlertIncludeOwner` field.

## JobTag rename/archive cascade

`lib/job-tags.ts`'s `renameJobTag`/`archiveJobTag` — previously only
cascaded into `User.jobTags` — now also cascade into every
`TaskList.notifyTags` array that references the tag: a rename rewrites the
old name to the new one in place (positional `$` operator, same pattern as
the `User.jobTags` cascade), and an archive strips the tag out via `$pull`.
Without this, a renamed tag would silently detach a list from its intended
audience (the list would keep the stale name, forever matching nobody),
and an archived tag could leave a list pointed at a name no `User.jobTags`
entry can ever hold again. This was an open question in the original spec
draft — resolved by extending the existing cascade rather than adding new
cleanup logic.

## Open questions resolved during implementation

- **JobTag archive cascade**: confirmed `archiveJobTag` already stripped
  the tag from `User.jobTags`; extended it (and `renameJobTag`) to also
  cover `TaskList.notifyTags` — see above.
- **Owner toggle placement**: built in mobile `CompanySettingsView.tsx` as
  originally proposed, alongside the grace-period setting — same
  audience (manager-or-above), same settings surface.
- **Tag picker component**: built new (`NotifyTagsPicker`, inline in
  `TaskListsPane.tsx`) — no existing multi-select chip picker fit; kept
  small and local rather than generalized, since nothing else needs a
  reusable version yet.
- **A list with tags where none of today's employees hold a matching
  tag**: surfaced at edit time via each chip's `userCount` plus an
  explicit warning line when every selected tag currently has zero
  holders (see "Console → Task Management" above) — not blocked, just
  visible.

## Depends on

[`notifications.md`](notifications.md) — the two alert mechanisms this
narrows; `Company.notificationsEnabled`/`missedAlertGraceMinutes` are
unchanged and still apply on top of this. [`locations.md`](locations.md#job-tags)
— `JobTag` catalog, `User.jobTags`, owner role semantics, and the
existing location-scoped fan-out (`locationId` param on
`sendStartTimeReminder`/`sendMissedListAlert`) this builds on rather than
replaces. [`admin-console.md`](admin-console.md#job-tags-catalog-built-add-on-to-phase-1b) — Task
Management page (where the new tag picker lives) and Team & Access (where
the tag catalog and per-user assignment already live, untouched by this
spec).
