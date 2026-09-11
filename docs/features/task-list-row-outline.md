# Task List Row-Outline (replaces the header pill)

**Supersedes [`task-list-row-box.md`](task-list-row-box.md) visually** — the structure (an outlined container around just the task row list, title line and "Start Tasks" button outside it, header strip on top / footer strip on bottom) and the header/footer strip **text logic** are unchanged from that doc. This iteration is a styling pass only: outline color-by-state, heavier stroke, tinted header/footer sections, and more compact spacing.

## Problem

The row-box's outline was a plain 1px `border-border`/`border-done/40` line with no state-driven color shift beyond a faint tint, and its header/footer/body padding matched the rest of the app's card chrome — comfortable, but not visually distinct enough to read "not started → running → done" at a glance the way the spec wanted.

## What's built

Same outlined container as `task-list-row-box.md`, restyled:

- **Outline color by state**: `border-border` (neutral gray) while not complete, `border-done` (full-strength green, not a muted tint) once the list is complete — the whole outline, not just an inner fill.
- **Stroke weight**: `border-[3px]`, up from the row-box's plain `border` (1px).
- **Header/footer section background** tints to match: `bg-card` (the app's existing neutral card-surface token) by default, `bg-done/10` once complete — same green-tint convention the original "✓ Done" pill's own background already used. The row list in between keeps its existing `bg-card` fill (`TaskRow`'s wrapper) unchanged in every state, as specified.
- **Corners**: unchanged — still `rounded-card` (12px), the same radius already used on task-row cards elsewhere per CLAUDE.md's design system; "fully rounded, iOS-style" reads as this existing app-wide card radius, not literal full-pill rounding (`20px`/full-round is reserved for badges/pills per the design system).
- **Compactness**: header/footer strips, the collapsed-summary rows, and the expanded body's own padding are all tightened by roughly a third (e.g. the strips' `px-4 py-2` → `px-3 py-1.5`, the collapsed-summary buttons' `px-4 py-3.5` → `px-3 py-2.5`). **`TaskRow.tsx`'s own per-task row height is untouched** — it already sits comfortably above CLAUDE.md's 44px minimum tap-target rule, and "tighter row height" in the spec is read here as the row-*box's* own chrome, not a license to shrink an individual task's tap target below that floor.

## Resolved open questions

Same resolutions `task-list-row-box.md` already made, carried forward unchanged — redundancy with the title line's live stat (kept both, deliberately), no-session fallback (blank strips), restarted sessions (most-recent session wins, no special-case needed). Newly added by this pass:

- **Missed-only completion**: the outline still turns fully `done`-green — no separate visual state for "complete but with a `missed` in it." Matches the row-box's own resolution of the same question (footer just shows the timestamp either way); out of scope to add a third color for now.
- **Exact color tokens/spacing**: resolved as `border-done`/`bg-done/10` (full-strength, not a muted opacity variant, since the spec explicitly asked for the outline to visibly "turn green" rather than lightly tint) and the padding values above — reusing existing design-system tokens throughout rather than introducing new ones.

## Depends on

[`task-list-row-box.md`](task-list-row-box.md) — the row-box structure and header/footer text logic this only restyles. [`timer.md`](timer.md#-done-pill--session-start-end-time--owner-superseded) — `TaskListSession` model, `ownerName` resolution, `GET /api/task-list-sessions`.
