> **Keep this file updated after any code change in this area — do not let it drift from actual implementation.**

# Console — Inventory Management

**Product-facing rebrand: "Par Sheet."** The console page title and all
user-visible copy on this page now say "Par Sheet" instead of "Inventory"
— UI text only, same as mobile; see `docs/features/inventory.md`'s note
and CLAUDE.md's "Inventory" section. Route (`/console/inventory`),
component/file names, and model/API naming are unchanged.

**Status: BUILT.** A page inside the existing
[`admin-console.md`](admin-console.md) section. Rides on the owner-or-
manager console gate established in
[`console-task-management.md`](console-task-management.md) — no auth-gate
change was needed, since Inventory is already a manager-and-up management
surface on mobile (create/edit/archive gated manager, not owner-only).

## User story

As a manager or owner, manage the inventory catalog — item types, groups,
par levels — and log counts from a desktop browser, using the exact same
data and rules as the phone, just in a web-based view instead of a
phone-shaped one.

## NFC — explicitly out of scope for this pass

Nothing NFC-related is built here: no tag bind/unbind, no
`nfcRequiredToLog` toggle, no "Save via NFC" button, no NFC status display
at all — the same field-level omission `console-task-management.md`
resolved differently for tasks (a read-only "Linked"/"Not linked" badge);
here even that status display is left out. `GET /api/inventory-item-types`
still returns `nfcTagUid`/`nfcRequiredToLog` per item (unchanged route),
this page's components simply never read or render those two fields.

**Known consequence**: an item type with `nfcRequiredToLog: true` already
set from mobile will `409` on any count logged from this page — this page
has no way to supply a `verifiedNfcUid`. Rather than surface the server's
own mobile-phrased message ("...use Save via NFC," which points at a
button that doesn't exist here),
`components/console/ConsoleInventoryManagementView.tsx`'s `handleLogCount`
catches the `409` specifically and shows "This item requires an NFC scan —
log this count from the mobile app" instead (Open Question #4, resolved
as the simpler "plain error message" option — the log input itself stays
enabled for every item, nothing is preemptively disabled).

## Page: `/console/inventory`

Owner or manager (not employee). Reuses every existing route as-is — no
new backend, and NFC-specific routes are simply never called from here:

- `GET`/`POST /api/inventory-item-types`, `PATCH`/`DELETE
  /api/inventory-item-types/[id]` — catalog CRUD. Create/edit forms never
  send `nfcRequiredToLog`; it stays whatever it already was (default
  `false` for a new item).
- `GET`/`POST /api/inventory-groups`, `PATCH`/`DELETE
  /api/inventory-groups/[id]` — group CRUD; archiving ungroups member
  items server-side (`lib/inventory.ts`'s `archiveInventoryGroup`),
  unchanged.
- `GET /api/inventory-logs?itemTypeId=&limit=` — an item's recent
  history, newest first; also how "current count" is derived
  (`GET /api/inventory-item-types`'s own `currentCount` field, computed
  server-side the same way).
- `POST /api/inventory-logs` — log a new count. No `verifiedNfcUid` ever
  sent — every write from console is a plain manual entry.
- `PATCH /api/session/active-location` — location switcher, same endpoint
  the console Reports page and mobile already use.

**Not reused**: `POST`/`DELETE /api/inventory-item-types/[id]/nfc-tag`.

### Location scoping

`InventoryItemType`/`InventoryGroup` stay the shared, company-wide
catalog they already are — this page's create/edit/archive/group actions
aren't location-scoped at all, same as mobile. `InventoryLog` (the actual
counts) is per-location, so counts/history shown are for whichever
location is currently active.

**Location switcher**: `components/LocationSwitcher.tsx`, reused
unmodified — owner-only, shown only at a company with 2+ active
locations, same gating as the console Reports page. Selecting a location
`PATCH`es `/api/session/active-location`, then bumps a `refreshTick` to
remount the item-types table + groups panel against the new location's
counts (same key-bump convention as `console-reports.md`).

