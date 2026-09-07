> **Keep this file updated after any code change in this area — do not let it drift from actual implementation.**

# Task Completion Instructions

**Status: BUILT** (manager-authoring side — see [`task-instructions-employee-view.md`](task-instructions-employee-view.md) for the now-also-built employee read view, and [`task-completion-photo.md`](task-completion-photo.md) for the now-also-built employee-side *required photo* piece).

Lets a manager attach up to **3 instruction steps** to a `TaskDefinition` — each step an optional image (a photo of what the finished result should look like: a clean bathroom, a properly set-up line) paired with an optional text description. This is the setup half of a two-sided photo feature. Employees now see these steps read-only via an "Instructions" button on their own task rows/cards (see [`task-instructions-employee-view.md`](task-instructions-employee-view.md)), and can be required to attach their own completion photo before marking a task done (see [`task-completion-photo.md`](task-completion-photo.md)).

Storage is [Vercel Blob](https://vercel.com/docs/storage/vercel-blob): the manager's browser uploads image bytes directly to Blob via a client-upload token, never through a Next.js server route. The step's **text lives in MongoDB**, not Blob — Blob only ever holds the file itself. This keeps editing a step's wording independent of its image and matches how every other piece of task content (`formFields`, `name`, `icon`) already lives on `TaskDefinition`.

## Data model

`models/TaskDefinition.ts`'s `instructionSteps` field, same layer as `formFields` (content of the check itself, cascades to every list placement):

```ts
instructionSteps: [{
  description: string | null,
  imageUrl: string | null,   // Vercel Blob URL; null if no image on this step
}]  // max 3 entries, default []
```

Mongoose's automatic per-subdocument `_id` (the schema does *not* set `_id: false`, unlike `FormFieldDefSchema`) is the per-step identity the manager UI uses for edit/delete — no explicit `id` field needed. Order in the array is display order; no separate `order` field since 3 items doesn't need one.

**Validation rule** (`lib/instruction-steps.ts`'s `sanitizeInstructionSteps`): a step needs *at least one* of `description`/`imageUrl` non-empty — an entry with both empty is dropped rather than stored (same "shape-first, drop malformed entries" pattern `sanitizeFormFields` already uses for `formFields`). **Clamped, not rejected, at 3 entries** (`MAX_INSTRUCTION_STEPS`).

## Blob upload flow

1. **Token endpoint** — `app/api/blob/upload/route.ts`, implementing `handleUpload` from `@vercel/blob/client` (server-side only). Any authenticated employee of the company — loosened from manager-or-above once [`task-completion-photo.md`](task-completion-photo.md) needed the same route for employee-captured completion photos; see that doc for why. `onBeforeGenerateToken` constrains `allowedContentTypes` to `["image/jpeg", "image/png", "image/webp"]`, an 8MB max, a 5-minute `validUntil`, and stamps the token payload with `companyId` (informational only — no `onUploadCompleted` callback consumes it yet, see "Open questions"). The 8MB cap and 5-minute token window (up from an original 5MB/default-30s) exist for the camera-capture flow — see [`instruction-steps-camera-capture.md`](instruction-steps-camera-capture.md). Every rejection path (`console.error`) so the real cause is visible in Vercel's Runtime Logs — the client side never sees more than a generic failure otherwise.
2. **Client upload** — `CatalogRow`'s `handleAddStep` in `components/ManageTasksView.tsx` first validates the file client-side (type against the same allow-list, size against the same 8MB cap) so a bad file fails immediately with a specific message instead of a round trip. It then calls `uploadImageDirect` (same file, now shared via `lib/client/upload-image.ts` — see [`task-completion-photo.md`](task-completion-photo.md)'s "Manager UI" for why it moved out of this file) — **not** `@vercel/blob/client`'s `upload()`. That SDK call was tried first and dropped: its `getBlobError()` falls back to a retryable `"unknown_error"` classification whenever a response body doesn't parse into its exact expected shape, which meant a genuine 400 got silently retried up to 10 times with exponential backoff — completely masking the real error behind either a false "hang" (our own client-side timeout winning the race) or several seconds of invisible retries. `uploadImageDirect` replicates only the two requests `upload()` makes internally (token retrieval via `/api/blob/upload`, then a `PUT` to Vercel's Blob API) with **no retries**, so any failure's actual response text reaches the UI (`stepsError`) on the first attempt. It also explicitly sends `x-content-type: file.type` — the SDK's `upload()` does **not** read a `File`'s own `.type` unless you pass `contentType` explicitly, and the original bug here was exactly that: no declared content type on the PUT, which the Blob API rejected as not matching our own `allowedContentTypes` allow-list. Filenames are also sanitized to plain ASCII (`[^a-zA-Z0-9._-]` stripped) before building the pathname, since a macOS screenshot's default name has spaces and a narrow no-break space character. A 30s client-side timeout (`withUploadTimeout`) still wraps the whole call as a last-resort safety net.
3. **Access**: Vercel Blob's client-upload flow is public-URL-only — anyone holding the exact URL can view it, though the URL itself is unguessable (long random suffix). Acceptable for instruction photos.
4. Once the browser has the resulting `url`, the whole `instructionSteps` array (including the new step) is saved in the same request via the `PATCH` below — upload and save are two separate round-trips per step-add, not one atomic operation. `ManageTaskDetailSheet.tsx`'s inline editor only closes on a confirmed success (`onAddStep` returns a `Promise<boolean>`); a failure leaves the draft in place with the error visible, instead of silently closing either way.

**Superseded** — this pass was originally upload-from-file-picker only (`<input type="file" accept="image/*">`); the manager's "+ Add Step" editor now opens the device camera directly instead, via a shared `lib/client/capture-image.ts` helper. See [`instruction-steps-camera-capture.md`](instruction-steps-camera-capture.md).

**A note on `uploadImageDirect`**: it replicates undocumented internal request shapes from `@vercel/blob`'s bundled client code (header names, the client-token format, the `blob.generate-client-token` event shape) rather than a published public API — reverse-engineered from `node_modules/@vercel/blob/dist/chunk-*.js` while debugging this exact issue. It's more brittle to a future `@vercel/blob` upgrade than calling `upload()` would be, in exchange for actually surfacing errors. If a future version of the SDK fixes the retry-masking behavior (or exposes a `retries: 0` option), reverting to `upload()` would be worth revisiting.

## API

`PATCH /api/task-definitions/[id]` (`app/api/task-definitions/[id]/route.ts`) grows `instructionSteps?: Array<{ description?: string; imageUrl?: string }>` in its request body, sanitized via `sanitizeInstructionSteps` and written to `TaskDefinition` — same as `name`/`icon`/`formFields`, so it cascades to every list placement. Its response, `GET /api/task-definitions`'s list response, and the resolved task shape (`lib/task-definitions.ts`'s `resolveTasks`/`resolveTask`, via `ResolvedTaskFields.instructionSteps`) all carry `instructionSteps` with each step's `_id` stringified.

## Manager UI

Lives inside `components/ManageTaskDetailSheet.tsx` (the per-task detail sheet reached from a Company Task Catalog row's tap, wired up in `ManageTasksView.tsx`'s `CatalogRow`) — an **"Instructions"** section, alongside the existing "Used In" list, NFC panel, and (see [`task-completion-photo.md`](task-completion-photo.md)) the "Require Photo at Completion" toggle.

- Shows up to 3 step cards (thumbnail + caption, whichever is present).
- Each step card has a **Delete** icon (removes that step, no confirmation — same low-stakes-edit treatment as removing a `formFields` entry).
- **"+ Add Step"** button opens an inline editor ("Take Photo" camera capture + description textarea, both optional but not both-empty — see [`instruction-steps-camera-capture.md`](instruction-steps-camera-capture.md)) — hidden once 3 steps already exist.
- Reordering: not built — steps display in array order.
- Every add/delete re-saves the *whole* `instructionSteps` array through `PATCH /api/task-definitions/[id]` immediately (`CatalogRow`'s `saveInstructionSteps`) — no separate "confirm changes" step for this section, unlike the rest of the sheet's edit-then-navigate-away flow.

## Open questions / deferred

- **Reordering steps** — no drag-to-reorder; a manager who wants a different order has to delete and re-add.
- **Orphaned blobs** — deleting a step (or replacing its image) doesn't delete the underlying Blob object, just drops the Mongo reference.
- **`onUploadCompleted` callback** — not implemented; nothing server-side reacts to a successful upload beyond the client attaching the URL.
- ~~Whether employees ever see this content read-only somewhere~~ — **built**, see [`task-instructions-employee-view.md`](task-instructions-employee-view.md).
- ~~Employee-side "must attach a photo to mark this task done"~~ — **built**, see [`task-completion-photo.md`](task-completion-photo.md).

## Depends on

[`api/task-lists-api.md`](../api/task-lists-api.md) — `TaskDefinition` schema and the `PATCH /api/task-definitions/[id]` route this extends. [`features/task-lists.md`](task-lists.md) — `ManageTaskDetailSheet.tsx`'s existing structure this adds a section to.

**Sets up for** (built): [`task-completion-photo.md`](task-completion-photo.md) — the employee-side "must attach a photo to mark this task done" feature reuses this doc's Blob-upload mechanics and `lib/client/capture-image.ts` capture helper, plus a `TaskLog`-level `photoUrl` field. A manager review surface to compare the two photos side-by-side is still not built — see that doc's "Open questions."
