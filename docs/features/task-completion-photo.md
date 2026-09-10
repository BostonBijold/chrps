> **Keep this file updated after any code change in this area — do not let it drift from actual implementation.**

# Task Completion — Required Photo

**Status: BUILT.** The employee-side capture that pairs with the manager's reference photos in [`task-completion-instructions.md`](task-completion-instructions.md): when a task's `requiresPhoto` is on, the employee must attach a photo of the finished result (the cleaned bathroom, the set-up line) before they can actually mark it done. Reuses the same `capturePhoto()` helper and Blob-upload plumbing built for instruction-step images in [`instruction-steps-camera-capture.md`](instruction-steps-camera-capture.md) — this feature is mostly about wiring that existing capture into the completion flow, not a new capture path.

**The photo attaches first; the employee still taps the normal Done/Save control separately afterward** — capturing isn't itself completion, it's a precondition for the button becoming tappable at all.

**`requiresPhoto` is location-owned, not company-wide** — it lives on `TaskDefinition`, which now belongs to exactly one `Location` (see CLAUDE.md's "Locations" section). Browsing another location's saved tasks as example data (`GET /api/task-definitions?scope=company`) always comes back with `requiresPhoto: false`, and cloning one (`POST /api/tasks`'s `cloneFromDefinitionId`) never carries the toggle over — each location decides this policy independently. The *captured photo itself* (`TaskLog.photoUrl`, below) was already per-location by virtue of `TaskLog`'s own `{companyId, locationId, taskId, date}` key, well before this change.

## Data model

`TaskDefinition` (`models/TaskDefinition.ts`) gains one field, same layer as `instructionSteps`/`formFields` — applies to every `taskType`, not just `form` (it can't live inside `formFields`, since a plain checkbox-style task has none):

```ts
requiresPhoto: boolean  // default false
```

`TaskLog` (`models/TaskLog.ts`) gains one field, parallel to `formData`:

```ts
photoUrl?: string | null  // default null; the Blob URL of the completion photo, set only on a "done" write that included one
```

## API changes

**`PATCH /api/task-definitions/[id]`** and **`PATCH /api/tasks/[id]`** (the latter via its `DEFINITION_FIELDS` list) both grow `requiresPhoto` as an editable field, alongside `name`/`icon`/`taskType`/`formFields`. Both write through to `TaskDefinition`, so the change **cascades to every list this task is placed in** — same "the same physical check" reasoning already governing every other field at this layer. `GET`/`POST /api/task-definitions` and `PATCH /api/task-definitions/[id]`'s responses, plus the resolved task shape (`lib/task-definitions.ts`'s `resolveTasks`/`resolveTask`, via `ResolvedTaskFields.requiresPhoto`), all carry it.

**`POST /api/task-logs` and `PATCH /api/task-logs`** both grow an optional `photoUrl` in the request body, stored on the `TaskLog` whenever the resulting write sets `state: "done"` (never touched for `"missed"` — a missed task was never done, nothing to photograph).

**Server-side enforcement, not just a disabled button**: `lib/task-log-actions.ts`'s `assertPhotoProvided(taskId, photoUrl)` mirrors `assertNfcVerified` exactly — it resolves the task's `TaskDefinition.requiresPhoto` and throws `PhotoRequiredError` (→ `400`, "This task requires a photo before it can be completed") for any `state: "done"` write with no `photoUrl`. It's called from every code path that can reach a `done` write, same set `assertNfcVerified` already covers:

- `POST /api/task-logs`'s quick-complete/back-entry `"done"` branch
- `PATCH /api/task-logs`'s manual/back-entry `"done"` branch (only for a log *newly becoming* done — an already-done log's pure time-edit is exempt, same as the NFC check)
- `completeInProgressLog` (the timer/form completion path both routes above route into)
- `startImmediateLog` (the immediate-done path for a non-timer task type)

(This section used to also call out that a `requiresPhoto` task could never be completed via a tap-to-trigger Universal Link tap, since that path had no capture UI — moot now that tap-to-trigger has been removed entirely, see `docs/features/nfc.md`'s "History: Tap-to-trigger (removed)".)

`formData` today is stored as sent with *no validation* against the task's `formFields` shape — `photoUrl` is the deliberate exception to that convention, precisely because the point of this feature is a manager being able to trust the photo actually exists.

**`POST /api/blob/upload`** — its `onBeforeGenerateToken` gate loosened from manager-or-above to **any authenticated employee of the company** (still requires a session + `companyId`), since completion photos are captured by whoever's actually doing the task. `allowedContentTypes`/`maximumSizeInBytes`/`validUntil` are unchanged from [`instruction-steps-camera-capture.md`](instruction-steps-camera-capture.md).

## Shared upload helper

`uploadImageDirect`/`withUploadTimeout`/`MAX_UPLOAD_IMAGE_BYTES`/`ALLOWED_UPLOAD_IMAGE_TYPES` — originally inline in `components/ManageTasksView.tsx` for instruction-step images — were extracted to **`lib/client/upload-image.ts`** so this feature's `TaskPhotoCaptureButton.tsx` could reuse the identical upload path instead of duplicating it. `ManageTasksView.tsx` now imports from there instead of defining its own copies; no behavior change to instruction-step uploads.

**Deviation from the original plan**: completion photos upload through this same `uploadImageDirect` helper, **not** `@vercel/blob/client`'s `upload()`. The latter was tried and dropped for instruction-step uploads specifically because it silently retries a `400` behind up to 10 attempts, masking real failures (see [`task-completion-instructions.md`](task-completion-instructions.md)'s "Blob upload flow") — that bug applies identically here, so reusing the already-fixed path was the correct call rather than reintroducing it for a second feature.

## Manager UI

As of [`unified-task-edit-surface.md`](unified-task-edit-surface.md), the **"Require Photo at Completion"** toggle is a shared component, `components/task-panels/RequiresPhotoTogglePanel.tsx`, backed by `lib/client/use-task-definition-panel.ts`'s `useTaskDefinitionPanel` hook (`handleToggleRequiresPhoto`, which optimistically flips local state and `PATCH`es `/api/task-definitions/[id]` with `{ requiresPhoto }`, reverting on failure — same re-save-through-`PATCH` pattern as `instructionSteps`, just a single boolean instead of an array). It renders in `ManageTaskDetailSheet.tsx` (right after the Instructions panel — both are properties of the same `TaskDefinition`), wired from `ManageTasksView.tsx`'s `CatalogRow`, and also inline in `components/TaskListEditView.tsx`'s `SortableRow` edit form, wired the same way. Standalone Tasks' detail sheet (no `instructions`/`tagBinding` either) doesn't get this toggle, same scoping as instruction-step authoring.

## Employee UI

Shared component, reused across every completion surface: **`components/TaskPhotoCaptureButton.tsx`**.

- Renders **"Add a Photo"** (a lucide `Camera` icon + label — not a raw emoji, matching `ManageTaskDetailSheet.tsx`'s existing "Take Photo" button convention and CLAUDE.md's "monochrome icon set, not colorful pictorial glyphs" design rule) when nothing's captured yet. Tapping it calls `capturePhoto()` (`lib/client/capture-image.ts`), validates the result client-side against the same type/size allow-list `POST /api/blob/upload` enforces, then uploads via `uploadImageDirect`.
- Once captured, shows a thumbnail + a **"Retake"** button — tapping it re-opens the camera and overwrites the held URL. The previous upload isn't deleted (same accepted orphaned-blob tradeoff as instruction steps).
- Purely local/controlled state (`photoUrl` prop + `onChange` callback) — nothing persists until the parent screen's own Done/Save action fires. Backing out loses the captured photo.

Wired into every place a task can actually be marked done:

- **`TimerScreen.tsx`** — rendered above the Done/Missed buttons (both countdown and stopwatch render blocks) when `item.requiresPhoto` is true. Done is `disabled` until a photo's attached; Missed is untouched. `onComplete(actualMinutes, photoUrl)` — threads up through `TasksView.tsx`'s `handleTimerComplete`, which now includes `photoUrl` in its `PATCH` body.
- **`TaskFormScreen.tsx`** — rendered as its own "Completion Photo" section, after the task's own fields and before Linked Inventory. `handleSave`'s existing all-fields-required gate grows one more check (`requiresPhoto && !photoUrl` → inline error, same as every other field). `onComplete`'s signature grew a trailing `photoUrl` param (`(formData, actualMinutes, verifiedNfcUid?, inventoryCounts?, photoUrl?)` — appended after the existing NFC/inventory params rather than the doc's original simplified `(formData, actualMinutes, photoUrl)`, to avoid disturbing existing positional call sites). Threaded through both `TasksView.tsx`'s `handleTaskFormComplete` and `TaskListSessionView.tsx`'s `saveLog`/`advance`/`handleTaskFormDone` chain (the guided shift-list session reuses this exact component for its form-task step).
- **Back-entry mode** (`TaskCard.tsx`, both the plain-minutes non-form path and the form-fields path) — same gate on the Done button (`disabled` grows a `requiresPhoto && !backPhotoUrl` clause), `photoUrl` added to `onStateChange`'s `opts` and threaded through `TasksView.tsx`'s `handleStateChange` into its `POST` body.

