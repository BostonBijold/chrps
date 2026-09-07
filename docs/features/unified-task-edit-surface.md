> **Keep this file updated after any code change in this area — do not let it drift from actual implementation.**

# Unified Task Edit Surface (Task Lists ↔ Task Catalog)

**Status: BUILT.** Builds on [`manage-tasks-tabs.md`](manage-tasks-tabs.md) (the Task Lists / Task Catalog tab split) — this addresses what happens *inside* each tab when a manager opens one task, not the top-level navigation.

## Problem

A manager opening a task from the **Task Lists** tab (a placement row in `TaskListEditView.tsx`'s `SortableRow`) used to land on a different edit surface than opening the *same underlying task* from the **Task Catalog** tab (`ManageTaskDetailSheet.tsx`). The two surfaces didn't cover the same fields:

| Field | Editable from a Task List row (before)? | Editable from the Task Catalog (before)? |
|---|---|---|
| Name / icon | Yes (`SortableRow`) | No |
| Form fields | Yes | No |
| Estimated time (`projectedMinutes`) | Yes (as this placement's override) | No |
| Scan-to-complete (NFC) link | Yes | Yes |
| Instructions | No | Yes |
| Require a photo | No | Yes |
| Linked inventory | Yes | No |
| Scheduled days / counts-as-a-win threshold | Yes (placement-only concept) | N/A — no schedule without a list |

A manager had to remember which of the two screens a given edit lived on, or bounce between both to fully set up one task.

## What's built

Every field except scheduled days / success threshold is now editable from both entry points, writing to the same underlying `TaskDefinition` (or, for `projectedMinutes`, the same per-placement override logic that already existed). Scheduled days and success threshold stay Task Lists-only, since they're inherently properties of a placement within a specific list — there's no list context to attach them to from the Task Catalog.

### Field-by-field

- **Name, icon, form fields, estimated time** — already definition-level and cascading server-side (`PATCH /api/task-definitions/[id]` already accepted `name`/`icon`/`formFields`/`projectedMinutes`; no API change was needed). Net-new UI: `ManageTaskDetailSheet.tsx` gained `components/task-panels/CoreFieldsEditor.tsx`, reusing the same `AppIcon`/`IconPicker`/`TaskFieldsEditor` building blocks `SortableRow` already used, with its own explicit "Save changes" button (same UX as the Task Lists side). `SortableRow`'s own inline core-fields form is unchanged — it still routes `projectedMinutes` through `PATCH /api/tasks/[id]`'s placement-override path, since it also has the schedule/threshold section that has no catalog equivalent.
- **Scan-to-complete (NFC)** — was already dual-editable (`app/api/tasks/[id]/nfc-tag` from a list row, `app/api/task-definitions/[id]/nfc-tag` from the catalog). Both entry points now render the same `components/task-panels/NfcBindingPanel.tsx`, and both call the *definitionId-scoped* route exclusively (via the shared hook below) rather than keeping two separate call sites.
- **Instructions** — already built (`instructionSteps` on `TaskDefinition`, edited via `PATCH /api/task-definitions/[id]`, see [`task-completion-instructions.md`](task-completion-instructions.md)). Previously only surfaced in `ManageTaskDetailSheet.tsx`; the same `components/task-panels/InstructionsEditorPanel.tsx` (camera capture + Blob upload included) now also renders inline in `SortableRow`'s edit form.
- **Require a photo** — already built (`TaskDefinition.requiresPhoto`, see [`task-completion-photo.md`](task-completion-photo.md)). Previously only surfaced in `ManageTaskDetailSheet.tsx`; the same `components/task-panels/RequiresPhotoTogglePanel.tsx` now also renders in `SortableRow`.
- **Linked inventory** — already definitionId-keyed at the data-model layer (`TaskInventoryLink`, see [`inventory.md`](inventory.md)), but the only API was placement-keyed (`/api/tasks/[id]/inventory-links`, which resolves a placement id to its `definitionId` first — no way to reach a catalog entry with zero placements). Added a definitionId-scoped route pair mirroring the NFC `/nfc-tag` split: `GET/POST /api/task-definitions/[id]/inventory-links` and `PATCH/DELETE /api/task-definitions/[id]/inventory-links/[itemTypeId]`, thin wrappers around the same `lib/inventory.ts` helpers the placement-keyed routes already called. UI: the existing "Linked Inventory" panel is now `components/task-panels/LinkedInventoryPanel.tsx`, rendered by both `SortableRow` and `ManageTaskDetailSheet.tsx` (net-new there), each still owning its own `LinkInventoryItemSheet` picker instance.
- **Scheduled days / success threshold** — unchanged, stays Task Lists-only. Not on the Task Catalog surface; there's no list to schedule against for a catalog entry with zero placements, and for one with multiple placements there's no single "the" schedule to show (each placement has its own).

### Shared components and hooks

Rather than maintaining two parallel implementations, the four fields that were always definition-level regardless of entry point (NFC, Instructions, Require Photo, Linked Inventory) now share:

- **`lib/client/use-task-definition-panel.ts`** — `useTaskDefinitionPanel(definitionId, initial)` hook owning NFC bind/unbind state, instruction-step add/delete (including camera capture via `capturePhoto()` and the Blob upload path), and the Require Photo toggle. Every call is definitionId-scoped (`PATCH /api/task-definitions/[id]`, `POST/DELETE /api/task-definitions/[id]/nfc-tag`).
- **`lib/client/use-inventory-links.ts`** — `useInventoryLinks(definitionId, active)` hook owning the linked-item list plus add/toggle-required/remove, fetched lazily once `active` (the surrounding panel is open). Calls the new definitionId-scoped inventory-links routes above.
- **`components/task-panels/NfcBindingPanel.tsx`**, **`InstructionsEditorPanel.tsx`**, **`RequiresPhotoTogglePanel.tsx`**, **`LinkedInventoryPanel.tsx`** — presentational components taking the hooks' output as props, rendered directly inline by `SortableRow` and inside `ManageTaskDetailSheet.tsx`'s sheet chrome (via new `tagBinding`/`instructions`/`requiresPhotoToggle`/`inventoryLinks` props — `ManageTaskDetailSheet.tsx`'s own public prop shape barely changed, it just delegates each panel's markup to the shared component now).
- **`components/task-panels/CoreFieldsEditor.tsx`** — the Task Catalog's net-new name/icon/fields/estimated-time editor; not shared with `SortableRow`, which keeps its own inline version since it also needs the schedule/threshold section.

Each screen kept its own existing presentation shell — inline expansion for a Task Lists row, a bottom sheet for the Task Catalog — only the fields and their underlying logic were unified, per the "don't change what I like" direction on the surrounding navigation (drag-to-reorder rows vs. compact catalog rows).

## API changes

- **New**: `GET/POST /api/task-definitions/[id]/inventory-links`, `PATCH/DELETE /api/task-definitions/[id]/inventory-links/[itemTypeId]` — definitionId-scoped, mirroring the placement-keyed pair exactly (same `lib/inventory.ts` helpers, same manager-only gate on write).
- **Unchanged**: `PATCH /api/task-definitions/[id]` already accepted every field this needed (`name`/`icon`/`formFields`/`projectedMinutes`/`instructionSteps`/`requiresPhoto`); `PATCH /api/tasks/[id]` already cascaded `name`/`icon`/`formFields`/`requiresPhoto` to the `TaskDefinition`. `POST /api/tasks` now also returns `instructionSteps`/`requiresPhoto` in its response (previously omitted), so a freshly-added task's local state has them without a refetch.

## Depends on

[`manage-tasks-toggle.md`](manage-tasks-tabs.md) — the Task Lists / Task Catalog tab split this sits inside. [`task-lists.md`](task-lists.md) — `TaskListEditView.tsx`/`SortableRow`'s edit form, and the `TaskDefinition`/`Task` placement split these field routes rely on. [`task-completion-instructions.md`](task-completion-instructions.md) — the Instructions panel this shares. [`task-completion-photo.md`](task-completion-photo.md) — the Require Photo toggle this shares. [`inventory.md`](inventory.md) — `TaskInventoryLink`'s definitionId-keyed data model and the placement-keyed API routes the new definitionId-keyed pair mirrors.
