> **Keep this file updated after any code change in this area — do not let it drift from actual implementation.**

# Task Lists API

Covers task lists, tasks, and task logs — the three collections behind [task-lists.md](../features/task-lists.md), [anytime-tasks.md](../features/anytime-tasks.md), and [timer.md](../features/timer.md). There used to be a separate API-key-authenticated variant of starting a timer for external triggers (Shortcuts, NFC silent triggers), and later an NFC Universal Link tap-to-trigger flow that called `lib/task-log-actions.ts` directly as a library function — both removed entirely, see `docs/project-structure.md`'s note on the external API's removal and `nfc.md`'s "History: Tap-to-trigger (removed)". The in-app session-authenticated routes below are the only way to write a `TaskLog` now.

**Auth**: every handler resolves the signed-in user via `lib/session.ts`'s `resolveSessionUser()` — the NextAuth session, falling back to a hardcoded dev user/company *only* when `process.env.SKIP_AUTH === "true"` (never set in production), `401` otherwise. `companyId`/`role` are read fresh from the `User` document on every call (not cached on the JWT), and `companyId: null` (not yet attached to a company) is treated as `403`, never as a shared tenant. All three collections below scope every query by `companyId` — see CLAUDE.md's Multi-Tenancy section.

## Task Lists

Collection: `tasklists`. Schema (`models/TaskList.ts`): `companyId`, `name`, `timeOfDay: "morning" | "evening" | "custom" | "anytime"`, `startTime: string | null` (`HH:MM`), `order`, `isDefault`, `isActive` (default `true`), `scheduledDays: number[]` (0=Sun..6=Sat, default every day — a default pushed down onto every task in the list, see below).

### `GET /api/task-lists`
Returns every active (`isActive: true`) list for the company (`sort: { startTime: 1, order: 1 }` — `startTime` first, `order` only as a same-`startTime` tie-breaker, per CLAUDE.md's Task List ordering), each with its active tasks nested inline.

Response: array of
```ts
{ _id, name, timeOfDay, order, tasks: [{ _id, name, icon, projectedMinutes, order }] }
```

### `POST /api/task-lists`
**Manager-only** (`403` for an employee). Request body: `{ name, startTime?: string | null, scheduledDays?: number[] }` — `400` if `name` is missing. Creates a new list at the end of the company's list order; `timeOfDay` is set to `"custom"` if `startTime` is given, `"anytime"` otherwise. Its tasks are added afterward through `POST /api/tasks` — see [anytime-tasks.md](../features/anytime-tasks.md), the same browse-catalog-or-build-custom flow used everywhere else. Response: `{ _id, name, timeOfDay, startTime, order, scheduledDays }`.

### `PATCH /api/task-lists/[taskListId]`
**Manager-only** (`403` for an employee). Request body: `{ name?: string; startTime?: string | null; scheduledDays?: number[] }`. Updates `TaskList.findOneAndUpdate({ _id: taskListId, companyId }, { $set: { name, startTime, scheduledDays } })`. `404` if not found.

If `scheduledDays` is present, it also pushes that value down onto **every** `Task` currently in the list (`Task.updateMany({ taskListId, companyId }, [{ $set: { scheduledDays, successThreshold: { $min: ["$successThreshold", clampedThreshold] } } }])`) — a manager turning Sunday off for the whole list shouldn't require editing each task by hand. This always overwrites, even a task that had been individually customized independently before this call — simplest option to build (documented as a deliberate choice, not a bug): a task can still be reopened and re-customized afterward on top of the new default, it just doesn't survive the *next* list-level schedule change.

Response: `{ _id, name, startTime, scheduledDays }`.

### `DELETE /api/task-lists/[taskListId]`
**Manager-only** (`403` for an employee). **Soft delete** — sets `TaskList.isActive: false` and saves; the document (and its full `TaskLog`/`TaskListSession` history) is never physically removed, it just drops out of `GET /api/task-lists`'s active set. Response: `{ ok: true }`.

> `GET /api/task-lists/session-locks` and `POST /api/task-lists/[taskListId]/unlock-session` were **removed** — the list-level "one person at a time" session lock they backed was replaced by per-task claiming, computed directly off each task's own `TaskLog` (`performedByUserId`/`startedAt`) instead of a separate list-level lock. See "Per-task claiming" in [task-lists.md](../features/task-lists.md).

### `GET /api/task-lists/start-next`
Query param `date` (defaults to today, `YYYY-MM-DD`). Read-only: loads all non-anytime lists (`timeOfDay !== "anytime"`, sorted by `order`), their active tasks (filtered through `isTaskVisibleOn`, so a task hidden today by its own `scheduledDays` is never offered), and that date's logs; **any** log for a task — regardless of state, including `in_progress` and `paused` — counts as "already logged" (skipped, not re-offered). Walks lists in order and returns the first task in the first list that has no log yet for that date.

Response: `{ hasNext: boolean, hasLogs: boolean }`.

> ⚠️ **Known issue**: nothing in the current app calls this route — it's dead code, carried over from before the rename. The FAB (`components/BottomNav.tsx`) today is purely an active-timer resume indicator; "Start Tasks"/"Continue Tasks" is a per-list button on `TaskListCard.tsx` that doesn't call this endpoint. Left in place rather than removed since deleting it isn't part of any active work.

## Tasks & Task Definitions

`Task` is a list **placement**, not a self-contained document — see [`features/task-lists.md`](../features/task-lists.md)'s "Company Task Catalog" section for the full design. A task's actual content (name, icon, type, form fields, NFC binding) lives one layer up on `TaskDefinition`, the company's reusable saved-check catalog ("Company Task Catalog"); the same `TaskDefinition` can have more than one placement (the same fridge-temp check placed in both the opening and closing lists), each with its own independent `TaskLog` history. Every response shape below is still the same **flat, resolved** object client code has always consumed (`name`/`icon`/`taskType`/`formFields`/`nfcTagUid` alongside the placement's own fields) — `lib/task-definitions.ts`'s `resolveTasks`/`resolveTask` do this join server-side on every read, so nothing downstream of an API response changed shape, only where these fields are actually stored.

