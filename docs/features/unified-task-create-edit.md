> **Keep this file updated after any code change in this area — do not let it drift from actual implementation.**

# Unified Task Create/Edit (mobile + console)

**Status: BUILT.** Builds on [`unified-task-edit-surface.md`](unified-task-edit-surface.md) (which closed the gap
between mobile's two *editing* entry points — a Task List row vs. the Task
Catalog) — this closes two further gaps: (1) *creating* a task never
exposed NFC/Instructions/Require Photo/Linked Inventory at all, on either
platform, and (2) console's own *editing* surface never got those three
panels (Instructions/Require Photo/Linked Inventory) in the first place —
`unified-task-edit-surface.md` was mobile-only. Both are fixed here
together, since the create-time fix is only coherent once editing supports
the same fields everywhere.

## Problem

Creating a task — via `AddTaskSheet.tsx`'s "Create custom task" path on
mobile (also used by console's `TaskListDetailPane`), or console's
`TaskCatalogPane`'s "+ New catalog task" — only ever collected name, icon,
form fields, estimated time, and (for a placement) scheduled days/success
threshold. NFC binding, instructions, require-a-photo, and linked
inventory were unreachable until after the task was saved, forcing a
manager who already knew a new task needed an inventory link (or a photo
requirement, or an NFC tag) to save first, then immediately reopen the
same task to finish setting it up.

Separately — and not previously documented — console's **editing** surface
(`TaskListDetailPane.tsx`'s `SortableTaskRow`, `TaskCatalogPane.tsx`'s
`CatalogRow`) never had Instructions/Require Photo/Linked Inventory panels
at all, only a static NFC status line. Only mobile's edit surface
(`TaskListEditView.tsx`'s `SortableRow`, `ManageTaskDetailSheet.tsx`) got
the full field set from `unified-task-edit-surface.md`.

## What's built

### Console edit-parity backfill

`TaskListDetailPane.tsx`'s `SortableTaskRow` and `TaskCatalogPane.tsx`'s
`CatalogRow` now render `InstructionsEditorPanel`, `RequiresPhotoTogglePanel`,
and `LinkedInventoryPanel` — the exact same shared components mobile's edit
surface uses, backed by the exact same `useTaskDefinitionPanel`/
`useInventoryLinks` hooks (`lib/client/use-task-definition-panel.ts`,
`lib/client/use-inventory-links.ts`), scoped to the same definitionId-keyed
routes. NFC stays status-only text on both console rows, unchanged — see
`console-task-management.md`'s "NFC status, not NFC action"; a browser has
no scanner, so console never gets the interactive `NfcBindingPanel`, on
either editing or creating.

`ConsoleTask` (`TaskListDetailPane.tsx`) and `CatalogDefinition`
(`TaskCatalogPane.tsx`) gained `instructionSteps`/`requiresPhoto` fields;
`TaskManagementView.tsx`'s `resolveTasksForList` now joins those through
from the fetched `TaskDefinition` catalog the same way it already joined
`nfcTagUid`.

### Two-phase create, on both platforms

Creation and editing are now the same field set everywhere — empty vs.
prefilled — with one platform difference carried over unchanged: NFC
bind/unbind is an interactive action on mobile, status text only on
console (a browser has no scanner).

| Field | Mobile create | Mobile edit | Console create | Console edit |
|---|---|---|---|---|
| Name / icon | Yes | Yes | Yes | Yes |
| Form fields | Yes | Yes | Yes | Yes |
| Estimated time | Yes | Yes | Yes | Yes |
| Instructions | **New** | Yes | **New** | **New** |
| Require a photo | **New** | Yes | **New** | **New** |
| Linked inventory | **New** | Yes | **New** | **New** |
| Scan-to-complete (NFC) — bind/unbind action | **New** | Yes | No (status only) | No (status only) |
| Scheduled days / success threshold | Yes (placement context) | Yes | Yes (placement context) | Yes |

### How the two-phase save works, made (mostly) invisible

`NfcBindingPanel`, `InstructionsEditorPanel`, `RequiresPhotoTogglePanel`,
and `LinkedInventoryPanel` all operate on an existing `TaskDefinition` id —
there's no id to call them with until the core fields (name/icon at
minimum) have been saved once. The **open question** from the original
spec — autosave-on-blur vs. an explicit initial "Create" step — is resolved
as the latter:

1. The existing "Create custom task" (mobile `AddTaskSheet.tsx`) / "+ New
   catalog task" (console `TaskCatalogPane.tsx`) form is unchanged up
   through its own explicit Save/Create button — nothing is created before
   the user takes that action, same as every other creation path in the
   app.
2. On success, the *same sheet/card* transitions into a "phase 2" view
   (`components/task-panels/CreatedTaskPanels.tsx`) instead of closing —
   the newly-created task's name/icon header, then the same four
   definitionId-scoped panels the edit surface uses, operating on the id
   handed back by the create response. Closing at any point after step 1
   leaves a valid, saved task; nothing is lost by not filling in every
   panel. A "Done" button (or the sheet's own X) finishes the flow.

Quick-adding an existing template, an already-saved task ("Your Saved
Tasks"), or a cross-location clone ("From Other Locations") — the other
three ways `AddTaskSheet.tsx` can add a task — all still close immediately
on success, unchanged. The phase-2 detour is only worth it for a task
built from scratch, where a manager is already in a "set this up
properly" mindset; picking something pre-built is a speed path.

### `CreatedTaskPanels` — the shared phase-2 component

`components/task-panels/CreatedTaskPanels.tsx` renders the header + four
panels + Done button described above, given a `definitionId` that must
already exist (it calls the shared hooks unconditionally on mount, so it's
only ever rendered behind a `created && ...` guard — never with a
placeholder id). Three call sites:

- `AddTaskSheet.tsx`'s "created" view (`allowNfcScan={true}` on mobile,
  `allowNfcScan={false}` when used from console's `TaskListDetailPane`).
- `TaskCatalogPane.tsx`'s `NewCatalogTaskForm`, once its own `onCreate`
  resolves (`allowNfcScan={false}`, console-only).

### The `onAdd`/`onCreate` contract change

Every creation path's top-level handler (mobile `TasksView.tsx`'s
`handleAddTask`, `ManageTasksView.tsx`'s `handleAddTask`,
`TaskListEditView.tsx`'s `handleAdd`; console `TaskManagementView.tsx`'s
`handleAddTask`/`handleCreateDefinition`) now **returns** the created
definition's id/NFC/instructions/photo state (`CreatedTaskInfo | null`)
instead of returning void and closing the sheet itself. Closing is now
`AddTaskSheet`/`NewCatalogTaskForm`'s own responsibility — immediately for
a quick add, or after the phase-2 panels' Done button for a from-scratch
create. `POST /api/tasks` and `POST /api/task-definitions` already
returned everything `CreatedTaskInfo` needs (`unified-task-edit-surface.md`
had already added `instructionSteps`/`requiresPhoto` to `POST /api/tasks`'s
response) — no API changes were needed for this feature.

## API changes

None. Every route this reads from or writes to
(`POST /api/tasks`, `POST /api/task-definitions`,
`PATCH /api/task-definitions/[id]`,
`POST/DELETE /api/task-definitions/[id]/nfc-tag`,
`GET/POST /api/task-definitions/[id]/inventory-links`,
`PATCH/DELETE /api/task-definitions/[id]/inventory-links/[itemTypeId]`)
already existed from `unified-task-edit-surface.md`.

## Files touched

- `components/task-panels/CreatedTaskPanels.tsx` — **new**, the shared
  phase-2 component.
- `components/AddTaskSheet.tsx` — `onAdd` now returns `CreatedTaskInfo |
  null`; added the "created" view; `allowNfcScan` prop.
- `components/TasksView.tsx`, `components/ManageTasksView.tsx`,
  `components/TaskListEditView.tsx` — their `onAdd`-equivalent handlers
  return `CreatedTaskInfo | null` and no longer close the sheet themselves.
- `components/console/TaskListDetailPane.tsx` — `SortableTaskRow` gained
  Instructions/Require Photo/Linked Inventory panels (edit-parity
  backfill); its `AddTaskSheet` usage passes `allowNfcScan={false}` and no
  longer closes on `onAdd`.
- `components/console/TaskCatalogPane.tsx` — `CatalogRow` gained the same
  three panels (edit-parity backfill); `NewCatalogTaskForm` gained the
  phase-2 transition; `onCreate` returns `CreatedTaskInfo | null`.
- `components/console/TaskManagementView.tsx` — `handleAddTask`/
  `handleCreateDefinition` return `CreatedTaskInfo | null`;
  `resolveTasksForList`/`TaskDefinitionEntry` carry `instructionSteps`/
  `requiresPhoto` through.

## Depends on

[`unified-task-edit-surface.md`](unified-task-edit-surface.md) — the panel
components and hooks this reuses wholesale, and the mobile edit surface
this brings console up to parity with.
[`console-task-management.md`](console-task-management.md) — the
console's existing NFC-status-only rule this carries forward unchanged
into both editing (now, for the first time, alongside the other three
panels) and creation.
[`inventory.md`](inventory.md) — `TaskInventoryLink`, the
definitionId-scoped routes `LinkedInventoryPanel` calls.
[`nfc.md`](nfc.md) — the mobile scan-to-bind flow `NfcBindingPanel` calls.
