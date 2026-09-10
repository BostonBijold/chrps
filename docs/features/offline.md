> **Keep this file updated after any code change in this area — do not let it drift from actual implementation.**

# Offline Support (local SQLite cache + mutation queue)

Restaurant WiFi drops. When it does, the app needs a local fallback so a
shift checklist can still get done — task list load, task completion, and
NFC lookup are otherwise all live round trips to the API. This feature adds
a native on-device SQLite database that mirrors the account's current task
data, plus a queue that lets task completions happen fully offline and sync
once connectivity returns.

This is **not** a rewrite of the data layer — Mongo/the API remains the
single source of truth. SQLite is a local cache and outbox, not a second
database the app "runs on."

## Why SQLite, not IndexedDB/localStorage

We're on Capacitor, not a bare PWA — the app already ships native Swift
code (`ChrpsAPI.swift`, the Live Activity extension, `NfcScanPlugin.swift`),
so this is one more native capability, not a new pattern. IndexedDB/
localStorage inside the WebView is not durable: iOS can evict WebView
storage under disk pressure with no warning, which is unacceptable for
records that represent real, physically-performed work (a manager cannot
be told "sorry, that closing checklist got silently deleted"). Native
SQLite via `@capacitor-community/sqlite` is backed by an actual file in the
app's sandbox and survives exactly like any other native app's local data.

## Known limitation — cold launch / full page reload while offline

