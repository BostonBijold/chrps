# Task List Status Box (replaces the header pill)

**SUPERSEDED by [`task-list-row-box.md`](task-list-row-box.md)** — the box described below wrapped the *whole* `TaskListCard` (title line, strips, and the "Start Tasks" button all inside one border). The follow-up iteration narrowed it to wrap only the task row list, restoring the title line and "Start Tasks" button to their original positions outside the box. Kept here for history; the box concept, `border-done` treatment, and the resolved open questions below still apply unchanged — see the newer doc for what actually differs.

## Problem

`TaskListCard.tsx`'s previous header pill (`✓ Done · 10:15pm–10:16pm · Boston Bijold`) crammed start time, end time, and the session owner into one horizontal line. It only rendered in that expanded form once a `TaskListSession` had actually closed (`completedAt` set) — see `timer.md`'s (now-superseded) "✓ Done pill" section. Before that, or for a list with no session at all, the card just showed plain "✓ Done" text with no time detail. This redesign gives every state (not started, running, done) a single consistent container, so the card doesn't restructure itself as the list progresses.

## What's built

A bordered box wraps the whole `TaskListCard` for a shift-window list (not an anytime one — see "Scoping" below), replacing the single-line pill with a **header strip** and a **footer strip** baked into the box's own top and bottom edges — not two separate pills. The box shape (header strip present, footer strip present) never changes between collapsed and expanded state; only the content inside each strip changes as the list moves through its lifecycle. `TaskListCard.tsx`'s `headerStripText`/`footerStripText`.

### Header strip (top of box)

| State | Content |
|---|---|
| Not yet started (no `TaskListSession` for this list/date) | The list's scheduled `startTime` (e.g. "Starts 10:00pm") — no name, since no one has claimed it yet. Blank if the list has no `startTime` (a custom list left blank) or is already complete without ever having a session (see "Resolved" below). |
| Session open or closed (`TaskListSession` exists) | The session's actual `startedAt` time, plus the session owner's name — **`ownerName`, resolved from `TaskListSession.performedByUserId`**, stamped once at session creation and never reassigned (same field `timer.md` documents). This stays visible even after the session/list completes — the footer independently adds the finish time once that happens, it doesn't replace the header. |

The name shown here is deliberately **the session owner, not whoever completes any individual task** — a shift lead can hand off actual task completion to someone else on the crew, but the header keeps showing who was assigned to run the list. Individual `TaskRow` completions still show their own "Done by `<name>`"/"Missed by `<name>`" per-row attribution exactly as they do today — this box only concerns the list-level header/footer.

### Footer strip (bottom of box)

| State | Content |
|---|---|
| Not yet complete | Blank — no placeholder text, just an empty strip (fixed `min-h`) so the box shape doesn't jump when it fills in. |
| Complete (`TaskListSession.completedAt` set) | Just the finish timestamp, e.g. "10:16pm" — **no name attached**. Finishing is often incidental (whoever happens to complete the last task closes out the list), unlike the header's deliberate "who was assigned to lead" identity, so no attribution is shown here. |

### Collapsed vs. expanded

The header/footer strips render identically whether the card is collapsed or expanded — only the task rows in between grow/shrink. This keeps the box's overall shape from changing meaning between the two states; the same information is visible either way.

### Scoping: shift-window lists only

Anytime lists (`taskList.timeOfDay === "anytime"`) keep their pre-existing, simpler header (bare title + a small "✓ Done" pill when complete, no border box) — they never get a `TaskListSession` at all (the "Start Tasks" guided walkthrough that creates one is shift-window-only, see `task-lists.md`'s "Per-task claiming"), so the box's whole premise (session-driven start/end/owner) has nothing to show for them. Not addressed by the original spec; resolved this way since applying an empty box to a list that can never fill it in would be pure chrome with no payoff.

### Resolved open questions

The original spec left these undecided; resolved as follows when this shipped:

- **No-session fallback for a completed list** (a list finished without ever routing through a `TaskListSession`, e.g. its last task was completed via a row's own Start button rather than "Start Tasks"): both strips stay **blank** — same "no time detail" fallback the old plain-text "✓ Done" pill had, rather than reconstructing a timestamp from `TaskLog.updatedAt`. The box border still turns the "done" color (see below) so completion is still visible, just without a time/name claim we can't actually back with session data.
- **Missed-only completion**: no visual distinction from a fully-done close-out — the footer just shows the timestamp either way. Out of scope here (visual styling generally is, see below).
- **Restarted sessions same day**: follows the same "most recent session wins" rule `GET /api/task-list-sessions` already applies (`getSessionSummariesForDate` picks the latest `startedAt` per list) — confirmed, no special-case needed since the box just renders whatever `session` prop it's handed.
- **Visual styling** (colors/icons beyond what's needed to satisfy the design system): the box uses the existing `border`/`border-done` tokens (CLAUDE.md's design system) — a neutral border while running, `done`-tinted once complete — and drops the inner collapsed-summary rows' own `bg-card`/rounded-corner chrome (now redundant with the outer box) in favor of a shared `border-t` divider between the header strip, the task rows, and the footer strip.

## Depends on

[`timer.md`](timer.md#-done-pill--session-start-end-time--owner) — `TaskListSession` model, `ownerName` resolution, `GET /api/task-list-sessions`. [`task-lists.md`](task-lists.md) — `TaskListCard.tsx`'s collapse/expand behavior this box sits within, and the "Per-task claiming" section explaining why anytime lists never get a session.
