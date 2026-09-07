> **Keep this file updated after any code change in this area — do not let it drift from actual implementation.**

# Inventory

A top-up count tracker, not a decrement ledger. Its own bottom-nav tab (5th
slot, after Reports) — see CLAUDE.md's "Bottom nav" section.

## Why not decrement-on-task-completion

Considered and rejected. "Clean bathroom" doesn't reliably mean "minus 4
rolls of toilet paper" — the relationship between a task and inventory
consumption isn't consistent or automatable in a way that stays
trustworthy. A count that's wrong because it drifted out of sync with
reality is worse than no count at all. Top-up (someone looks, someone types
the number they see) keeps the data honest at the cost of needing a human
to actually check. Nothing in this codebase writes an `InventoryLog` as a
side effect of a `TaskLog` write — the two collections are completely
independent, and there is no field on `Task`/`TaskDefinition`/`TaskLog`
that references Inventory at all.

## Data model

- **`models/InventoryItemType.ts`** — `{ companyId, name, unit | null,
  parLevel | null, nfcTagUid | null, createdByUserId, isActive, groupId |
  null, nfcRequiredToLog: boolean }`. The manager-defined catalog entry
  ("Toilet Paper," "Cases of Meat"). `unit` is a free-text display label
  ("rolls," "cases," "lbs") shown next to a count — display only, never used
  in a calculation. `isActive` is the soft-delete/archive flag, same
  convention as `TaskDefinition.isActive` — the spec that introduced this
  model floated a timestamp-based `archivedAt` field instead, but `isActive:
  bool` was chosen to stay consistent with every other soft-delete in this
  codebase (`TaskList.isActive`, `Task.isActive`, `TaskDefinition.isActive`),
  not to introduce a second archival convention for one model. `groupId` and
  `nfcRequiredToLog` were added in a later pass — see "Grouping" and "NFC
  enforcement" below; every pre-existing row got `groupId: null` and
  `nfcRequiredToLog: false` on migration, so nothing became stricter for
  existing data on deploy.
