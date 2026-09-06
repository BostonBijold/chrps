> **Keep this file updated after any code change in this area — do not let it drift from actual implementation.**

# Task Instructions — Employee View

**Status: BUILT.**

The employee-facing complement to [`task-completion-instructions.md`](task-completion-instructions.md) (manager-authoring side). Adds an **"Instructions"** button directly under the task's title on both `TaskRow.tsx` (shift-window tasks) and `TaskCard.tsx` (anytime tasks), which opens a read-only sheet (`TaskInstructionsSheet.tsx`) showing that task's up-to-3 instruction steps. Purely additive — no gating of task completion, no dismiss/hide state to track. Only renders when the task actually has at least one step; a task with an empty `instructionSteps` array shows nothing new at all.

## Decisions locked in

- **No auto-hide by tenure or completion count.** The button is simply always there for any task that has instructions — every employee, every time, on-demand only. No new field on `User` or `TaskLog`.
- **Not a gate on completion.** Viewing instructions is optional; a task can still be marked done without ever opening the sheet.
- **Placement**: directly under the task title, above the rest of the row/card's existing content (streak dots, action buttons) — same slot in both `TaskRow` and `TaskCard`.

## Data plumbing

`app/(app)/tasks/page.tsx` already calls `lib/task-definitions.ts`'s `resolveTasks` (which resolves `instructionSteps` as part of `ResolvedTaskFields`, built for the manager-authoring feature), but its own hand-picked mapping into the `tasks` array it hands to `TasksView` (`_id, name, icon, projectedMinutes, order, taskType, scheduledDays, successThreshold, formFields, nfcTagUid`) didn't include `instructionSteps` — this was the one real code gap, now fixed (each step serialized to `{ _id, description, imageUrl }`, same shape `GET /api/task-definitions` returns).

Note this is distinct from `GET /api/task-lists` (`app/api/task-lists/route.ts`) — that REST route intentionally returns only the *raw placement* shape (no name/icon/instructionSteps at all; see its own docstring) since it's the offline-sync source mirroring `Task`/`TaskDefinition` as two separate SQLite tables. It was never in scope here and wasn't touched.

`components/TaskRow.tsx`'s `RowItem` interface (shared by both `TaskRow` and `TaskCard` — see `docs/features/task-lists.md`) gained `instructionSteps?: TaskInstructionStep[]`, so the field flows through `TasksView` → `TaskListCard` → `TaskRow`/`TaskCard` with no other type plumbing needed.

## New component: `TaskInstructionsSheet.tsx`

Read-only bottom sheet, same presentation convention as the app's other sheets (`AddTaskSheet`, `ManageTaskDetailSheet`) — backdrop, `rounded-t-modal` sheet, drag-handle bar, header with task icon/name and a close `X`. Renders the same image-forward step layout the manager's "Instructions" section in `ManageTaskDetailSheet.tsx` uses (image + caption when present, description-only text when a step has no image) — but with none of the edit affordances: no Delete icon, no "+ Add Step" button, no file picker. Just the steps, in stored order, and a close action.

Props: `taskName: string`, `taskIcon: string`, `steps: TaskInstructionStep[]`, `onClose: () => void`.

## Button

A small shared control — a `ClipboardList` icon (lucide-react) + "Instructions" label, olive-colored, `font-mono text-[10px]` — rendered directly under the task's title in both components, gated on `item.instructionSteps?.length > 0` (nothing renders otherwise, no placeholder/empty state). No badge, count, or "new" indicator — identical whether it's an employee's first time seeing this task or their thousandth.

**`TaskRow.tsx`** needed one structural change to fit this in: the whole collapsed row used to be a single `<button onClick={onToggleExpand}>` wrapping the icon/title/streak-dots/state-badge, which made a real nested `<button>` for Instructions invalid HTML (and would have made tapping it also toggle row expansion). The row's outer element is now a `<div role="button" tabIndex={0} onClick={...} onKeyDown={...}>` — same click/expand behavior and keyboard accessibility (Enter/Space), but a legally nestable container — with the Instructions button inside calling `e.stopPropagation()` so it doesn't also fire the row toggle.

**`TaskCard.tsx`** has four separate early-return render branches (done/missed/rest/pending) rather than one shared shell, so the button and the sheet's conditional render are each computed once (`instructionsButton`, `instructionsSheet` — memo-free plain consts, cheap enough not to need `useMemo`) and inserted into all four branches identically, right after each branch's `<p>{item.name}</p>`.

## Explicit non-goals for this pass

- No per-employee dismiss/"don't show again" — decided against; the button is just always available.
- No forced/blocking instruction view before a task can be started or marked done.
- No changes to the manager-authoring side (`task-completion-instructions.md`) — this only adds a read surface on top of data that already existed.
- `TaskListSessionView.tsx` (the guided multi-task walkthrough) renders its own task UI rather than reusing `TaskRow`/`TaskCard`, and was out of this pass's scope — it does not show an Instructions button.

## Depends on

[`task-completion-instructions.md`](task-completion-instructions.md) — `TaskDefinition.instructionSteps` data model, `ResolvedTaskFields`, the step shape (`{ _id, description, imageUrl }`). [`task-lists.md`](task-lists.md) — `TaskRow.tsx`/`TaskCard.tsx` structures this adds a button into, and `TasksView.tsx`/`app/(app)/tasks/page.tsx` as the data source that now carries `instructionSteps` through.
