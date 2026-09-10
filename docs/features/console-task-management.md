> **Keep this file updated after any code change in this area — do not let it drift from actual implementation.**

# Console — Task & Task List Management

**Status: BUILT.** A page inside the existing
[`admin-console.md`](admin-console.md) section, plus the auth-gate change
that page required (see below) — see "Current state" below for what
actually exists vs. the original spec's phrasing.

## User story

As a manager or owner, create, rename, schedule, and edit task lists and
tasks from a desktop browser — using the exact same rules and data as the
mobile app — so that whoever's more comfortable at a keyboard can do this
work there. Nothing about the phone changed: a manager mid-checklist who
realizes "Bathrooms" needs to become "Men's"/"Women's" still edits it right
there on the spot, no forced trip to a computer. NFC tag binding is the one
deliberate exception, since it requires physically tapping a tag with a
phone — the console shows binding *status*, never a scan action.

## Change: the console is no longer owner-only

Every console page used to be owner-only at
`app/(console)/console/layout.tsx`. Task/task-list management, unlike
Locations/Team & Access/Rollup Dashboard, is a **manager-and-up**
capability on mobile already (`ManageTasksView.tsx`, `TaskListEditView.tsx`
are both manager-gated, not owner-gated), so the console version couldn't
tighten that.

- **`app/(console)/console/layout.tsx`**: the redirect condition is now
  `!isManagerOrAbove(sessionUser.role)` (was `!isOwner(...)`) — an employee
  still bounces to `/tasks`; a manager now renders the shell same as an
  owner does.
- **`locations/page.tsx`, `team/page.tsx`, `rollup/page.tsx`**: each now
  does its own `if (!sessionUser || !isOwner(sessionUser.role))
  redirect("/console/tasks")` check, since the blanket layout gate no
  longer covers this for them.
- **`components/console/ConsoleSidebar.tsx`**: takes an `isOwner: boolean`
  prop (threaded from the layout through `ConsoleShell`). An owner sees all
  four items (Locations, Team & Access, Task Management, Rollup Dashboard —
  in that order, Task Management inserted between Team & Access and
  Rollup); a manager sees only **Task Management**.
- **`app/(console)/console/page.tsx`**: its redirect is now role-aware —
  owner → `/console/locations` (unchanged), manager → `/console/tasks`.
  (**Superseded**: Locations was later removed from the console entirely
  and Rollup Dashboard moved to be `/console`'s own homepage rather than a
  fourth sidebar item — see [`admin-console.md`](admin-console.md)'s
  "Removed: Locations CRUD" and "Nav & shell" for the sidebar's current
  shape. The rest of this section's history is otherwise accurate as of
  when Task Management shipped.)
- **`components/ProfileView.tsx`**: the "Admin Console" card now shows for
  `isManager` (was `isOwner`) — `isManager` is already
  `isManagerOrAbove(role)` from `app/(app)/profile/page.tsx`, so this one
  change covers both tiers. Its subtitle is role-aware: an owner keeps
  (an updated version of) the original copy, a manager gets "Manage task
  lists and tasks — best on a computer" instead, since they'll only ever
  reach the one page behind it.

## Page: `/console/tasks`

Owner or manager (not employee). A segmented control at the top of
`TaskManagementView.tsx` switches between two independent views — **Task
Lists** (the original two-pane layout, below) and **Task Catalog** (see its
own section further down) — sharing the same fetched
`taskLists`/`definitions` state and the same `refetchTasksAndDefinitions`
refresh after any mutation.