- **`models/InventoryGroup.ts`** — `{ companyId, name, createdByUserId,
  isActive }`. A manager-defined organizational label ("Freezer," "Cold
  Storage," "Dry Storage," "Bar") — see "Grouping" below. Purely
  organizational: no NFC tag or par level of its own. Archiving a group
  (`DELETE /api/inventory-groups/[id]`) does **not** archive its items —
  every member `InventoryItemType.groupId` is set back to `null`
  ("Ungrouped") as part of the same request (`lib/inventory.ts`'s
  `archiveInventoryGroup`); items and their `InventoryLog` history are
  untouched either way.
- **`models/InventoryLog.ts`** — `{ companyId, itemTypeId, count,
  loggedByUserId, loggedAt, verifiedNfcUid | null }`. One row per count
  entry — append-only, never edited in place, same "never mutate a past
  row" convention as `TaskLog`: a correction (including a manager fixing
  someone else's fat-fingered entry — there is no special manager-only edit
  path, since append-only already makes "log the right number" the
  correction) is just a new row with the right number. The "current count"
  shown anywhere in the UI is simply the most recent `InventoryLog` row for
  a given `itemTypeId` (highest `loggedAt`) — nothing computes or derives it
  any other way. `lib/inventory.ts`'s `getLatestInventoryLogs` is the one
  place that "most recent per item type" batch join lives (the Inventory
  tab's list view); a single item's detail screen just asks for that item's
  logs sorted newest-first and takes `logs[0]`. `parLevel` comparisons for
  the below-par cascade (see "Par-level alerting" below) are computed at
  read time against this same latest-log join — nothing new is stored.
- **`models/TaskInventoryLink.ts`** — `{ companyId, taskDefinitionId,
  itemTypeId, required: boolean }`. See "Task ↔ Inventory Linking" below.

No changes to `TaskDefinition`/`Task`/`TaskLog` themselves. Task ↔
Inventory linking is a separate join collection, not a field added to
either side — Inventory stays fully usable with zero tasks referencing it,
and a task's own completion semantics (`TaskLog`) are unaffected by whether
it happens to have linked items.

## Roles

- **Employees**: view current counts for every active item type. Can log a
  new count for any item type — whether or not it has a bound tag, manual
  entry is always available (`POST /api/inventory-logs`, open to any
  signed-in company user, not manager-gated).
- **Managers**: everything employees can do, plus create item types (`POST
  /api/inventory-item-types`), edit name/unit/parLevel/groupId/
  nfcRequiredToLog (`PATCH /api/inventory-item-types/[id]`), archive one
  (`DELETE /api/inventory-item-types/[id]` — soft delete, no "still
  referenced" block the way `TaskDefinition` has, since an item type has no
  placement concept to check and its `InventoryLog` history stays
  valid/readable once archived), and bind/unbind an NFC tag (`POST`/`DELETE
  /api/inventory-item-types/[id]/nfc-tag`). Managers also create/rename/
  archive `InventoryGroup`s (`POST /api/inventory-groups`, `PATCH`/`DELETE
  /api/inventory-groups/[id]`) and manage which item types are linked to a
  given task — see "Task ↔ Inventory Linking" below.

## Location scoping

`InventoryItemType`/`InventoryGroup` stay a shared, company-wide catalog
(one set of item types for every location, same reasoning as the shared
`Task`/`TaskDefinition` catalog), but `InventoryLog` — the actual logged
counts — is per-location. `GET /api/inventory-item-types` and `GET`/`POST
/api/inventory-logs` resolve `locationId` via `pickActiveLocationId`
(`lib/session.ts`): always an employee/manager's own location, or an
owner's location-switcher selection (defaulting to their own location if
unset — see [`locations.md`](locations.md)'s "Location switcher"). Two
locations logging the same catalog item independently never collide into
one location's count. `InventoryView` renders
`components/LocationSwitcher.tsx` under its `<Header>` so an owner can
actually change which location's counts they're viewing; switching calls
the view's existing `fetchAll()` to refetch, since its data comes from a
client-side fetch that only runs once on mount.

## NFC binding — uses Part 1's multi-target model directly

An `InventoryItemType.nfcTagUid` binds to a **storage location**, not
exclusively to that one item type's count — the same physical tag can (and
often will) also be bound to a `TaskDefinition` at the same location (e.g.
the walk-in freezer's tag backing both "Log Freezer Temperature" and "Meat
Inventory Count"). That cross-type sharing is the entire reason the
multi-target NFC model exists — see `docs/features/nfc.md`'s "Multi-target
binding" for the full mechanism (resolution, disambiguation, the
`alsoBoundTo` binding-UI warning). This doc only covers what's
Inventory-specific:

- **Binding never gates logging a count — unless `nfcRequiredToLog` is
  true.** By default (`nfcRequiredToLog: false`, every item type's starting
  state) this holds exactly as before: unlike a bound `TaskDefinition`
  (which always requires a matching Scan NFC to complete — see
  `docs/features/nfc.md`'s `assertNfcVerified`), `POST /api/inventory-logs`
  accepts an optional `verifiedNfcUid` and stores it on the new
  `InventoryLog` row **only when it actually matches** the item type's own
  bound `nfcTagUid` — a stray or mismatched value is silently dropped
  (never stored as verified), and the log still saves either way. A manager
  can opt a specific item into strict enforcement instead — see "NFC
  enforcement" below — at which point this default no longer applies to
  that one item.
- **From inside the item's own log-count screen** ("Save via NFC" on
  `components/InventoryItemDetailView.tsx`): unambiguous, same pattern as
  `TaskFormScreen.tsx`'s Scan NFC step — checks the scan against that item
  type's own `nfcTagUid` and nothing else. A mismatch shows an inline error;
  the plain "Save" button (no scan) is never blocked by it **unless**
  `nfcRequiredToLog` is true, in which case that button is hidden entirely
  — see "NFC enforcement" below.