## Known gaps (server still enforces, no capture UI wired)

- **`TaskListSessionView.tsx`'s inline Done button** for a *non-form* task (the countdown/stopwatch/checkbox rendering inside the guided session, as opposed to its separate `TaskFormScreen` branch) has no `TaskPhotoCaptureButton` wired in. These task types are fully retired — nothing in the app can create one anymore (`taskType: "form"` is the only creatable value, see CLAUDE.md) — so this is unreachable by any current data, but a pre-existing non-form task with `requiresPhoto` toggled on would simply never be completable through this specific screen (the server still rejects the write).
- **`TaskCard.tsx`'s checkbox quick-complete button** (a non-back-entry `isCheckbox` task's plain "mark done" tap) is likewise unwired — same retired-type reasoning.

## Open questions / deferred

- **Manager review of the completion photo** — this feature only covers capture + storage; where a manager actually goes to view/compare it against the instruction photo (Reports? a task-log detail view?) is out of scope, same as flagged when originally scoped in [`task-completion-instructions.md`](task-completion-instructions.md).
- **Redoing a task same day** — `TaskLog` is unique per `{ companyId, locationId, taskId, date }`, so a same-day redo overwrites the same log, including its `photoUrl`. Whether a manager would want the *first* attempt's photo preserved too isn't addressed here.
- **Orphaned blobs from Retake** — same open item as instruction steps, not solved differently here.

## Depends on

[`instruction-steps-camera-capture.md`](instruction-steps-camera-capture.md) — `capturePhoto()`, the Blob upload mechanics (now shared via `lib/client/upload-image.ts`), and the `POST /api/blob/upload` route this loosens the auth on. [`api/task-lists-api.md`](../api/task-lists-api.md) — `TaskDefinition`/`TaskLog` schemas and the `POST`/`PATCH /api/task-logs` routes this extends. [`timer.md`](timer.md) — `TimerScreen`/`TaskFormScreen` completion flows this gates.