Collection: `tasks`. Schema (`models/Task.ts`): `taskListId` (ref), `companyId`, `definitionId` (ref `TaskDefinition`, required), `projectedMinutes: number | null` (this placement's *override* of the definition's default; `null` = inherit it), `order`, `isActive` (default `true`), `scheduledDays: number[]` (0=Sun..6=Sat, default `[0,1,2,3,4,5,6]` — also the field a list-level schedule change overwrites, see above), `successThreshold: number` (how many of this week's *scheduled* days count as a win, default `7`).

Collection: `taskdefinitions`. Schema (`models/TaskDefinition.ts`): `companyId`, `templateId: ObjectId | null` (ref `TaskTemplate` — which template this was cloned from, informational only), `name`, `icon` (default `"✓"`), `taskType: "standard" | "stopwatch" | "checkbox" | "form"` (default `"form"` — `standard`/`stopwatch`/`checkbox` are kept for schema compatibility with pre-pivot data, but nothing in the UI creates them anymore), `formFields: FormFieldDef[]` (only meaningful when `taskType === "form"`; each entry is `{ key, label, type: "number" | "text" | "boolean", unit?, min?, max? }` — default `[]`), `projectedMinutes` (default budget, default `0`), `nfcTagUid: string | null` (see [nfc.md](../features/nfc.md)'s "In-app scan-to-complete binding" — bound here, one layer above any single placement, so every list a task is placed in shares the same tag), `instructionSteps: InstructionStep[]` (up to 3 manager-authored `{ description, imageUrl }` reference-photo/caption steps, see [`features/task-completion-instructions.md`](../features/task-completion-instructions.md) — default `[]`), `isActive` (default `true` — archived once a manager deletes it from the catalog; blocked while any active placement still references it, see below).

`scheduledDays` gates whether a task actually appears on the Tasks page for a given date (`lib/task-visibility.ts`'s `isTaskVisibleOn`) as well as feeding the weekly Reports/streak math (see [`features/task-lists.md`](../features/task-lists.md#day-of-week-visibility) and [`features/reports.md`](../features/reports.md)) — a task not scheduled for today's day-of-week is hidden entirely, not merely dimmed. Every streak/Reports computation keys off the **placement's** `_id` (unchanged from before the catalog split) — the same definition placed in two lists gets two independent streak strips, since they're different obligations at different times even though they're "the same physical check."

**Backward compatibility**: `scheduledDays`/`successThreshold` were added after many tasks already existed. Mongoose schema defaults only apply on document creation, so a `.lean()` read of a pre-existing task can come back with them `undefined` — every server read site that builds a task for the client falls back explicitly (`scheduledDays ?? [0,1,2,3,4,5,6]`, `successThreshold ?? (scheduledDays?.length ?? 7)`) rather than trusting the field is present.

### `GET /api/task-definitions`
The company's full saved-task catalog ("Company Task Catalog"), regardless of which lists currently use them. Each entry includes `placements: Array<{ taskId, taskListId, taskListName }>` — which lists (if any) currently place it, driving both the manager UI's "used in Opening, Closing" line and the delete-block below. Response: `Array<{ _id, name, icon, taskType, formFields, projectedMinutes, nfcTagUid, instructionSteps, placements }>` — each `instructionSteps` entry is `{ _id, description, imageUrl }`.

### `POST /api/task-definitions`
**Manager-only** (`403` for an employee). Adds a saved task straight to the company's catalog with **no list placement at all** — the Admin Console's Task Catalog pane's "+ New catalog task" (`components/console/TaskCatalogPane.tsx`, see [`features/console-task-management.md`](../features/console-task-management.md)). Every other creation path (`AddTaskSheet`'s "Create custom task", `POST /api/tasks` with no `definitionId`) always creates a placement in the same request; this is the one way to get a catalog-only entry a manager can place into a list later, on their own schedule. Request body: `{ name, icon, projectedMinutes?, formFields? }` — `400` if `name`/`icon` missing. `taskType` is always `"form"` (the only creatable type). `formFields` gets the same shape validation as `POST /api/tasks`. Response: same flat shape as one entry of `GET /api/task-definitions` above, with `placements: []`.

### `PATCH /api/task-definitions/[id]`
**Manager-only** (`403` for an employee). Edits a catalog entry directly by its own `definitionId`, unlike `PATCH /api/tasks/[id]` below which requires an existing placement to key off of — the only way to edit a definition with zero active placements ("not placed in any list"). Every list the definition IS placed in also picks up the change, since these fields live on the shared `TaskDefinition`, not any one placement. Request body: any subset of `{ name, icon, projectedMinutes, formFields, instructionSteps }` — `taskType` is not editable (matches `PATCH /api/tasks/[id]`'s own rule). `instructionSteps` is sanitized shape-first and clamped to 3 entries (`lib/instruction-steps.ts`, see [`features/task-completion-instructions.md`](../features/task-completion-instructions.md)). `404` if the definition doesn't exist, belongs to another company, or is already soft-deleted. Response: `{ _id, name, icon, taskType, formFields, projectedMinutes, nfcTagUid, instructionSteps }`.

### `POST /api/blob/upload`
**Manager-or-above only** (`403` otherwise). `@vercel/blob/client`'s `handleUpload` token endpoint — the manager's browser calls this (via `upload()`, not `fetch`) to get a short-lived client-upload token, then pushes the image bytes straight to Vercel Blob. Constrains uploads to `image/jpeg`/`image/png`/`image/webp`, 5MB max. Not scoped to instruction steps specifically — any future feature needing a client-side image upload can reuse this same token route. See [`features/task-completion-instructions.md`](../features/task-completion-instructions.md).

### `DELETE /api/task-definitions/[id]`
**Manager-only** (`403` for an employee). Removes a saved task from the catalog entirely (soft delete, `isActive: false`) — **blocked (`409`) while any active `Task` placement still references it**, with a message naming how many lists it's still used in. A manager has to remove it from every list first; this is a deliberate choice (documented in `features/task-lists.md`) over cascading the delete or leaving orphaned placements — simplest to build, no surprise state. Removing a single placement (not the whole definition) is `DELETE /api/tasks/[id]` below, unaffected by this route.

### `POST /api/tasks`
Adds a task to any list (shift-window or anytime — there is no separate anytime-task endpoint), one of two ways:

- **`definitionId` supplied** — places an *existing* company `TaskDefinition` into this list. New capability (the "Manage Tasks & Task Lists" catalog's "add existing task" flow — the "Your Saved Tasks" section inside `components/AddTaskSheet.tsx`'s browse view, wired through its `onAddExisting` prop, not a separate component) — no new definition is created, so every list this ends up in shares the same name/icon/fields/NFC binding. `404` if the definition doesn't exist or belongs to another company.
- **`name`/`icon`/… supplied instead** (the original `AddTaskSheet` flow — browsing the template catalog or building a custom task) — creates a brand-new `TaskDefinition` first, then a placement for it. Request body: `{ taskListId, templateId?, name, icon, projectedMinutes?, taskType?, scheduledDays?, successThreshold?, formFields? }` — `400` if `taskListId` is missing, or neither `definitionId` nor `name`+`icon` are given.

Behavior (either path): appends at the end of the list (`order` = current max + 1). A newly-created definition forces `projectedMinutes: 0` when `taskType === "checkbox"`, regardless of what was sent; otherwise uses the provided value or defaults to `15` — this becomes the definition's *default*, not a placement override (the new placement's own `projectedMinutes` is always `null` — inherit — at creation). `scheduledDays` defaults to every day when omitted or empty; `successThreshold` defaults to `scheduledDays.length` and is **clamped** (not rejected) to never exceed it. `formFields`, if creating a new definition, is validated shape-first — each entry must have a `key`/`label` string and a `type` of `"number" | "text" | "boolean"`; malformed entries are dropped rather than stored as-is.

Response: `{ _id, definitionId, name, icon, projectedMinutes, order, taskType, scheduledDays, successThreshold, formFields, nfcTagUid }`.

### `PATCH /api/tasks/[id]`
Request body: any subset of `{ name, icon, taskType, formFields, projectedMinutes, scheduledDays, successThreshold }`. Fields are routed to whichever layer they actually belong to: `name`/`icon`/`taskType`/`formFields` write through to the `TaskDefinition` and so **cascade to every list this task is placed in** ("the same physical check"); `projectedMinutes`/`scheduledDays`/`successThreshold` stay on this one placement. `projectedMinutes` in particular becomes *this placement's override* of the definition's default, not the default itself — it's always edited from one specific list's row. `404` if the placement doesn't exist. `formFields` gets the same shape validation as `POST` above.

If either `scheduledDays` or `successThreshold` is present, the threshold is re-clamped against whichever `scheduledDays` is now in effect (the one just sent, or the placement's existing one if only the threshold changed) — same silent-clamp behavior as `POST`. Clamping only ever lowers the threshold to fit a shrunk schedule; it never bumps a deliberately-lowered threshold back up just because `scheduledDays` changed for an unrelated reason (e.g. a day was re-added).

Response: `{ _id, name, icon, projectedMinutes, taskType, scheduledDays, successThreshold, formFields }`.

### `DELETE /api/tasks/[id]`
**Placement-only soft delete** — sets the `Task`'s `isActive: false` and saves; its `TaskLog` history is never physically removed. The underlying `TaskDefinition` (and any other list's placement of it) is untouched — it just drops back into the "Company Task Catalog" with one fewer placement, ready to be placed again. Response: `{ ok: true }`.

### `PATCH /api/tasks/reorder`
Request body: `{ tasks: Array<{ _id: string; order: number }> }` — `400` if missing/empty. Runs one `updateOne({ _id, companyId }, { $set: { order } })` per entry (scoped to the authenticated company, so ids belonging to another company are silently no-ops). Response: `{ ok: true }`.

### `POST` / `DELETE /api/tasks/[id]/nfc-tag`
Manager-only (`403` for an employee). Still addressed by `[id]` (a specific placement, matching a single row in `TaskListEditView`), but resolves to that placement's `definitionId` and writes `TaskDefinition.nfcTagUid` — binding cascades to every list the task is placed in, not just the one the manager clicked from. See [nfc.md](../features/nfc.md).

### `POST` / `DELETE /api/task-definitions/[id]/nfc-tag`
Manager-only (`403` for an employee). Definition-addressed equivalent of the route above, used by the Manage Tasks screen's company task catalog (`components/ManageTasksView.tsx`, which lists every saved `TaskDefinition` regardless of whether it's placed in any list yet) rather than a specific list row. Both routes share `lib/task-definitions.ts`'s `bindNfcTag`/`unbindNfcTag`, so the one-tag-one-task uniqueness enforcement lives in exactly one place. `POST` body: `{ uid: string }` — `400` if missing. Response: `POST` → `{ nfcTagUid }`; `DELETE` → `{ ok: true }`. `404` if the definition doesn't exist or belongs to another company.

### `GET /api/tasks/by-nfc-uid?uid=<uid>&date=<local date>&nowMinutes=<local minutes since midnight>`
Resolves a scanned tag's UID to a `TaskDefinition`, then — since one binding can now back more than one placement — to whichever placement is "most relevant right now" via `lib/task-definitions.ts`'s `resolveMostRelevantPlacement` (documented as a judgment call, not a settled spec): skip anything already resolved today, prefer whichever list's `startTime` is closest to `nowMinutes`, fall back to list/placement order. `date`/`nowMinutes` are optional (the client's local values — see `components/BottomNav.tsx`) and degrade to a simpler fallback without them.