- **From the FAB's blind scan** (`components/BottomNav.tsx`): goes through
  `GET /api/tasks/by-nfc-uid`'s combined `TaskDefinition` +
  `InventoryItemType` resolution. A single match resolves directly to `{
  mode: "inventory", itemTypeId }` — there's no session/lock/already-logged
  branching the way a task has (`resolveFabScanTarget`'s four-way split
  doesn't apply here: an append-only inventory count has no per-day
  terminal state to check), so the FAB just navigates to
  `/inventory/<itemTypeId>?verifiedNfcUid=<uid>`. A match shared with one or
  more other targets (another item type, a task, or both) surfaces Part 1's
  disambiguation picker instead; picking "Meat Inventory Count" lands here
  the same way, pre-verified, no second scan.
- **`preVerifiedNfcUid`** (the query param above) is read once by
  `app/(app)/inventory/[itemTypeId]/page.tsx` and passed to
  `InventoryItemDetailView.tsx`. If it matches the item's own `nfcTagUid`,
  the Save button treats the *next* save as pre-verified — same one-save
  pattern as `TaskFormScreen.tsx`'s `preVerifiedNfcUid`/`alreadyVerified`,
  except there's no shared multi-task `preVerified` state to clear
  afterward: this page is a fresh mount per scan (the FAB always does a
  full navigation here, never a same-page prop swap), so there's nothing
  left over to leak onto a later, unrelated save.

## NFC enforcement