**Location switcher**: since `TaskList`/`Task`/`TaskDefinition` became
location-owned (see CLAUDE.md's "Locations" section), this page now
resolves `sessionUser` server-side in `app/(console)/console/tasks/page.tsx`
(previously it had no server-side session resolution at all) and renders
`<LocationSwitcher isOwner activeLocationId onChanged={refetchTasksAndDefinitions} />`
above the segmented control, same component/wiring as `/console/reports`.
Because this page fetches client-side on mount rather than via server
props, it uses the `onChanged` callback to refetch directly, not the
key-remount trick `ConsoleReportsView` uses. A manager or a single-location
owner sees no UI change — the switcher renders nothing below 2 active
locations, matching every other page that uses it.

Reuses every existing route below as-is, plus two small additive routes on
`/api/task-definitions` the Task Catalog pane needed (see that section):

- `GET /api/task-lists`
- `POST /api/task-lists`
- `PATCH /api/task-lists/[taskListId]`
- `DELETE /api/task-lists/[taskListId]`
- `GET /api/task-definitions` (`scope=own`, the default this page uses — its
  new `scope=company` cross-location browse mode is consumed by
  `AddTaskSheet.tsx`, not this page's own panes directly)
- `POST /api/task-definitions` (new — catalog-only creation, no placement)
- `PATCH /api/task-definitions/[id]` (new — edit a definition directly by
  its own id)
- `DELETE /api/task-definitions/[id]` (pre-existing, now also called from
  this page's Task Catalog pane)
- `POST /api/tasks` (both paths — place an existing definition, or build a
  new one)
- `PATCH /api/tasks/[id]`
- `DELETE /api/tasks/[id]`
- `PATCH /api/tasks/reorder`

**One additive field, not a new route**: `GET /api/task-lists`'s response
gained `scheduledDays` on each list itself (it previously returned this
only per-task, never on the list) — the console's list editor needs the
list's own current value to show accurate toggle state when a manager
reopens it to edit, the same way `PATCH /api/task-lists/[taskListId]`
already returns it. Ignored by the offline SQLite cache, which only reads
fields its own schema mirrors.

**Not reused, by design**: `POST`/`DELETE /api/tasks/[id]/nfc-tag` and
`POST`/`DELETE /api/task-definitions/[id]/nfc-tag`. These keep working
exactly as before from the phone — they're just not callable from this
page, since there's no scanner to call them with.

### Layout — two panes

`components/console/TaskManagementView.tsx` is the page-level
coordinator (client component, same "fetch client-side, refetch after
every mutation" convention as `TeamConsoleView.tsx`/`RollupTable.tsx`).
It fetches `GET /api/task-lists` (raw placements) and `GET
/api/task-definitions` (the resolved catalog) and joins them itself
(`resolveTasksForList`) — mirroring `lib/task-definitions.ts`'s
`resolveTasks` server-side join (same "Deleted task"/`help-circle`
fallback for a stray reference) — rather than adding a new resolved
backend route. Refetches both collections after every task-affecting
mutation rather than optimistically patching local state the way mobile's
`TaskListEditView.tsx` does: a task's name/icon/formFields edit writes
through to the shared `TaskDefinition` and so can change what *other* list
placements show too, which is easy to get right with a refetch and easy
to get subtly wrong with a hand-rolled local patch.

- **Left pane** — `components/console/TaskListsPane.tsx`: every task list
  (shift-window and anytime), in the same order `GET /api/task-lists`
  already returns (`startTime` then `order`). Selecting one loads its
  tasks into the right pane. "+ New Task List" expands an inline create
  row (name, optional start time, scheduled days, notify-tags picker) —
  the same fields `POST /api/task-lists` already accepts; blank start time
  = a never-collapsing anytime list. Each row gets an inline pencil
  (rename/reschedule/re-tag, calling `PATCH /api/task-lists/[taskListId]`)
  and trash (soft-delete, with the same confirm-dialog copy as
  `TaskListEditView.tsx`'s mobile delete) icon — replacing the need for a
  separate navigation the way mobile's dedicated page requires, a
  desktop-layout difference only. The create/edit forms' `NotifyTagsPicker`
  (job-tag multi-select, narrowing this list's start-time reminder
  audience) is a later addition — see
  docs/features/notification-job-tag-targeting.md.

- **Right pane** — `components/console/TaskListDetailPane.tsx`: the
  selected list's tasks, in order, each editable inline: name, icon
  (`AppIcon`/`IconPicker`, reused as-is), form fields (`TaskFieldsEditor`,
  reused as-is — same building block mobile's field editor uses, so the
  two can't drift on what a field shape supports), `projectedMinutes`
  (this placement's override), `scheduledDays`, `successThreshold`. A drag
  handle per row (`@dnd-kit`, same library mobile uses) calls `PATCH
  /api/tasks/reorder`, with an optimistic local reorder before the request
  resolves so a drag release feels instant. **Task type is not editable
  here** — nothing in the mobile UI lets a manager change a task's type
  after creation either. "+ Add Task" reuses `components/AddTaskSheet.tsx`
  directly, unmodified — its three-path flow (browse the template catalog,
  browse "Your Saved Tasks," browse "From Other Locations" to clone one, or
  build a custom one — the third path added alongside the location-scoped
  task catalog fix, see CLAUDE.md's "Locations" section) needed no
  console-side reimplementation since it's already just Tailwind markup
  with no mobile viewport assumptions baked in, and it fetches its own data
  via `useEffect` the same way it does on mobile. `TaskManagementView.tsx`
  wires a `handleAddClone` alongside its existing `handleAddExisting`,
  calling the same `POST /api/tasks` with `cloneFromDefinitionId` instead
  of `definitionId`.

- **NFC status, not NFC action**: a task with a bound tag (`nfcTagUid`,
  already inlined via the join) shows a plain "Linked" badge inline in the
  row, and "Bound · `<uid>`" in the expanded edit panel; one with none
  shows "Not linked — link NFC on mobile device," no button. This is the
  one deliberate capability gap versus mobile, called out in the UI itself
  rather than left as a silent missing feature — it holds even after the
  edit-parity backfill below, since a browser still has no scanner. The
  tap-to-trigger `nfcTagCode` system this note used to also mention has
  since been removed entirely (see `docs/features/nfc.md`'s "History:
  Tap-to-trigger (removed)") — nothing left to show or not show.
- **Instructions, Require Photo, Linked Inventory** — originally not shown
  here either (out of this pane's first-pass scope), these three were
  later backfilled by
  [`unified-task-create-edit.md`](unified-task-create-edit.md), rendering
  the exact same shared panels/hooks mobile's edit surface uses
  (`unified-task-edit-surface.md`), scoped to this row's `definitionId`.
  That same doc also added them (plus NFC as status-only, matching this
  page's own rule) to "+ Add Task"'s create flow.

### Task Catalog pane

`components/console/TaskCatalogPane.tsx` — a full-width, flat list of every
`TaskDefinition` in the company's catalog, independent of which (if any)
task lists currently place it. This is the fix for the gap the original
build of this page left open (see "Deferred" below, now resolved): a
manager could see/edit tasks only through a specific list's placement, so a
definition with zero active placements had no edit path anywhere in the
app at all — not even mobile's own `ManageTasksView.tsx` "Company Task
Catalog" section can edit a catalog row's name/icon/fields/minutes, only
bind NFC, delete, or (when it has at least one placement) jump to that
list's edit screen.

Each row shows name, icon, `projectedMinutes`, NFC-linked badge, and a
usage line — "Used in Opening, Closing" or "Not placed in any list" (the
same `placements` array `GET /api/task-definitions` already returns, just
rendered flat instead of per-list). Expanding a row edits name/icon/
`formFields`/`projectedMinutes` inline (same `AppIcon`/`IconPicker`/
`TaskFieldsEditor` building blocks as `TaskListDetailPane.tsx`'s row),
saving via the new `PATCH /api/task-definitions/[id]` — which, unlike
`PATCH /api/tasks/[id]`, keys off the definition's own id rather than a
placement's, so it works whether or not the definition is placed anywhere.
Delete is disabled (with a tooltip) whenever `placements.length > 0`,
mirroring `DELETE /api/task-definitions/[id]`'s own 409 rule — no
double-checking client-side beyond that, the delete button just calls
through and surfaces the 409's message if a manager finds a stale row.
"+ New catalog task" creates a definition via the new
`POST /api/task-definitions`, with no placement at all — the one way to
get a catalog-only entry a manager can place into a list later, on their
own schedule, distinct from every other creation path (`AddTaskSheet`'s
"Create custom task", `POST /api/tasks` with no `definitionId`) which
always creates a placement in the same request.

Both new routes are manager-or-above gated, same convention as this file's
pre-existing `DELETE`. NFC binding stays status-only here too, same
reasoning as the Task Lists pane above. "+ New catalog task" later gained
the same Instructions/Require Photo/Linked Inventory phase-2 panels as
"+ Add Task" — see
[`unified-task-create-edit.md`](unified-task-create-edit.md).

### What's explicitly unaffected

`ManageTasksView.tsx`, `TaskListEditView.tsx`, `ManageTaskDetailSheet.tsx`
— untouched by this doc's own build. `AddTaskSheet.tsx` **is** shared
as-is across both platforms (no console-specific fork), but it was later
modified in place by
[`unified-task-create-edit.md`](unified-task-create-edit.md) to add the
two-phase create flow — that change applies identically wherever the sheet
is used, mobile included. Same APIs, same NFC binding flow, same
on-the-fly mid-checklist editing. This page is a parallel entry point into
the same data, not a replacement for any of it.

## Deferred (not built this pass)

1. **`ProfileView.tsx` card copy** — shipped with role-aware subtitle text
   (see above) rather than one shared label, resolving what the original
   spec flagged as an open question.
2. **Manager's `/console` landing experience** — shipped as the spec's own
   lean: a bare two-pane task editor, no summary/dashboard content above
   it.
3. **Bringing the catalog-only edit/create routes to mobile** — `PATCH`/
   `POST /api/task-definitions` (added for the console's Task Catalog pane,
   see above) would also close mobile's own matching gap in
   `ManageTasksView.tsx`/`ManageTaskDetailSheet.tsx` (today it can bind
   NFC, delete, or jump to a placement's list, but can't edit an unplaced
   definition's name/icon/fields/minutes directly). Left as a mobile-side
   follow-up — not touched this pass.

## Depends on

[`admin-console.md`](admin-console.md) — the layout/auth gate this
modifies, and the `components/console/` folder convention this adds to.
[`api/task-lists-api.md`](../api/task-lists-api.md) — every reused route.
[`features/task-lists.md`](../features/task-lists.md) — the mobile
UI/behavior this must not diverge from. [`features/nfc.md`](../features/nfc.md)
— why tag binding stays phone-only.