Once a single `taskId` is resolved, `lib/task-list-session-actions.ts`'s `resolveFabScanTarget` decides what the FAB should do with it — a tag is permanently tied to that one task, so the first check is always whether it already has a `TaskLog` today, before anything about list type or session state. The response is one of four shapes — see [nfc.md](../features/nfc.md)'s "FAB 'scan to open' shortcut":
- `{ mode: "already-logged", taskId, state }` — the task already has a log today (any state); the client shows a status message and navigates nowhere. Rescanning is never a way to reopen or continue a task.
- `{ mode: "anytime", taskId }` — an untouched anytime task, unchanged from before this resolver existed.
- `{ mode: "session", taskId, taskListId }` — an untouched shift-window task whose list's session is either unclaimed or already the caller's own; the client anchors just this one task to that list's session (starting/joining it) and opens it standalone — not the guided walkthrough.
- `{ mode: "locked", taskId, taskListId, lockedByName }` — an untouched shift-window task whose list's session is held by someone else; the client shows this instead of navigating anywhere.

## Task Logs

Collection: `tasklogs`. Schema (`models/TaskLog.ts`): `companyId`, `performedByUserId` (the specific person who did it — an attribute, not part of the uniqueness key below), `taskId` (ref), `date` (`YYYY-MM-DD`), `actualMinutes?`, `startedAt?: Date` (null while `paused`), `completedAt?: Date`, `pausedSeconds` (default `0`), `state: "in_progress" | "paused" | "done" | "missed" | "rest"` (`"rest"` is a legacy value only — retired, see CLAUDE.md's "Skip Types"; `POST /api/task-logs` rejects it on write, kept in the type only so a pre-existing document that already has it stays readable), `note?`, `isBackEntry` (default `false`), `sessionTaskListId?: ObjectId | null` (ref `TaskList`, see below), `formData?: Record<string, string | number | boolean> | null` (see below), `tagId?: string | null`, plus timestamps. A **unique** compound index on `{ companyId, taskId, date }` means there is always exactly one log per task per day for the whole company — not per person, since any employee on shift might complete a given task — every write below is an upsert against that key, never a duplicate insert.

`formData` is set only on the terminal log for a `form` task (see `components/TaskFormScreen.tsx`) — the captured values, keyed by each field's `key` from the task's `formFields`. Every other task type leaves it `null`.

`pausedSeconds` banks elapsed time accumulated in an earlier running segment of the same log — total elapsed while `in_progress` is `pausedSeconds + (now - startedAt)`. It's only meaningful while `in_progress` or `paused`; every write below that transitions a log to a terminal state (`done`/`missed`) resets it to `0` after folding it into `actualMinutes`.

`sessionTaskListId` is set while `state === "in_progress"` **or** `"paused"`, via a Task List Session's own in-session navigation (see below) — it anchors the timer inside a Task List Session for that list, so opening the app resumes into the session view at that task instead of the standalone timer. It's cleared (`null`) the moment the log reaches a terminal state, by either PATCH branch below. See [timer.md](../features/timer.md) for the client-side resume logic that reads it.

### `GET /api/task-logs?date=YYYY-MM-DD`
Returns all logs for the company on that date (defaults to today, computed **server-side in UTC** via `toISOString()` — not the client's local date) — company-wide, so any employee's completion of a shared task shows up for everyone. Each log also carries a resolved `performedByName` (`null` only when there's no `performedByUserId` at all) — the performing/claiming user's display name, for `TaskRow.tsx`'s per-task claim pill AND a done/missed row's "by `<name>`" attribution, visible to every role — see "Attribution" in [task-lists.md](../features/task-lists.md). Resolved server-side via a small `User` lookup keyed off `performedByUserId`, not stored on `TaskLog` itself.

### `POST /api/task-logs`
Request body: `{ taskId, date, state, actualMinutes?, isBackEntry?, sessionTaskListId?, sessionNav? }`.

- **`state: "in_progress"`** — branches on `sessionNav` in `lib/task-log-actions.ts`:
  - `sessionNav` **not set** (the default — standalone timer, and this route's only mode when called from outside a Task List Session) — delegates to `startInProgressLog(companyId, performedByUserId, taskId, date, sessionTaskListId)`. This enforces a **single-active-timer invariant** before writing anything: it queries for any other `TaskLog` for this specific person (`performedByUserId`) with `state: "in_progress"` and a different `taskId` (any date), and for each one found, **auto-completes** it (`state: "done"`, `completedAt: now`, `actualMinutes` derived from its `startedAt` plus any `pausedSeconds` it had banked, minimum 1, `pausedSeconds` reset to `0`, `sessionTaskListId` cleared) before proceeding. This is enforced server-side unconditionally, per person, not per company — different staff can each have their own timer running at once.
  - `sessionNav: true` (set only by `TaskListSessionView.tsx`'s in-session navigation — advancing or tapping a row to jump) — delegates to `switchActiveLog` instead. Same single-active-timer invariant, but the task being left is **paused**, not completed: `state: "paused"`, `startedAt: null`, `pausedSeconds` incremented by however long it had been running. Nothing on this path ever sets a terminal state — only an explicit Done/Missed (either POST branch below, or the external API) does that.
  - Either way, the target log is then set to `state: "in_progress"` with a fresh `startedAt: new Date()` (server time — any client-sent start time is ignored) and `completedAt: null, actualMinutes: null, isBackEntry: false, sessionTaskListId, performedByUserId`. If the target log was previously `paused`, its `pausedSeconds` carries forward unchanged (so total elapsed keeps counting up across jumps instead of resetting); a genuinely fresh start has `pausedSeconds: 0`. If the target is already the active `in_progress` log, it's returned untouched.
- **Any other state** — sets `state`, `actualMinutes: actualMinutes ?? null` (trusts the client-sent value directly — no server derivation on this path), `isBackEntry: isBackEntry ?? false`, `sessionTaskListId: null`, `pausedSeconds: 0`, `performedByUserId`.

Response: the upserted log, serialized. Note the response only reflects the log that was requested — any other log resolved as a side effect (auto-completed or paused) is not included, so callers that need the UI to reflect that resolution (e.g. `TasksView.handleStartTimer`, `TaskListSessionView`'s per-task effect) re-fetch the full day's logs afterward rather than relying on this response alone.

### `PATCH /api/task-logs`
Request body: `{ taskId, date, state: "done" | "missed", actualMinutes?, startedAt?, completedAt?, formData? }`.

Every branch also sets `sessionTaskListId: null` and `pausedSeconds: 0` — once a log reaches a terminal state it's no longer session-anchored or resumable, regardless of which branch below handled it.

- If the client supplies **both** `startedAt` and `completedAt` (the manual time-entry path in `TaskRow`/`TaskCard`) — those are trusted directly, `actualMinutes` is computed from their difference, and `formData` (if the task being back-logged is a `form` task) is stored alongside.
- Else if `state === "done"` (the normal timer-completion path) — `completedAt` is set to now, and `actualMinutes` is derived from **the existing log's server-recorded `startedAt`, plus any `pausedSeconds` it had banked** — not the client-sent value. The client's `actualMinutes` is only used as a fallback if the existing log has no `startedAt` and no banked `pausedSeconds` at all. `formData` is stored as sent — no validation against the task's `formFields` shape.
- `state === "missed"` with no time overrides — only `state` (and `sessionTaskListId`/`pausedSeconds`) is updated.
- Also an upsert (`upsert: true`) — a PATCH against a log that doesn't exist yet will create one.

### `DELETE /api/task-logs`
Request body: `{ taskId, date }`. Deletes the matching log (this is how "Undo" works in the UI). Response: `{ ok: true }`.

### `GET /api/task-logs/active`
Returns the signed-in person's single active (`in_progress`) timer, if any — used by the FAB (`components/BottomNav.tsx`) to render its resume pill and live clock without the client polling or holding the full day's logs. Queries `TaskLog.findOne({ companyId, performedByUserId, state: "in_progress" })` sorted by `startedAt` descending (defensive only — the single-active-timer invariant means at most one should ever exist per person). Responds `{ active: false }` if there's no `startedAt`, or if the `Task` it points at can't be found — a dangling log, e.g. after the task was hard-deleted from the database; a merely soft-deleted (`isActive: false`) task still resolves fine, since this lookup doesn't filter on `isActive`.

Response when active — a denormalized shape (task name/icon/type/target inlined) built for direct rendering, unlike the `serializeLog` shape used everywhere else on this page:
```ts
{ active: true, taskId, date, startedAt: <ISO>, pausedSeconds, taskName, taskIcon, taskType, projectedMinutes }
```

## Task List Sessions

Collection: `tasklistsessions`. Schema (`models/TaskListSession.ts`): `companyId`, `performedByUserId` (whoever started this particular run — an attribute, not part of the lookup key below), `taskListId` (ref `TaskList`), `date` (`YYYY-MM-DD`), `startedAt: Date`, `completedAt: Date | null`, `status: "in_progress" | "completed"`, `totalActualMinutes` (default `0`), `completionSequence: [{ taskId, completedAt, state: "done" | "missed" | "rest" }]` (`"rest"` legacy only, same retirement as `TaskLog.state` above — no code path writes a new one), `pauseOrJumpCount` (default `0`), plus timestamps. No unique index on `{ companyId, taskListId, date }` — a list can legitimately be started, finished, and started again the same day (redoing it), and each run gets its own record rather than colliding with the last one; a non-unique index on `{ companyId, taskListId, date, status }` just makes the "find the open session" lookup below cheap. The lookup is **company-wide**, not per-person — any employee can pick up an already-open session, same reasoning as `TaskLog` above.

This is a session-scoped wrapper around a task list *as a whole* — real start/finish timestamps, completion order, and a pause/jump count — sitting one level above `TaskLog`, which stays the source of truth for individual task state and timing. **There is no write route for it** — it's created and closed entirely as a side effect of the existing task-completion code paths above, via `lib/task-list-session-actions.ts` (a read route now exists, see below):

- **`ensureOpenSession(companyId, performedByUserId, taskListId, date)`** — finds the open (`status: "in_progress"`) session for that company/list/date, or creates one (`startedAt: now`, empty `completionSequence`, `totalActualMinutes: 0`, `pauseOrJumpCount: 0`, `performedByUserId` stamped only on creation — a later employee joining the same open session doesn't reassign it). Called by `startInProgressLog` and `switchActiveLog` (`lib/task-log-actions.ts`) whenever either is about to set a task to `in_progress` with a non-null `sessionTaskListId` — i.e. the moment the first task in a list actually starts running for that date. A bare standalone-timer start (`sessionTaskListId: null`) never creates or touches a session.
- **`recordSessionCompletion(companyId, taskListId, date, taskId, state, actualMinutes)`** — appends `{ taskId, completedAt: now, state }` to `completionSequence`; adds `actualMinutes` to `totalActualMinutes` only for `state === "done"` (`missed` contributes `0`, the same terminal-but-zero treatment [`timer.md`](../features/timer.md)'s live-projection math uses — callers only ever pass `"done"`/`"missed"` now, see `POST /api/task-logs`). Then checks whether every active `Task` in the list now has a terminal log for that date (`isTaskListFullyResolved`) and, if so, sets `completedAt: now, status: "completed"`. No-ops silently if no open session exists for that list/date (a task completing outside any session — tapped directly on the main Tasks list, never anchored via `sessionTaskListId` — has nothing to record against). Called from every terminal-write path that can be session-anchored: `completeInProgressLog` and `startImmediateLog` (`lib/task-log-actions.ts`, reading the log's `sessionTaskListId` before it's cleared), and both `POST` and `PATCH /api/task-logs`'s terminal branches above (same read-before-clear).
- **`incrementSessionPauseOrJump(companyId, taskListId, date)`** — `$inc`s `pauseOrJumpCount` on the open session. Called by `switchActiveLog` only when it actually paused another task (the very first task of a session has nothing to switch away from, so that opening move doesn't count) — attention moved to a different task without the one that was running getting marked done. (This used to also be called from the now-removed tap-to-trigger flow's own jump case — see `docs/features/nfc.md`'s "History: Tap-to-trigger (removed)".)

(`findNextTaskInList` — the tap-to-trigger flow's "advance to next task" helper — was removed along with `lib/task-trigger.ts` once that was its only caller; `isTaskListFullyResolved` above still shares the same underlying list/date/logs fetch with the code that used to back it.)

**`GET /api/task-list-sessions?date=YYYY-MM-DD`** (`app/api/task-list-sessions/route.ts`) is the one read path so far — it calls `getSessionSummariesForDate(companyId, locationId, date)` and returns, per `taskListId`, that list's **most recent** session for the date (highest `startedAt`, since a list can be started/finished/restarted more than once the same day — see the no-unique-index note above):

```
[{ taskListId, startedAt: <ISO>, completedAt: <ISO> | null, status, ownerName }]
```

`ownerName` is the session's `performedByUserId` resolved to a display name (`"someone else"` fallback for a non-`ObjectId` id, e.g. `SKIP_AUTH`'s dev sentinel — same guard `GET /api/task-logs` uses for `performedByName`). This powers `TaskListCard.tsx`'s task list status box (start/end time + session owner — see [`features/task-list-status-box.md`](../features/task-list-status-box.md)); `completionSequence`/`pauseOrJumpCount`/real start-to-finish duration are still not surfaced anywhere — future work for analytics (e.g. "you keep starting fifteen minutes late").

## Consumed by

[`features/task-lists.md`](../features/task-lists.md), [`features/anytime-tasks.md`](../features/anytime-tasks.md), [`features/timer.md`](../features/timer.md), [`features/reports.md`](../features/reports.md) (`TaskLog` states and the `Task` schedule/threshold fields it aggregates over).
