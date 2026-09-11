> **Keep this file updated after any code change in this area — do not let it drift from actual implementation.**

# Shift Lead Pre-Assignment

**Status: BUILT.** Extends the existing `TaskListSession` model (see
[timer.md](timer.md)'s "A persisted session record") with a pre-start
assignment state.

A manager can name the shift lead for a given task list *before anyone has
started it* — a day-of assignment, not a schedule. This is deliberately
scoped small: no recurring/future-dated assignment, no admin-portal
configuration. That's planned separately for the admin console later; this
covers only "assign today's lead for this list, right now."

## Why a separate field, even though it now shares the pill's slot

`TaskListCard.tsx`'s "✓ Done" status row (see [timer.md](timer.md#✓-done-status-row--session-start-end-time--owner))
reports **what happened** — `performedByUserId` off a `TaskListSession`,
only meaningful once a session has actually run. Pre-assignment is a
different kind of fact: **intent set ahead of time**, which needs to
survive through to session start without being silently overwritten by
whoever physically taps the first task. The two stay separate *fields*
(`assignedUserId` vs. `performedByUserId` — see "Data model" below) so
"who's supposed to run this" is never conflated with "who did," even
though — see "UI" below — they now render in the **same on-screen slot**
rather than two differently-positioned elements. That positional split was
the original design and turned out inconsistent in practice: a
not-yet-started list showed its assignment on its own row below the title,
while a finished list's name showed a different way, inline in the pill
next to the title — the two states read as unrelated UI. Unifying the
*slot* (not the underlying fields) fixed that.

## UI

**Header row, right side** — the same slot in every session state, not
just pre-start. `TaskListCard.tsx` shows only for today's shift-window
lists (anytime lists have no "Start Tasks" session concept to pre-assign
into; a past date has nothing left to pre-assign):

- **Pre-start, unassigned, manager viewing**: faint placeholder
  `Shift lead: +`, tappable.
- **Pre-start, unassigned, employee viewing**: nothing rendered — no
  placeholder, no empty slot.
- **A name is resolved** (either a pre-assignment, or — once a session has
  actually run — its owner as a fallback when nobody pre-assigned it):
  `Shift lead: Jordan`, plain text, not a pill/badge, visible to every
  role. Tappable for a manager only while still pre-start (`canPreAssign`
  — no session yet, or one still in `status: "assigned"`); once a session
  reaches `in_progress`/`completed` it's inert plain text for everyone,
  matching the write path's own pre-start-only rule (see "Known
  limitations" on restarts).

Tapping is **manager-only**, gated server-side the same way
`DELETE /api/task-logs` (Undo) is — `403` for an employee,
`canManage(userRole)` (`TaskListCard.tsx`'s existing helper, wrapping
`isManagerOrAbove`) threaded down the same way the file already threads
manager-only affordances elsewhere.

**Status row, full-width, directly below the title** — the list's own
"starts/by/done-range" state (previously a right-aligned badge that shared
the title row with the pill/shift-lead slot, plus a separate `doneCount`
stat next to it): `starts HH:MM` before the window, `by HH:MM`/"window
passed" once it's past without being done, the `0/N · Xm` progress stat on
the right for any not-yet-complete list, or — once complete — the
session's own `start–end` time range in the done-green tint, spanning the
full card width either way rather than an auto-sized badge. No longer
carries a name at all (that moved up into the header-row slot above).

**Picker** (`components/ShiftLeadPicker.tsx`): a small sheet anchored
under (and right-aligned to) the header-row trigger (`absolute right-0
top-full`, fixed width, not stretched to the card's full width and not a
bottom-of-screen slide-up like `AddTaskSheet`'s default presentation) —
same sheet primitive (rounded card, backdrop-to-dismiss), different
anchor. Fetches the company's roster (`GET /api/team`) and Job Tag catalog
(`GET /api/job-tags`) on open, and lists the roster (any role, not just
manager-or-above), grouped by Job Tag when the company has tags configured,
flat/alphabetical when it doesn't. Untagged members get their own "Other"
section at the bottom when some (but not all) roster members carry a tag —
resolving the original open question below. Tapping a name assigns
immediately and closes nothing itself (the caller closes the sheet via
`onChanged`) — no separate confirm step, matching `AddTaskSheet`'s
existing-task picker. A "Clear assignment" action at the bottom of the
sheet handles unassign without requiring the manager to guess which name
un-checks it; the currently-assigned name (if any) shows a checkmark.

## Data model

`models/TaskListSession.ts` additions:

```ts
TaskListSession {
  // existing fields unchanged: companyId, locationId, taskListId, date,
  // completedAt, totalActualMinutes, completionSequence, pauseOrJumpCount, timestamps

  status: "assigned" | "in_progress" | "completed",   // "assigned" is new
  startedAt: Date | null,        // now nullable — null while status === "assigned"
  performedByUserId: string | null,   // unchanged meaning: whoever actually ran/is running the session

  assignedUserId: string | null,     // new — the pre-assigned shift lead
  assignedByUserId: string | null,   // new — the manager who made the assignment
  assignedAt: Date | null,           // new
}
```

`assignedUserId`/`assignedByUserId` are plain `String`, not `ObjectId`
refs — same convention as `performedByUserId` and every other user-id
field on this model (`companyId`/`locationId` too): they carry whatever id
a session resolves to, and `SKIP_AUTH`'s local dev user id isn't a valid
`ObjectId` at all.

`assignedUserId`/`assignedByUserId`/`assignedAt` are never cleared by the
upgrade-to-`in_progress` transition below — they stay on the record as a
permanent "who was assigned, and by whom" alongside the run itself, even
after `performedByUserId`/`startedAt` take on their normal meaning.

## Write path

**Assign** (`POST /api/task-list-sessions/assign`):
`{ taskListId, date, assignedUserId }`, manager-only, `403` for employee.
`lib/task-list-session-actions.ts`'s `assignShiftLead` finds-or-creates the
day's session doc for that `taskListId`:

- No session exists yet for that list/date → create one: `status:
  "assigned"`, `assignedUserId`, `assignedByUserId` (acting manager),
  `assignedAt: now`, `startedAt: null`, `performedByUserId: null`.
- A session already in `status: "assigned"` exists → overwrite
  `assignedUserId`/`assignedByUserId`/`assignedAt` on it (reassignment).
- A session already in `status: "in_progress"`/`"completed"` exists for
  that list/date → reject (`409`) — the UI shouldn't be able to reach this
  state since the header-row slot goes non-tappable once a session is
  running, but the API enforces it independently rather than trusting the
  client.

**Clear** (`DELETE /api/task-list-sessions/assign?taskListId=…&date=…`):
manager-only. `clearShiftLead` deletes the `"assigned"` record outright
(rather than leaving an empty shell) — simplest option, and nothing
downstream depends on an empty `assigned` doc existing.

**The pin** — `lib/task-list-session-actions.ts`'s `ensureOpenSession`
(called by `startInProgressLog`/`switchActiveLog` when a list's first task
actually starts) changes its lookup order:

1. Look for an existing `status: "assigned"` session for
   `{ taskListId, date }` first.
   - **Found** → upgrade it in place: `status: "in_progress"`,
     `startedAt: now`, `performedByUserId: assignedUserId` (**not** the id
     of whoever's actual tap triggered this call). Leave
     `assignedUserId`/`assignedByUserId`/`assignedAt` untouched.
   - **Not found** → fall back to the existing behavior exactly as before:
     reuse any already-open `in_progress` session, or create a fresh one
     with `performedByUserId` = the acting user, `startedAt: now`,
     `status: "in_progress"`.

This is the entire mechanism behind "a different person starting the list
doesn't take over the assignment" — the acting user's identity never
touches `performedByUserId` when a pre-assignment exists; it only decides
*that a run happened*, not *who it's attributed to*.

## Read path

`GET /api/task-list-sessions?date=YYYY-MM-DD`
(`lib/task-list-session-actions.ts`'s `getSessionSummariesForDate`)
extends its per-`taskListId` summary to also surface an `assigned`-status
record when no `in_progress`/`completed` one exists yet for that date —
resolving `assignedUserId` to `assignedUserName` the same batched-`User`-
lookup way `ownerName` is resolved. No extra filtering logic was needed for
this: Mongo's `startedAt: -1` sort already puts a null-`startedAt`
("assigned") record last among a taskList's session docs, so it only ever
wins the "most recent per list" pick when there's no real run to beat it —
exactly the "surface it only while nothing's actually running yet" rule
this row needs. See [`docs/api/task-lists-api.md`](../api/task-lists-api.md#task-list-sessions)
for the exact response shape.

`TasksView.tsx` needs no new polling — it already refetches sessions on
mount, date change, and logs-poll-detected changes (`refetchSessions`).
The assign/clear/reassign actions are direct manager-initiated writes in
the same client session, so `TaskListCard`'s new `onSessionsChanged` prop
(wired to `refetchSessions` in `TasksView.tsx`) lets the picker trigger an
immediate re-fetch after a successful write rather than waiting on the
poll cycle.

## Open questions resolved during implementation

- **Untagged employees in the grouped picker**: untagged roster members
  get their own "Other" section, appended after every tag group — matches
  the catch-all-goes-last convention elsewhere in the app rather than
  interleaving them with tag groups.
- **Reassignment notification**: still out of scope for this pass, as the
  original spec draft left it — [notifications.md](notifications.md)'s
  job-tag-targeted push infrastructure could carry this later if wanted,
  but nothing here pings the newly-assigned (or bumped) person today.

## Known limitations

- **Restarts within the same day.** A list can legitimately be
  started/finished/restarted more than once the same day (`TaskListSession`
  has no unique index on `{ companyId, taskListId, date }`, per
  [task-lists-api.md](../api/task-lists-api.md#task-list-sessions)). Once
  an `assigned` record is upgraded to `in_progress` and later `completed`,
  nothing represents "still assigned" if the list gets started a third
  time from scratch that same day — a fresh session is created with no
  assignment context, same as if nobody had ever pre-assigned it. This
  matches the "first run only, scoped to today" behavior the original spec
  leaned toward, built as the actual (and only) behavior rather than
  revisited further — lightweight was the point.
- **Schedule drift.** Nothing re-verifies an `assigned` record still makes
  sense if the list itself changes underneath it (renamed, rescheduled off
  today, deleted) before anyone starts it — same class of gap
  [notifications.md](notifications.md) already flags for QStash schedules.

## Files

- `components/TaskListCard.tsx` — the new header row (assigned/unassigned/
  placeholder states), manager-gated tap, `onSessionsChanged` prop.
- `components/ShiftLeadPicker.tsx` — anchored sheet, roster grouped by Job
  Tag, assign/clear actions.
- `app/api/task-list-sessions/assign/route.ts` — `POST` assign/reassign,
  `DELETE` clear, manager-only.
- `lib/task-list-session-actions.ts` — `ensureOpenSession`'s new
  assigned-record lookup/upgrade step; `assignShiftLead`/`clearShiftLead`;
  `getSessionSummariesForDate`'s extension to surface `assigned`-status
  records.
- `app/api/task-list-sessions/route.ts` — `GET` response extended with
  `assignedUserId`/`assignedUserName`.
- `app/(app)/tasks/page.tsx` — initial server-rendered `initialSessions`
  extended the same way, off the same batched `User` lookup as `ownerName`.
- `models/TaskListSession.ts` — `status` enum addition, nullable
  `startedAt`, new `assignedUserId`/`assignedByUserId`/`assignedAt`
  fields.

## Depends on

[timer.md](timer.md)'s "A persisted session record" and "'✓ Done' status
row" sections — this extends that same model rather than introducing a
parallel one. [task-lists-api.md](../api/task-lists-api.md#task-list-sessions)
for the full `TaskListSession` shape. [admin-console.md](admin-console.md#job-tags-catalog-built-add-on-to-phase-1b)
for the picker's grouping source (`JobTag` catalog).
