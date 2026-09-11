# Task List Row-Outline (replaces the header pill)

**Structure and header/footer text logic are unchanged from [`task-list-row-box.md`](task-list-row-box.md)** — an outlined container around just the task row list, title line and "Start Tasks" button outside it, header strip on top / footer strip on bottom. This doc covers the visual-styling pass on top of that structure, including a since-corrected first attempt (see "History" below).

## Problem

The row-box's outline was a plain 1px `border-border` line with no state-driven visual shift beyond a faint completed-state tint, its header/footer/body padding matched the rest of the app's card chrome, and the title line above it duplicated the header strip's own task-count/minutes — comfortable, but not visually distinct enough to read "not started → running → done" at a glance, and one number shown twice.

## What's built

Same outlined container as `task-list-row-box.md`, restyled:

- **Outline stroke**: `border-[3px]` (up from the row-box's plain `border`, 1px), **always neutral `border-border`** — the stroke itself never changes color by state. A completed list is signaled entirely by the header/footer tint below, not by the outline's own color.
- **Header/footer section background** tints by state: `bg-card` (the app's existing neutral card-surface token) by default, `bg-done/10` (a light green tint, not a heavy fill) once the list is complete — same convention the original "✓ Done" pill's own background already used. This is the *only* thing that changes color on completion.
- **The row list in between keeps its existing neutral `bg-card` fill in every state, unchanged** — untouched by any of this.
- **Zero gutter between the outline and the row list**: the expanded task-row list sits flush against the outline on all sides, no padding wrapper around it. Its own `rounded-card` corner rounding was dropped too — it sat between the header/footer strips' dividers, not at the outline's own rounded corners, so with no gutter left to contain it, a separately-rounded rectangle there would just float oddly. (The collapsed-summary rows keep their own content padding — that's padding around icons/text inside a section, not an outer gutter around a nested box, so it wasn't part of this fix.)
- **Corners**: unchanged — still `rounded-card` (12px) on the outline itself, the same radius already used on task-row cards elsewhere per CLAUDE.md's design system; "fully rounded, iOS-style" reads as this existing app-wide card radius, not literal full-pill rounding (`20px`/full-round is reserved for badges/pills per the design system).
- **Compactness**: header/footer strips, the collapsed-summary rows, and (previously) the expanded body's own padding are all tightened by roughly a third relative to the row-box (e.g. the strips' `px-4 py-2` → `px-3 py-1.5`, the collapsed-summary buttons' `px-4 py-3.5` → `px-3 py-2.5`). **`TaskRow.tsx`'s own per-task row height is untouched** — it already sits comfortably above CLAUDE.md's 44px minimum tap-target rule, and "tighter row height" is read here as this component's own chrome, not a license to shrink an individual task's tap target below that floor.
- **Title line no longer shows its own live task-count/minutes stat** — it duplicated the header strip's static count, and the redundancy is resolved by dropping the title line's copy rather than the strip's (the title line still shows just the list name, tap-to-toggle unchanged).

### History: the outline used to turn green too (corrected)

The first pass of this styling redesign made the outline's own stroke shift from gray to full-strength `border-done` on completion, on top of the header/footer tint. That read as a heavier, "giant dark green border" effect than intended — the tint on the header/footer sections alone was meant to be *the* completion signal, subtle rather than a bold outline color change. Reverted: the stroke now stays `border-border` in every state, and only the header/footer backgrounds tint gray → light green.

## Resolved open questions

- **Redundancy with the title line's own stat**: resolved — the title line's live stat was removed; only the header strip's static count remains. (Earlier passes had left this undecided or resolved the opposite way, keeping both; this is the final call.)
- **No-session fallback for a completed list**: unchanged from `task-list-row-box.md` — both strips stay blank (no reconstructed guess) when a list completes without ever routing through a `TaskListSession`.
- **Missed-only completion**: no separate visual state — the header/footer tint still goes green either way, matching the row-box's own resolution (the footer just shows the timestamp regardless of whether every task was `done` or some were `missed`).
- **Restarted sessions same day**: confirmed — `GET /api/task-list-sessions` already returns each list's most recent session (`getSessionSummariesForDate`), no special-case needed.
- **Exact color tokens/spacing**: `bg-done/10` (a light tint, not a solid fill — matching the spec's explicit "light gray/light green" framing this time, as opposed to the reverted stroke-color attempt) and the padding values above, reusing existing design-system tokens throughout.

## Depends on

[`task-list-row-box.md`](task-list-row-box.md) — the row-box structure this only restyles. [`timer.md`](timer.md#-done-pill--session-start-end-time--owner-superseded) — `TaskListSession` model, `ownerName` resolution, `GET /api/task-list-sessions`.