Per-item, manager-controlled, default `false` (matches every pre-existing
item type's actual behavior — nothing became stricter on deploy). When a
manager flips `nfcRequiredToLog` to `true` on an item (a checkbox in
`ManageInventoryDetailSheet.tsx`'s editor, sitting directly next to the
"Location Tag" bind panel so the dependency is visually obvious — reached
either from the item detail screen's header Edit icon or from the "Manage
Inventory" hub, see "UI structure" below):

- **`POST /api/inventory-logs`** now rejects (`409`) unless the submitted
  `verifiedNfcUid` matches that item's own `nfcTagUid` exactly —
  `lib/inventory.ts`'s `assertInventoryNfcVerified`, thrown as
  `InventoryNfcRequiredError` and caught the same way `assertNfcVerified`/
  `NfcTagRequiredError` are for tasks. This is the actual enforcement;
  everything else in this section is UI convenience sitting in front of
  this one server-side gate.
- **`InventoryItemDetailView.tsx`** hides the plain "Save" button entirely
  (not disabled-with-no-explanation) — only "Save via NFC" is offered, same
  slot it already occupies when a tag is merely bound-but-optional.
- **`nfcRequiredToLog: true` with `nfcTagUid: null`** (required, but
  nothing bound yet) is a valid-but-inert state, not an error — nothing can
  be logged that way until a tag is bound. Both screens surface this
  plainly rather than blocking the toggle itself: `ManageInventoryDetailSheet.tsx`
  shows a small note under the toggle, and `InventoryItemDetailView.tsx`
  shows a note in place of the Save row for anyone trying to log a count.
- **Task ↔ Inventory Linking's shared-scan case**: see the "Verification is
  shared, never duplicated" subsection below — a required-but-linked item
  whose task-side scan doesn't happen to verify it gets its `InventoryLog`
  write skipped rather than written unverified, and `TaskFormScreen.tsx`
  shows "Requires NFC scan" in place of that one numeric input.
- The FAB's blind-scan resolution (`GET /api/tasks/by-nfc-uid`) is
  unaffected in shape — a scan still resolves and disambiguates exactly as
  described above; `nfcRequiredToLog` only changes what happens once you're
  actually trying to log a count.

## Grouping

`InventoryGroup` is a manager-defined organizational label — "Freezer,"
"Cold Storage," "Dry Storage," "Bar." One group per item
(`InventoryItemType.groupId`, nullable), matching how an item actually sits
in one physical place — not a many-to-many tagging system.

- **Inventory tab** renders one collapsible section per active group
  (creation order), plus an implicit **"Ungrouped"** section last for any
  item with `groupId: null` (hidden entirely if empty). No sort feature —
  groups are the organization; see "Deferred" below.
- **"+ Add Item Type"** (`AddInventoryItemTypeSheet.tsx`) includes a group
  picker (defaults to "Ungrouped") with an inline "+ New Group" option that
  creates an `InventoryGroup` (`POST /api/inventory-groups`) without
  leaving the sheet. The item detail screen's manager edit panel has the
  same picker for moving an existing item between groups.
- **"Manage Groups"** (`components/ManageInventoryGroupsSheet.tsx`,
  manager-only, opened from the "Manage Inventory" hub — see "UI structure"
  below) is a simple list/rename/archive CRUD over `InventoryGroup`. Archiving
  (`DELETE /api/inventory-groups/[id]`) ungroups every member item as part
  of the same request — see the data-model entry above; there is no
  confirmation prompt beyond an inline "this will ungroup N items" notice,
  since items and their history are never at risk.
- **Search** (a bar above the section list, item-name-only —
  `InventoryView.tsx`'s `search` state) collapses the section view into a
  flat filtered list when non-empty, showing each match's group name as a
  small subtitle so context isn't lost; reverts to the normal collapsible
  view when cleared. Does not match group names — see "Deferred" below.

## Par-level alerting

`parLevel` (stored since the first Inventory pass) is now read, not just
stored. **Below par**: the latest `InventoryLog.count` for an item ≤ its
`parLevel`. An item with `parLevel: null` can never be below par — nothing
to compare against, same as before this pass.

- Computed at read time, not stored: `GET /api/inventory-item-types`
  compares each item's `parLevel` against the same latest-log join
  `getLatestInventoryLogs` already produces, adding a plain `belowPar:
  boolean` to each row. No new collection, no new write path.
- **Item-level**: below-par gets the same red treatment everywhere it shows
  an item's count, not just red text — the whole row/card gets a red tint
  (background + border). In the Inventory tab's expanded group list
  (`InventoryView.tsx`'s `ItemRow`) that's the row itself; on the item
  detail screen it's the current-count card. Both render the count as a
  `current/parLevel` fraction — "3/5 rolls" — whenever a par level is set
  (above or below it), so the target is always visible for context, with
  the red tint and warning glyph kicking in only once it's actually
  crossed (the detail screen additionally shows an "At or below par" line
  under the count — the list row relies on the red tint + fraction alone,
  since space is tighter there).
- **Group-level**: a group's header shows a small red dot if *any* active
  item inside it is currently below par — computed client-side in
  `InventoryView.tsx` from the same flat `belowPar` list, not a separate
  aggregation endpoint.
- **No push notifications, no bottom-nav badge** — explicitly out of scope
  for this pass; the red dot only exists inside the Inventory tab's own
  section headers. See "Deferred" below.

## UI structure

- **Inventory tab (list view)** — `components/InventoryView.tsx`, fetched
  from `GET /api/inventory-item-types` (+ `GET /api/inventory-groups` for
  section labels). Grouped into collapsible sections — see "Grouping"
  above — each item row showing name, current count + unit as a
  `current/parLevel` fraction with a red-tinted row when at or below par
  (see "Par-level alerting" above), and how recently it was logged ("Logged
  2h ago by Maria" / "Not yet logged"). Tapping a row opens
  `/inventory/<itemTypeId>` to log a count. Managers see a "+ Add Item
  Type" button (`components/AddInventoryItemTypeSheet.tsx` —
  name/unit/parLevel/group; NFC binding and `nfcRequiredToLog` are separate
  steps once the item exists, same create-then-bind flow as the task
  catalog) and, at the bottom, a "Manage" button into the hub below —
  mirrors `TasksView.tsx`'s own bottom "Manage" button into `/tasks/manage`.
- **Item detail/log screen** — `components/InventoryItemDetailView.tsx`
  (`app/(app)/inventory/[itemTypeId]/page.tsx`). Header row is back button +
  name + (managers only) a pencil "Edit" icon button — placed here,
  immediately under the top nav's own profile icon, specifically so a
  manager sees at a glance where to edit rather than having to discover a
  collapsible section further down the page (see "Editing" below for what
  it opens). Then the current-count card (red-tinted, "3/5 rolls" fraction
  when below par — see "Par-level alerting" above), a numeric input +
  "Save" and, when the item has a bound tag, a second "Save via NFC" button
  next to it — "Save" is hidden instead when `nfcRequiredToLog` is true
  (see "NFC enforcement" above) — then a recent-history list (`GET
  /api/inventory-logs?itemTypeId=&limit=`, newest first — each row shows
  count/who/when, with a small NFC glyph on any row whose `verifiedNfcUid`
  is set). No manager section at the bottom of this page anymore — see
  "Editing" below.
- **Editing** — tapping the header's Edit icon opens
  `components/ManageInventoryDetailSheet.tsx`, the exact same editor the
  "Manage Inventory" hub uses (name/unit/parLevel/group editing, the
  "Location Tag" bind/unbind panel, the `nfcRequiredToLog` toggle beside
  it, and "Archive Item Type") — one component, two entry points, so
  there's no separate edit UI to keep in sync. The page keeps its own
  mutable copy of the item's editable fields (`item` state, seeded from the
  server-rendered prop) so a tag bind/unbind or `nfcRequiredToLog` change
  updates the Save/Save-via-NFC controls above immediately — no page
  reload — while archiving redirects back to `/inventory`.
- **Manage Inventory hub** (`components/ManageInventoryView.tsx`,
  `app/(app)/inventory/manage/page.tsx`) — manager-only, reached from the
  Inventory tab's bottom "Manage" button and from a "Manage Inventory" card
  on the Profile page, same two-entry-point convention as `/tasks/manage`
  (`ManageTasksView.tsx`, linked from both the Tasks page header and
  Profile). One screen for everything a manager needs to keep the catalog
  current without touching the day-to-day log-count flow:
  - **Search + "Scan to Find"** — filters by name or by a bound tag's raw
    UID; the NFC button scans a physical tag and jumps straight to the
    matching item's editor (or a disambiguation picker if the tag backs
    more than one item — same pattern as `ManageTasksView.tsx`'s own
    "Scan to Find").
  - **Groups** — a row that opens the existing `ManageInventoryGroupsSheet.tsx`
    (list/rename/archive) — unchanged from "Grouping" above, just relocated
    here from the Inventory tab's header so there's one manage destination
    instead of two.
  - **Item Types** — every active item, grouped exactly like the Inventory
    tab's own list, each row's meta line showing par level and NFC status
    ("Synced" once a tag is bound, "Required" once `nfcRequiredToLog` is
    also on, "Below par" when applicable) at a glance. Tapping a row opens
    `components/ManageInventoryDetailSheet.tsx` — the full editor: name,
    unit, par level, group, "Save Changes"; then a "Location Tag" panel to
    scan-to-sync or unbind the physical tag (`POST`/`DELETE
    /api/inventory-item-types/[id]/nfc-tag`) and the `nfcRequiredToLog`
    toggle beside it; then "Archive Item Type." Binding/unbinding a tag
    updates the row's list meta immediately without closing the sheet
    (`onTagChanged`), so scanning a tag and then flipping
    `nfcRequiredToLog` in the same visit doesn't require reopening
    anything — only "Save Changes" itself, or Archive, closes the sheet.
  - "+ Add Item Type" at the bottom, same sheet the Inventory tab uses.

## Task ↔ Inventory Linking

A manager can attach one or more `InventoryItemType`s to a task, so checking
that area also captures an inventory count in the same flow — e.g. "Clean
Bathroom" links to Toilet Paper, Soap, and Paper Towels. Supersedes an
earlier yes/no-gate idea sketched (never built) in this doc's first pass —
dropped in favor of the simpler per-link required/optional model below.

**Data model**: `models/TaskInventoryLink.ts` — one join row per
`(taskDefinitionId, itemTypeId)` pair (unique index), not a bare array field
on either side, since `required` is a property of the *pairing*: the same
item type can be required on one task and optional on another. Lives at the
`TaskDefinition` level, not per `Task` placement — same reasoning as
`TaskDefinition.nfcTagUid` (see [nfc.md](nfc.md)'s "In-app scan-to-complete
binding") — a link set from one list's edit screen is shared by every list
this saved task is placed in. `lib/inventory.ts`'s
`getInventoryLinksForTaskDefinition`/`addOrUpdateInventoryLink`/
`removeInventoryLink` are the only writers/readers. Two API route pairs call
them: the original placement-keyed `app/api/tasks/[id]/inventory-links`
(resolves a `Task` placement to its `definitionId` first, same
placement-to-definition split as `app/api/tasks/[id]/nfc-tag`), and — as of
[`unified-task-edit-surface.md`](unified-task-edit-surface.md) — a
definitionId-keyed `app/api/task-definitions/[id]/inventory-links` pair for
editing from the Task Catalog, which has no placement in context.

**Manager side**: a shared "Linked Inventory" panel,
`components/task-panels/LinkedInventoryPanel.tsx` (backed by
`lib/client/use-inventory-links.ts`'s `useInventoryLinks` hook), rendered in
two places — inline on a task's edit row in `TaskListEditView.tsx`'s
`SortableRow` (alongside the existing "Scan-to-Complete Tag" panel), and in
the Task Catalog's `ManageTaskDetailSheet.tsx` — so the same links show and
edit identically from either entry point. Lists current links (name + a
Required/Optional toggle pill + Unlink), plus "+ Add Item" opens
`components/LinkInventoryItemSheet.tsx`, a picker over the company's active
`InventoryItemType`s (already-linked ones excluded) fetched from the same
`GET /api/inventory-item-types` the Inventory tab itself uses — each screen
still owns its own picker instance and `showLinkPicker` state. Removing a
link only deletes that one `TaskInventoryLink` row — the item type and its
`InventoryLog` history are completely untouched, no confirmation prompt (a
low-stakes, easily-re-added action).

**Employee side — the task form**: when a task has one or more links,
`TaskFormScreen.tsx` self-fetches them (`GET
/api/tasks/[id]/inventory-links`, same self-fetch pattern as `Header.tsx`'s
own `notificationSound` fetch — no caller needs to thread this through) and
renders one numeric count input per linked item, positioned after the
task's own fields, labeled with the item's name/unit and a `*` when
required. A required link blocks Save the same way a required field already
does (an inline error, same `setError` path); an optional link left blank
is simply skipped — no `InventoryLog` row is written for a blank optional
field, never a `count: 0`. **Exception**: a link whose item has
`nfcRequiredToLog: true` on a *different* (or no) tag than this task's own
— `canLinkBeVerifiedByThisTask` — can never be satisfied through this
task's completion at all; its numeric input is replaced with a static
"Requires NFC scan" row (no input to type into), and a required link in
that state is exempt from the required-field Save block, since there'd be
no way to ever satisfy it otherwise.

**Verification is shared, never duplicated** — this is the part that
depends on Part 1's multi-target NFC model, and the reason this needed its
own spec rather than a quick Part 2 addition. A task's own
`TaskDefinition.nfcTagUid` and a linked `InventoryItemType.nfcTagUid` are
independent bindings that may or may not point at the *same* physical tag:

- **Same tag on both** (the common case — e.g. the bathroom's tag bound to
  both "Clean Bathroom" and "Toilet Paper"): one scan satisfies both.
  Whichever UID verified the task's own completion (either
  `TaskFormScreen.tsx`'s in-form Scan NFC step, or a `preVerifiedNfcUid`
  carried in from the FAB's scan-in) is compared against each linked item's
  own `nfcTagUid`; a match shows "Tag verified" under that item's field and
  the resulting `InventoryLog` row gets that same `verifiedNfcUid`. No
  second scan, ever — `TaskFormScreen.tsx`'s `buildInventoryCounts` is the
  one place this comparison happens, client-side.
- **Different tags, or no tag on the item**: the task's own verification
  (if it has a tag) is completely unaffected. A linked item with a
  *different* tag, or no tag at all, just gets a plain manual-entry count
  (`verifiedNfcUid: null`) — this flow never initiates a second scan purely
  for a linked item's sake.
- **The server re-checks anyway**: `PATCH /api/task-logs` accepts an
  `inventoryCounts: Array<{ itemTypeId, count, verifiedNfcUid? }>` body
  field (only meaningful with `state: "done"`, same as `formData`), and
  `lib/inventory.ts`'s `writeInventoryLogsForTaskCompletion` — called right
  after the `TaskLog` write succeeds — drops any `itemTypeId` not actually
  linked to this task (defensive; the client only ever sends its own
  fetched links, but a client claim is never trusted outright) and
  re-validates each `verifiedNfcUid` against that item's own bound tag, same
  as `POST /api/inventory-logs` does directly. A UID that verified the
  *task* but doesn't match the *item's* own tag is never stored as
  verified — the two are separate claims that happen to reuse one scan when
  the bindings line up. There's no server-side "required" enforcement for a
  link's own `required` flag (same as `formData`'s own fields — trusted as
  sent), only the client-side gate in `TaskFormScreen.tsx` — but
  `nfcRequiredToLog` *is* enforced server-side here too: an item with that
  flag set whose entry didn't end up with a matching `verifiedNfcUid` has
  its `InventoryLog` row skipped entirely rather than written unverified.
  The task's own completion is unaffected either way — this only changes
  whether that one inventory count gets written.
- **Where this write happens**: only `PATCH /api/task-logs`'s
  `completeInProgressLog` success path — the one path `TaskFormScreen.tsx`'s
  Save action actually reaches (both `TasksView.tsx`'s standalone
  `handleTaskFormComplete` and `TaskListSessionView.tsx`'s
  `saveLog`/`advance`/`handleTaskFormDone` chain funnel into this same PATCH
  call). The route's other "done" branch (manual time-edit / back-entry via
  `startedAt`+`completedAt` overrides) has no UI that ever produces
  `inventoryCounts`, so it's not wired there.
- **Offline**: no special-case code needed. `inventoryCounts` just rides
  along inside the same JSON body `lib/offline-sync.ts`'s
  `queueTaskLogMutation`/`flushQueue` already queues and replays verbatim —
  see [offline.md](offline.md). It only actually reaches the server (and
  writes `InventoryLog` rows) once the queue flushes online; nothing in the
  offline SQLite cache mirrors Inventory data in the meantime, so a
  just-logged count via a linked task isn't reflected in the Inventory tab
  until sync completes.

## API routes

| Route | Method | Gate | Purpose |
|---|---|---|---|
| `/api/inventory-item-types` | GET | any company user | list, joined with each item's latest log — each row now also carries `groupId`, `nfcRequiredToLog`, `belowPar` |
| `/api/inventory-item-types` | POST | manager | create (accepts `groupId`) |
| `/api/inventory-item-types/[id]` | GET | any company user | single item (detail page's server fetch) |
| `/api/inventory-item-types/[id]` | PATCH | manager | edit name/unit/parLevel/groupId/nfcRequiredToLog |
| `/api/inventory-item-types/[id]` | DELETE | manager | archive (soft delete) |
| `/api/inventory-item-types/[id]/nfc-tag` | POST / DELETE | manager | bind / unbind — see `lib/inventory.ts`'s `bindInventoryNfcTag`/`unbindInventoryNfcTag` |
| `/api/inventory-groups` | GET | any company user | list active groups |
| `/api/inventory-groups` | POST | manager | create |
| `/api/inventory-groups/[id]` | PATCH | manager | rename |
| `/api/inventory-groups/[id]` | DELETE | manager | archive; ungroups its items (`groupId` → `null`) as part of the same request |
| `/api/inventory-logs` | GET | any company user | history for one `itemTypeId`, newest first (doubles as "current count" via `[0]`) |
| `/api/inventory-logs` | POST | any company user | log a new count (append-only); `409` if the item has `nfcRequiredToLog: true` and no matching `verifiedNfcUid` was supplied — see "NFC enforcement" |
| `/api/tasks/[id]/inventory-links` | GET | any company user | this task's linked item types, joined with name/unit/nfcTagUid/nfcRequiredToLog/required |
| `/api/tasks/[id]/inventory-links` | POST | manager | link an item type (or update `required` on an existing link — upsert) |
| `/api/tasks/[id]/inventory-links/[itemTypeId]` | PATCH | manager | toggle `required` |
| `/api/tasks/[id]/inventory-links/[itemTypeId]` | DELETE | manager | unlink |

## Deferred / open questions

- **Push notifications / bottom-nav badge for below-par items** — the
  in-tab red-dot cascade is built (see "Par-level alerting" above), but
  nothing pages anyone and the bottom-nav Inventory icon itself never gets
  a badge. A natural fast-follow once push infrastructure exists (already
  on the roadmap separately); this pass only builds the in-tab cascade.
- **Sort** — not built. Grouping already gives practical organization;
  revisit only if real usage shows a need (e.g. "below par first" as a
  cross-group view) that grouping alone doesn't solve.
- **Search matching group names** — out of scope; search is item-name-only
  since grouping already covers "show me everything in the freezer" via
  navigation.
- **Multiple groups per item** — deliberately simplified to exactly one,
  matching how an item actually sits in one physical place. Revisit only if
  a real use case (an item genuinely tracked in two locations) shows up.
- **Does archiving a group's last item auto-archive an empty group?** Not
  modeled — an empty group just sits there; a manager can archive it
  manually via "Manage Groups" if it's clutter.
- **CSV export / Reports integration** — Inventory history does not show up
  anywhere in the Reports tab. Left fully separate for now given how new
  both features are; revisit once Inventory has real usage data.
- **Multiple item types sharing one tag** — supported by construction (it's
  just another entry in Part 1's resolution list, same as the "Ice Packs" /
  "Meat Inventory Count" example in [nfc.md](nfc.md)'s "Multi-target
  binding"), not specially built for.
- **Does an `InventoryLog` need to record it came from a linked task** (vs.
  the Inventory tab directly)? Not modeled — `verifiedNfcUid` aside, nothing
  distinguishes a task-linked write from a direct one; a count is a count
  regardless of source. Revisit if the Reports "Logs" sub-tab or Inventory's
  own history view ever wants to show "via Clean Bathroom task" as context.
- **Order of the inventory fields relative to the task's own fields** —
  currently fixed as "after," matching the natural reading order of "do the
  task, then note what you noticed while you were there." No mechanism to
  configure this per task.
- **`nfcRequiredToLog` interaction with a required-but-linked item's UI
  treatment** — "Requires NFC scan" in place of the input is a reasonable
  placeholder, not a final design pass.
