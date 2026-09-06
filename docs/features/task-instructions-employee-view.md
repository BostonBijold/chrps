> **Keep this file updated after any code change in this area — do not let it drift from actual implementation.**

# Task Instructions — Employee View

**Status: BUILT.**

The employee-facing complement to [`task-completion-instructions.md`](task-completion-instructions.md) (manager-authoring side). Adds an **"Instructions"** button directly under the task's title/name on every screen an employee actually sees a task on — the collapsed list row (`TaskRow.tsx`/`TaskCard.tsx`) *and* the active-task screens (`TaskFormScreen.tsx`, `TimerScreen.tsx`) — which opens a read-only sheet (`TaskInstructionsSheet.tsx`) showing that task's up-to-3 instruction steps. Purely additive — no gating of task completion, no dismiss/hide state to track. Only renders when the task actually has at least one step; a task with an empty `instructionSteps` array shows nothing new at all.

The first pass of this feature only covered the list rows; a follow-up added the active-task screens after real usage showed that's where an employee actually needs the reference photo — while performing the check, not while scanning the list beforehand.

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

## Active-task screens

The list-row button alone left a gap: an employee **actively working** a task — the timer/form screen — had no way to see the reference photo without backing out to the list first. Both active-task screens got the identical button-under-title treatment:

- **`TaskFormScreen.tsx`** (the "in progress" screen for `taskType === "form"` — every creatable task type) — reached both as a standalone screen from `TasksView.tsx` and embedded inside `TaskListSessionView.tsx`'s guided walkthrough (the shift-window Start Tasks/Continue Tasks flow). Since `TaskListSessionView` renders `TaskFormScreen` for its own "running" phase rather than any separate task UI, this one change covers the guided-session case too, correcting the original assumption that the session view was out of scope entirely.
- **`TimerScreen.tsx`** (the retired `standard`/`stopwatch` timer UI, kept for schema-compatibility with old data — see CLAUDE.md's "Task types") — both its countdown and stopwatch render branches.

Both components' own item type (`TimerItem` in `components/TimerScreen.tsx`, re-used by `TaskFormScreen.tsx`) is a narrower shape than `RowItem` and needed its own `instructionSteps?: TaskInstructionStep[]` field added — no new data plumbing beyond that, since every call site already passes a `RowItem`-shaped object through (TypeScript structural typing accepts the wider object where the narrower type is declared).

## Explicit non-goals for this pass

- No per-employee dismiss/"don't show again" — decided against; the button is just always available.
- No forced/blocking instruction view before a task can be started or marked done.
- No changes to the manager-authoring side (`task-completion-instructions.md`) — this only adds a read surface on top of data that already existed.

## Depends on

[`task-completion-instructions.md`](task-completion-instructions.md) — `TaskDefinition.instructionSteps` data model, `ResolvedTaskFields`, the step shape (`{ _id, description, imageUrl }`). [`task-lists.md`](task-lists.md) — `TaskRow.tsx`/`TaskCard.tsx` structures this adds a button into, and `TasksView.tsx`/`app/(app)/tasks/page.tsx` as the data source that now carries `instructionSteps` through. [`timer.md`](timer.md) — `TaskFormScreen.tsx`/`TimerScreen.tsx`'s existing structure, and `TaskListSessionView.tsx`'s reuse of `TaskFormScreen` for its guided-session "running" phase.
