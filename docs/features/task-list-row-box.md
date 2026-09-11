# Task List Row-Box (replaces the header pill)

**Supersedes [`task-list-status-box.md`](task-list-status-box.md)**, which itself replaced the original single-line "✓ Done" pill (`timer.md`'s now-superseded section). See that file for why a bordered box replaced the pill in the first place — this doc only covers what changed in the follow-up iteration: the box now wraps **only the task row list**, not the whole card.

## Problem

The first status-box iteration wrapped the entire `TaskListCard` — title line, header/footer strips, and the "Start Tasks" button all inside one border. That made the title line's own live `0/7 · 25m` progress stat sit awkwardly duplicated against the box's own header-strip content, and put the "Start Tasks" button inside a box whose visual language (bordered, done-tinted once complete) didn't really apply to it. This redesign narrows the box to just the row list, with the title line and "Start Tasks" button restored to their original positions outside it.

## What's built

A bordered box wraps **only the task row list** — not the list's title line (`Opening Shift`, its live `{done}/{total} · {mins}` progress stat) and not the "Start Tasks"/"Continue Tasks" button below it, both of which sit outside the box exactly as they did before any of this pill/box work started. The box's top edge is a **header strip** and its bottom edge is a **footer strip**, both baked into the box itself rather than separate pills. The box's shape (header strip + row list + footer strip) never changes between collapsed and expanded — only the rows in the middle grow or shrink. Tapping either the title line or the header strip toggles collapse/expand, same single `toggle()` handler as before.

### Header strip (top edge of the box, directly above the first row)

| State | Content |
|---|---|
| Not yet started (no `TaskListSession` for this list/date) | Scheduled `startTime`, task count, and projected total minutes — e.g. "Starts 8am · 7 tasks · 25m" (blank if the list has no `startTime`, still showing the count/minutes). |
| Session open or complete (`TaskListSession` exists) | The session's actual `startedAt` + `ownerName` (`TaskListSession.performedByUserId`, stamped once at creation, never reassigned — same field the original pill used), **plus the task count and projected minutes, unconditionally** — e.g. "10:15pm · Boston Bijold · 7 tasks · 25m". This persists through and past completion; the footer adds the finish time on top, it doesn't replace anything here. |

Task count/minutes use the day's **visible** (scheduled-for-today) task set — the same numbers the title line's own live stat is built from — not the list's full unfiltered task roster.

### Footer strip (bottom edge of the box, directly below the last row)

| State | Content |
|---|---|
| Not yet complete | Blank — fixed `min-h` so the box's height doesn't jump when it fills in. |
| Complete (`TaskListSession.completedAt` set) | The finish timestamp only, e.g. "10:16pm" — no name (see `task-list-status-box.md` for why the footer never attributes). |

### Color change on completion

The box's border shifts to a `done`-tinted treatment once the list is complete (`border-done/40`, the same token already used for a finished card's accent elsewhere) — reusing the app's existing "complete" visual language rather than introducing a new one, per the spec's own instruction to reuse whatever treatment already exists.

### Collapsed vs. expanded

The header/footer strips render identically whether the box is collapsed or expanded — only the task rows in between grow/shrink. The title line and its progress stat above the box, and the Start Tasks/Continue Tasks button below it, keep their pre-existing behavior untouched — including the button's own visibility rule (only rendered while expanded, `!effectivelyCollapsed`), now just physically outside the bordered box instead of inside its padded body.

### Resolved open questions

The spec left these undecided; resolved as follows when this shipped:

- **Redundancy with the title line's own live stat**: kept both, deliberately. The title line's `{doneCount}/{total} · {mins}` is a *live* "how's this run going" counter (hidden once complete, same as before); the box header's `{count} tasks · {mins}` is a *static* "how big is this list" fact that travels alongside the timing/owner info regardless of progress. They answer different questions and can say the same numbers without being the same information — no change to the title line's existing behavior.
- **No-session fallback for a completed list**: same resolution `task-list-status-box.md` already made — both strips stay blank (no reconstructed guess from `TaskLog.updatedAt`) when a list completes without ever routing through a `TaskListSession`. The box border still turns `done`-tinted, so completion is still visible.
- **Missed-only completion**: no visual distinction from a fully-done close-out — unchanged from the prior resolution.
- **Restarted sessions same day**: confirmed — `GET /api/task-list-sessions` already returns each list's most recent session (`getSessionSummariesForDate`), so the box just renders whatever it's handed, no special-case needed.

## Depends on

[`task-list-status-box.md`](task-list-status-box.md) — the box concept, `border-done` treatment, and the three resolved open questions carried forward unchanged. [`timer.md`](timer.md#-done-pill--session-start-end-time--owner-superseded) — `TaskListSession` model, `ownerName` resolution, `GET /api/task-list-sessions`. [`task-lists.md`](task-lists.md) — `TaskListCard.tsx`'s collapse/expand behavior and title-line progress stat this box sits underneath.