`capacitor.config.ts` runs the iOS shell in **server-URL mode**
(`server.url: 'https://chrps.vercel.app'`) — the native `WKWebView` loads
the page shell itself over the network, the same as a browser tab (see
`docs/project-structure.md`'s "iOS Native Shell"). The existing service
worker (`public/sw.js`) only cache-firsts a handful of static shell assets
(manifest, icons) — it explicitly does **not** cache pages or API routes
("data lives in MongoDB, never cached").

So: a mutation made *while already on a loaded Tasks page* when WiFi drops
is exactly what this feature fixes (queued via SQLite, synced on
reconnect). But a **cold app launch, or any full page navigation/reload,
while offline will fail to load at all** — the SQLite cache can't serve
HTML the WebView never fetched. This is the same kind of deliberate scope
line drawn below for Universal Links — documented as a known gap, not
silently claimed as solved. Fixing it would mean either bundling the web
app locally (a materially bigger native-build change) or teaching the
service worker to cache-and-fall-back the page shell/JS bundles — neither
attempted here.

## Scope

**In scope (this doc):**
- Caching a company's task lists, task placements, task definitions
  (including NFC bindings), and today's task logs locally.
- Queuing task-log mutations (start/complete/miss) made while offline
  in either of the two places that write them — the standalone/anytime-task
  flow (`components/TasksView.tsx`) and the guided shift-list "Start Tasks"
  walkthrough (`components/TaskListSessionView.tsx`) — syncing when
  connectivity returns.
- Resolving **in-app scan-to-complete** NFC lookups
  (`GET /api/tasks/by-nfc-uid`, see [nfc.md](nfc.md)) against the local
  cache instead of the network.

**Out of scope:**
- (Tap-to-trigger via Universal Links used to be listed here as an
  out-of-scope, network-required path — moot now that the whole system was
  removed entirely, see [nfc.md](nfc.md)'s "History: Tap-to-trigger
  (removed)".)
- **Undo** and every manager-only action (linking/unlinking NFC tags,
  creating/editing task lists or definitions) — lower-frequency, config-
  style actions a person can reasonably be asked to retry once back online;
  queuing them adds real conflict-resolution complexity for little day-to-
  day benefit. These simply fail today when offline, same as before this
  feature — no special handling was added or is needed.

## Data model (SQLite tables)

Mirrors the subset of Mongo collections needed to run a shift offline. Each
table carries the same `_id` as its Mongo document (as `id TEXT PRIMARY
KEY`), so a synced row is a straightforward upsert-by-id. See
`lib/offline-db.ts` for the exact `CREATE TABLE` statements.

- **`task_lists`** — mirrors `TaskList` (`id, companyId, name, startTime,
  order, updatedAt`).
- **`tasks`** — mirrors `Task`, the **raw placement** (`id, companyId,
  taskListId, taskDefinitionId, scheduledDays, successThreshold, order,
  projectedMinutes, updatedAt`) — not a resolved/flattened shape. See
  "Pull sync" below for why the placement and its definition are kept in
  two separate tables here, same split as Mongo.
- **`task_definitions`** — mirrors `TaskDefinition` (`id, companyId, name,
  icon, taskType, formFields` (JSON text), `nfcTagUid, updatedAt`). This is
  the table the offline NFC resolver queries by `nfcTagUid`.
- **`task_logs`** — mirrors `TaskLog` (`id, companyId, taskId,
  performedByUserId, date, state, startedAt, completedAt, formValues`
  (JSON text), `updatedAt`), plus a local-only `syncStatus: 'synced' |
  'pending' | 'conflict'` column that doesn't exist server-side.
- **`sync_queue`** — the outbox: `id (local uuid), entity: 'task_log',
  operation: 'create' | 'update', taskLogId, payload` (JSON text —
  `{ method, body }`, replayed verbatim against `POST`/`PATCH
  /api/task-logs`), `createdAt, retryCount, lastError`.
- **`sync_meta`** — single-row-per-company: `{ companyId, lastFullSyncAt,
  lastQueueFlushAt }`.

`formFields`/`formValues` are stored as JSON text columns rather than
normalized, matching how Mongo itself stores them — they're read-and-
displayed blobs on every platform already.

## Correction to the original design sketch — pull-sync's data source

An earlier draft of this doc assumed pull-sync needed "no new endpoints."
In practice, three existing routes needed small **additive** field
extensions, not a new endpoint:

- `GET /api/task-lists` — extended to return `startTime`/`updatedAt` per
  list and the full raw-placement shape per task (`taskListId`,
  `definitionId`, `scheduledDays`, `successThreshold`, `projectedMinutes`
  override, `order`, `updatedAt`) instead of the previously trimmed
  `name`/`icon`/`projectedMinutes`/`order` subset. This route had no
  existing client caller (`components/AddTaskListSheet.tsx` only POSTs to
  it), so widening its GET response was safe.
- `GET /api/task-definitions` — extended with `companyId`/`updatedAt`; it
  already returned everything else (`taskType`, `formFields`, `nfcTagUid`).
- `GET /api/task-logs?date=` — `serializeLog` (`lib/task-log-actions.ts`)
  extended with `performedByUserId`/`updatedAt`; both already existed on
  the underlying document, just weren't serialized.

## Pull sync — mirroring server state down

`lib/offline-sync.ts`'s `pullSync(companyId, date)`, triggered from
`components/TasksView.tsx` (the one place that has both `companyId` and
cares about sync timing — see "Where the sync triggers live" below):

1. Fetch the three extended routes above in parallel — task lists (with
   raw placements), task definitions, and the given date's logs.
2. Upsert into the local tables by `id`.
3. **Never overwrite a `task_logs` row with local `syncStatus: 'pending'`**
   (`upsertSyncedTaskLogs` in `lib/offline-db.ts`) — that row represents an
   offline mutation not yet acknowledged by the server; pulling server
   state must not clobber it out from under the queue.
4. Rows for lists/tasks/definitions the company no longer has (deleted
   server-side) are removed locally (`pruneTaskLists`/`pruneTasks`/
   `pruneTaskDefinitions`). `task_logs` is never pruned by a pull sync —
   only today's date is ever fetched, and a still-`pending` row must never
   be swept away by a sync that only knows about today.

This keeps today's — and only today's — logs cached, matching what the
Tasks page already loads; historical dates remain online-only.

## Offline mutation queue — task logs

Both places a task-log mutation gets made check `isOnline` (from
`components/NetworkStatusProvider.tsx`) before their `fetch("/api/task-
logs", …)` call:

- `components/TasksView.tsx` — `handleStateChange` (quick done/missed
  and back-entry), `handleStartTimer`, `handleTimerComplete`,
  `handleTaskFormComplete`, `handleTimerMissed`. (`DELETE` for Undo is
  deliberately left unguarded — see Scope above.)
- `components/TaskListSessionView.tsx` — the per-task-switch effect (starts/
  resumes the active timer inside a session) and `saveLog` (done/missed,
  with or without form data).

When offline, instead of `fetch`, both call `lib/offline-sync.ts`'s
`queueTaskLogMutation(...)`:

1. Writes/updates the local `task_logs` row directly — keyed by the
   existing synced row's id if one is already cached for this task+date,
   otherwise a synthetic `local:<taskId>:<date>` id — with `syncStatus:
   'pending'`, exactly as if the API call had already succeeded. The
   caller's own optimistic React-state update (already present on every
   call site before this feature) is what makes the UI feel instant; this
   write is purely for persistence-across-restarts and eventual sync.
2. Appends a row to `sync_queue` with the exact `{ method, body }` the
   `fetch` call would have sent — replayed verbatim on flush.

`lib/offline-sync.ts`'s `flushQueue()` replays `sync_queue` in order
against `app/api/task-logs`:
- **Success:** deletes the local `task_logs` row (not renamed onto the
  server's real `_id` — the reconnect flow always runs `flushQueue()`
  immediately followed by `pullSync()`, which repopulates the authoritative
  row under its real id right after) and deletes the queue row.
- **Validation-error response** (4xx — e.g. an NFC mismatch, see below):
  marks the log `syncStatus: 'conflict'` and records `lastError` on the
  queue row. Rows with a `lastError` already set are skipped on later
  flushes — no infinite retry loop against a request the server will never
  accept. (Whether `conflict` rows need a manager-facing review UI, or a
  toast is enough for v1, is not yet decided.)
- **Network failure** (still offline): stops processing immediately and
  leaves the rest of the queue for next time.

**Conflict resolution: last-write-wins by `updatedAt`.** Given `TaskLog` is
company-shared, not per-user (see [task-lists.md](task-lists.md) — "any
employee on shift can complete a given task"), the realistic conflict is
two staff completing the same task from different devices while one was
offline — a genuinely rare, low-stakes collision. This doesn't need CRDTs
or merge logic.

**NFC-bound tasks offline:** `assertNfcVerified` (server-side) is what
actually enforces a scan happened — offline, a task's `verifiedNfcUid` is
accepted optimistically into the queued mutation and only actually
re-checked when it syncs; a mismatch then surfaces as a `conflict` row
instead of blocking the completion in the moment.

## Where the sync triggers live

`components/NetworkStatusProvider.tsx` is mounted once at the root layout
(`app/layout.tsx`), before any company is resolved — it owns the raw
`@capacitor/network` listener and exposes `{ isOnline, pendingCount,
refreshPendingCount }` via context, but does **not** itself call
`pullSync`/`flushQueue` (it has no `companyId` to sync with).
`components/TasksView.tsx` — the one place that both knows `companyId` and
cares about sync timing — owns two effects instead:
- Fires `flushQueue()` then `pullSync(companyId, today)` on every
  offline→online transition (and once on mount if already online).
- Registers its own `@capacitor/app` `'resume'` listener to do the same
  flush-then-pull on app foreground.

## Offline NFC resolution (in-app scan-to-complete)

`GET /api/tasks/by-nfc-uid` (see [nfc.md](nfc.md)) resolves a scanned UID
in three steps: `TaskDefinition.findOne({ nfcTagUid })`, then
`resolveMostRelevantPlacement` (`lib/task-definitions.ts`) to pick the
right placement when the same definition is placed in more than one list,
then `resolveFabScanTarget` to pick one of four response modes
(`already-logged`/`anytime`/`session`/`locked`).

Since a native NFC scan itself needs no network (`NfcScanPlugin.swift`
reads the UID locally), only the *lookup* needed a network fallback:

1. `components/BottomNav.tsx`'s `handleScanToOpen` checks `isOnline` after
   `scanNfcTag()` returns a UID.
2. **Online:** unchanged — calls `GET /api/tasks/by-nfc-uid`.
3. **Offline:** calls `lib/offline-nfc-resolver.ts`'s
   `resolveOfflineNfcUid(uid, localDate, nowMinutes)`, which queries the
   local `task_definitions` table by `nfcTagUid`, then runs the same
   placement-selection logic against the locally cached `tasks`/
   `task_lists`/`task_logs` for that definition. **Deliberately does not**
   replicate `resolveFabScanTarget`'s four-way response split — it just
   opens the resolved task directly (`/tasks?openTaskId=...`), which then
   goes through the normal offline mutation queue above like any other
   task completion.
4. If no local match: shows "Can't verify this tag while offline" rather
   than falling through to the cold-tap claim picker (a manager, server-
   backed, config-time flow, not something to reinterpret offline).

**This only covers already-linked tags whose definition was present in the
last successful pull sync.** A tag linked on a different device since the
last sync won't resolve offline until the next pull — an acceptable,
clearly-scoped gap.

**The shared selection logic itself** — `pickMostRelevantPlacement` — lives
in `lib/placement-resolution.ts`, a module with zero imports (no Mongoose,
no models), deliberately isolated from `lib/task-definitions.ts` (which
imports Mongoose at module scope). `lib/task-definitions.ts`'s
`resolveMostRelevantPlacement` (the online, Mongo-reading path) and
`lib/offline-nfc-resolver.ts` (the offline, SQLite-reading path, reached
from the client component `components/BottomNav.tsx`) both import from
`lib/placement-resolution.ts` directly. This split exists because a client
component importing anything from `lib/task-definitions.ts` fails to build
— Next.js can't bundle Mongoose's Node built-ins (`net`, `tls`,
`fs/promises`, `child_process`) for the browser.

## Network listener

`@capacitor/network`'s `Network.addListener('networkStatusChange', ...)`
drives `NetworkStatusProvider`'s `isOnline` state and, in turn,
`components/OfflineBanner.tsx`'s persistent "Offline — changes will sync"
/ "Syncing N changes…" banner. `Network.getStatus()` on mount sets initial
state before the first listener event fires. Both are native-only
(`Capacitor.isNativePlatform()`-guarded) — on plain web/PWA
`isOnline` stays permanently `true` and every code path above behaves
exactly as it did before this feature.

## Files

- `lib/offline-db.ts` — SQLite connection singleton (`@capacitor-community/
  sqlite`'s `SQLiteConnection`), schema creation, typed table accessors.
- `lib/offline-sync.ts` — `pullSync`, `flushQueue`, `queueTaskLogMutation`.
- `lib/offline-nfc-resolver.ts` — the local `nfcTagUid` → placement lookup.
- `lib/placement-resolution.ts` — the pure `pickMostRelevantPlacement`
  selection logic shared by the online and offline resolution paths (see
  above).
- `components/NetworkStatusProvider.tsx` — mounts the `@capacitor/network`
  listener once, exposes online/offline + pending-count via context.
- `components/OfflineBanner.tsx` — reads that context, renders the
  persistent status indicator.

## Open questions (not yet decided)

- Whether the cache should extend beyond "today" (e.g. yesterday, for
  back-entry corrections made offline) — deferred until it's an actual
  complaint.
- Whether `sync_queue` `conflict` rows need a manager-facing review UI, or
  a toast + leaving them visible via `OfflineBanner`'s pending count is
  enough for v1.
- Encryption at rest for the local SQLite file
  (`@capacitor-community/sqlite` supports SQLCipher) — likely not needed
  given the data isn't more sensitive than what already sits in the app's
  UI, but worth a deliberate call rather than a default. Not enabled today
  (`createConnection(..., encrypted: false, ...)`).
- The cold-launch/full-reload-while-offline gap (see "Known limitation"
  above) — needs its own follow-up spec if it becomes a real complaint,
  same as Universal Links.

## Depends on

- [nfc.md](nfc.md) — in-app scan-to-complete binding, `nfcTagUid`,
  `resolveMostRelevantPlacement`.
- [task-lists.md](task-lists.md) — `TaskList`/`Task`/`TaskDefinition`/
  `TaskLog` data model, log states.
- [`api/task-lists-api.md`](../api/task-lists-api.md) — the task-log
  endpoints the sync queue replays.