### Layout

Matches the console's flat inline-edit-row table convention rather than
Task Management's two-pane layout — item types are flatter to edit (name/
unit/par/group, no nested fields).

- **`components/console/InventoryItemTypesTable.tsx`** — one table per
  active `InventoryGroup` (creation order) plus an implicit "Ungrouped"
  section last, mirroring mobile's `InventoryView.tsx` grouping. Each row:
  Name, Unit, Current/Par (red-tinted + a warning icon when at/below par),
  Group (an always-visible inline `<select>`, same pattern as
  `TeamTable.tsx`'s per-row location reassignment — no edit-mode needed
  just to move an item between groups), **Log a Count** (a number input +
  Save button, always visible in the row — Open Question #1, resolved
  toward speed rather than a per-item expand/modal), and Actions (a
  history expand toggle, an edit pencil swapping the row into inline
  inputs for Name/Unit/ParLevel, and an archive trash icon).
- **History** (Open Question #2, resolved as its own affordance separate
  from the always-visible log input): the row's chevron toggle expands an
  inline sub-row fetching `GET /api/inventory-logs?itemTypeId=&limit=10`
  on demand — count, timestamp, logged-by name, newest first.
- **"+ Add Item Type"** — an inline create row (name, unit, parLevel,
  group picker) below all the group tables, same inline-create interaction
  used elsewhere in the console. The group `<select>` includes a
  "+ New Group…" option that swaps in a text input, creating the group via
  `POST /api/inventory-groups` before the item itself is created and
  pre-selecting it — same create-inline pattern
  `AddInventoryItemTypeSheet.tsx`'s mobile equivalent already uses.
- **`components/console/InventoryGroupsPanel.tsx`** ("Manage Groups") — a
  **persistent panel below the main table** (Open Question #3, resolved
  against a modal/slide-over) — create/rename/archive, same layout
  precedent as `components/console/JobTagsPanel.tsx` sitting below
  `TeamTable.tsx` on the Team & Access page. Archiving confirms first
  ("its items move to Ungrouped") since the item-types table above
  refetches and visibly reflects the ungroup immediately.

### What's explicitly unaffected

`InventoryView.tsx`, `InventoryItemDetailView.tsx`,
`AddInventoryItemTypeSheet.tsx`, `ManageInventoryDetailSheet.tsx`,
`ManageInventoryGroupsSheet.tsx` — untouched. Same APIs, same NFC binding
flow, same enforcement behavior.

### Sidebar

`components/console/ConsoleSidebar.tsx` gained an **Inventory** item
(same `Package` icon mobile's own Inventory tab uses), visible to both
owner and manager — same visibility as Task Management and Reports.
Owner nav, in order at the time: Locations, Team & Access, Task
Management, Reports, Inventory, Rollup Dashboard. Manager nav: Task
Management, Reports, Inventory.

**Superseded**: Locations was later removed from the console and Rollup
Dashboard moved to be `/console`'s own homepage rather than a sidebar
item — current owner nav is Dashboard, Team & Access, Task Management,
Reports, Inventory. See [`admin-console.md`](admin-console.md)'s "Removed:
Locations CRUD" and "Nav & shell". Inventory's own position (after
Reports) is unaffected.

Neither role's default landing page changed for a manager; an owner's did
(see the superseded note above).

## Depends on

[`features/inventory.md`](inventory.md) — every reused route, the data
model, and the NFC section this intentionally doesn't touch.
[`admin-console.md`](admin-console.md) — the inline-edit-row table
convention this follows, sidebar/shell conventions.
[`console-task-management.md`](console-task-management.md) — the
owner-or-manager console gate this rides on.
[`console-reports.md`](console-reports.md) — the location-switcher
pattern this reuses without modification. [`features/locations.md`](locations.md)
— `LocationSwitcher`, `activeLocationId`, `PATCH
/api/session/active-location` mechanics.
