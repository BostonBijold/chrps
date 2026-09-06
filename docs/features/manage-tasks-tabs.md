> **Keep this file updated after any code change in this area — do not let it drift from actual implementation.**

# Manage Tasks — Task Lists / Task Catalog Toggle (Mobile)

**Status: BUILT.**

## Problem

`components/ManageTasksView.tsx` (`/tasks/manage`) used to stack three sections on one screen: **Task Lists** (always expanded), **Standalone Tasks** (the anytime lists' tasks, collapsible past 5), and **Company Task Catalog** (collapsible past 5). A manager who wanted to add or edit a task's completion Instructions (see [task-completion-instructions.md](task-completion-instructions.md)) had to scroll past whichever sections preceded the catalog, find the right compact row, tap it open, and find the Instructions panel inside `ManageTaskDetailSheet.tsx` alongside Used In / NFC / Edit-in-list / Delete. The console's equivalent page (`/console/tasks`, `components/console/TaskManagementView.tsx`) already solved the analogous problem with a segmented control — **Task Lists** vs **Task Catalog** — as two independent views. This brings that same top-level split to mobile.

## What's built

A segmented control at the top of `ManageTasksView.tsx`, same two labels as the console (**Task Lists** | **Task Catalog**), replacing the old single stacked-sections screen. No new API routes — purely a client-side reorganization of the existing page, same spirit as the console page reusing `GET/POST/PATCH/DELETE /api/task-lists` and `/api/task-definitions` as-is.

### Tab: Task Lists (default)

Everything that's about *placements*, unchanged in behavior:

- The **Task Lists** section (every scheduled `TaskList`, always expanded, "+ Add Task List" button).
- The **Standalone Tasks** section (read-only overview of the anytime lists' tasks, compact rows, collapsible past `COLLAPSE_THRESHOLD`).
- The sticky search box, scoped to these two sections while this tab is active (placeholder: "Search task lists...").

### Tab: Task Catalog

The **Company Task Catalog** section, on its own full-width tab rather than the last item in a scroll:

- Same compact-row list (icon, name, one-line meta, chevron) — but **always expanded now, no collapse toggle**. The old collapse-past-5 behavior was dropped in a follow-up fix: it meant a manager had to open the Task Catalog tab *and then* tap again to expand an already-collapsed list, a redundant "open it twice" step now that the catalog has its own dedicated screen rather than sharing space with other sections. Task Lists' own "always expanded" section keeps its same reasoning; Standalone Tasks (Task Lists tab) is the only section left with collapse-past-`COLLAPSE_THRESHOLD` behavior.
- **"Scan to Find"** (the NFC button next to the search box) only renders on this tab — it matches a scanned tag against the catalog's own `nfcTagUid` data, a catalog-only concept with nothing to match against on the Task Lists tab.
- Tapping a row still opens `ManageTaskDetailSheet.tsx` — no change to the sheet's contents in this pass (Used In / NFC / Instructions / Edit-in-list / Delete all stay as they are).
- Search box, scoped to catalog rows while this tab is active (placeholder: "Search saved tasks...").

### What doesn't move

- `AddTaskSheet.tsx`'s two-path flow (browse template / build custom / "Your Saved Tasks") is unchanged and still reachable only from a Task List's own edit screen (`TaskListEditView.tsx`) or the "+ Add Task List" → immediately-populate-it chain on the Task Lists tab — not from the Task Catalog tab.
- `POST /api/task-definitions` (catalog-only creation, no placement) is still not called from mobile at all (console-only) — no "+ New Catalog Item" entry point was added to the Task Catalog tab in this pass (see "Deferred" below).

## Implementation

- **`components/ManageTasksView.tsx`**: a `useState<"lists" | "catalog">("lists")` `activeTab`, rendered as a pill-shaped segmented control (`bg-olive text-text` active tab, `text-dim` inactive — same visual language as the console's `TaskManagementView.tsx`, adapted to full mobile width instead of an inline header control). The component's single render was split into two `{activeTab === "..." && (...)}` branches; both continue to share the same fetched `taskLists`/`definitions` props/state and the same refetch-after-mutation convention (`router.refresh()`) already in place — no new data-fetching logic.
- Switching tabs does not reset `search` — a query typed on one tab carries over if the manager switches (scoped differently once there, per the section it now filters). Not persisted across page visits (no localStorage per CLAUDE.md), so it always starts on the Task Lists tab on a fresh load.
- **`components/ManageTaskDetailSheet.tsx`**: unchanged (see "Deferred" for a possible follow-up promoting Instructions higher within the sheet).
- **`app/(app)/tasks/manage/page.tsx`**: unchanged — still a server component doing auth/data-loading only; tab state is local to the client component.

## Deferred

- **A "+ New Catalog Item" entry point** on the Task Catalog tab (wiring up `POST /api/task-definitions`, already built for the console but unused on mobile), now that the catalog has a dedicated full screen rather than living at the bottom of a longer page. Not built — this pass was purely the reorganization, not a new creation path.
- **Promoting Instructions within `ManageTaskDetailSheet.tsx`** — e.g. above Used In / NFC, or a quick-access "has instructions" indicator directly on the compact row — rather than requiring the sheet to open first. Not decided; the most direct answer to "make it easier to add instructions," but out of scope for this pass, which only addressed top-level navigation.
- **Remembering the manager's last-used tab** across visits — no persistence mechanism decided (same constraint as the existing collapse/search state: no localStorage per CLAUDE.md, a MongoDB-backed per-user preference not yet judged worth it).

## Depends on

[`features/task-lists.md`](task-lists.md) — the Company Task Catalog / Standalone Tasks compact-row conventions this reorganizes but doesn't change. [`features/task-completion-instructions.md`](task-completion-instructions.md) — the Instructions panel inside `ManageTaskDetailSheet.tsx`, unchanged by this pass but the direct motivation for it. [`features/console-task-management.md`](console-task-management.md) — the console's `TaskManagementView.tsx` segmented-control pattern this mirrors.
