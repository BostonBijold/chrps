> **Keep this file updated after any code change in this area — do not let it drift from actual implementation.**

# NFC Features

Ch'rps uses physical NFC tags for two things, both keyed off the tag's own
raw hardware UID and gated by a single registry:

1. **The tag registry** (this section) — before a UID can be bound to
   anything, it must be `provisioned` by us and `claimed` by the customer.
   This is what closes the hole where any NFC tag, from anywhere, could be
   scanned and bound to a task with no check it was ever a real Ch'rps tag.
2. **In-app scan-to-complete binding** (its own section below) — a claimed
   UID bound directly to a `TaskDefinition`/`InventoryItemType`, read
   in-app, gating that target's completion/logging. Also powers the FAB's
   "scan to open" shortcut.

There used to be a third system, **tap-to-trigger** (a separate `tagCode`/
Universal-Link mechanism) — removed entirely, see
[History: Tap-to-trigger (removed)](#history-tap-to-trigger-removed) below.

## The tag registry

`models/NfcTag.ts` is a closed-loop registry keyed by the tag's own raw
hardware UID (lowercase hex — the same value scan-to-complete binding
already uses, not an app-generated code):

```js
{
  uid,                 // unique index — the registry key
  status,               // 'unclaimed' | 'claimed' | 'retired'
  companyId,             // string | null — null until claimed
  locationId,             // string | null — null until claimed. Same
                         //   "plain String, not an ObjectId ref" convention
                         //   as every other location-owned collection, see
                         //   CLAUDE.md's Multi-Tenancy section
  claimedByUserId,
  claimedAt,
  label,                 // string | null — inert in v1, see "Deferred" below
  imageUrl,               // string | null — inert in v1, see "Deferred" below
  lastUsedAt,             // Date | null — stamped on every real verified match
  lastUsedByUserId,
}
```

A tag is single-company, single-location — many `TaskDefinition`s and/or
`InventoryItemType`s can still share one claimed UID (that's unchanged from
before this rework, see "Multi-target binding" below; the registry only
gates *whether* a UID can be bound at all, not how many things it can back
once it is).

Two workflows, cleanly separated (`lib/nfc-tags.ts`):

### Provisioning

Us, before a tag ships to a customer. No writing to the tag itself — the
UID is factory-burned and read-only, this app only ever reads it. Just a
scan + registry insert: `POST /api/admin/nfc-tags/provision`, body
`{ uid }`, creates `{ uid, status: 'unclaimed' }`. Rejects (`409`) if the
UID already exists in the registry in any state.

Gated on a fourth `User.role` tier, **`developer`** — a strict superset of
`owner` (see `lib/roles.ts`'s `isDeveloper`), never assignable through any
in-app flow, hand-set in MongoDB the same way `owner` already is (see
CLAUDE.md's Data Models section). Reached from a "Provision Tag" card on
Profile, shown only when `isDeveloper(role)` — invisible to every customer
manager/owner — which opens `/nfc/provision`
(`components/ProvisionNfcTagView.tsx`): a plain "Scan to Provision" button
reusing `lib/native/nfc-scan.ts`'s `scanNfcTag()`, with a running list of
what's been provisioned this session (not persisted/fetched — just a
visible confirmation trail while tapping through a batch of tags by hand).

Deliberately manual, one tag at a time — no batch tooling, confirmed fine
at current provisioning volume. The route itself isn't company-scoped at
all: a provisioned tag has no `companyId` yet, it's just a registry row
waiting to be claimed.

### Claiming

The customer, once they have the physical tag in hand — and there's no
separate "Claim Tag" step or screen at all: **binding a fresh tag to a
task or inventory item (the first "Scan to Link") is what claims it.** A
manager scans an unclaimed tag while linking it, and in that same request
it becomes theirs — locked to one `companyId` + one `locationId` — then
the bind proceeds immediately. One scan, one tap, no intermediate button,
no "now go claim it" detour. This was a deliberate simplification over an
earlier two-step design (scan → rejected as unclaimed → tap a separate
"Claim" button → retry) — see the note at the end of this section.

`lib/nfc-tags.ts`'s `claimNfcTag(companyId, locationId, userId, uid)` is
called as the very first thing `lib/task-definitions.ts`'s `bindNfcTag`
and `lib/inventory.ts`'s `bindInventoryNfcTag` do, before either writes a
UID onto a `TaskDefinition`/`InventoryItemType`:

- **UID not found in the registry at all** → throws
  `NfcTagNotRecognizedError`, turned into a `404` ("Not a recognized
  Ch'rps tag.") by the bind route — the scan is rejected outright, nothing
  gets claimed or bound. Only a UID `provisionNfcTag` created (see
  "Provisioning" above) can ever be claimed.
- **UID already `claimed` (or `retired`) under a *different* company or
  location** → throws `NfcTagClaimedElsewhereError`, turned into a `409`
  with a generic "This tag is already linked to another company." —
  matches the old tap-to-trigger system's non-disclosure wording, never
  reveals which company. This is what stops a manager from accidentally
  (or deliberately) pulling another store's tag into their own catalog.
- **UID already `claimed` by *this exact* company + location** —
  idempotent no-op (a second manager binding the same tag to a different
  task, or a retry); the bind just proceeds.
- **UID `unclaimed`** — claims it right here: sets `status: 'claimed'`,
  `companyId`, `locationId`, `claimedByUserId`, `claimedAt`, then the bind
  proceeds in the same request.

`locationId` defaults to the binding manager's own active location
(`pickActiveLocationId`, same resolution every other manager-write route
uses) — claiming never takes an explicit `locationId` param; an owner can
still narrow it with the existing `?locationId=` their header switcher
already sets on any write route. `label` is editable from "Manage Ch'rps"
below (see that section's "Labeling"); `imageUrl` stays inert — no
photo-upload UI built for it yet.

**Why folded into bind instead of its own step**: an earlier version of
this design had a standalone `POST /api/nfc-tags/claim` route and a
client-side "Claim & Retry" recovery button that appeared only after a
bind attempt came back rejected. Collapsing that into a single
claim-then-bind call inside `bindNfcTag`/`bindInventoryNfcTag` removes an
entire round-trip and UI state from the common case (a brand-new tag,
which is the *normal* first use of any tag) — a manager scanning a fresh
tag to link it never sees anything different from binding an
already-claimed one. The only two outcomes now are silent success or a
genuine error (not recognized / claimed elsewhere) — there's no
in-between "hasn't been claimed yet" state exposed to the UI at all.

### Usage stamping

Every real, matched scan that actually verifies a task completion
(`lib/task-log-actions.ts`'s `assertNfcVerified`) or an inventory log
(`app/api/inventory-logs/route.ts`, right where `verifiedNfcUid` is
computed) stamps `NfcTag.lastUsedAt`/`lastUsedByUserId` via
`stampNfcTagUsage`. Cheap, denormalized, best-effort — never blocks or
fails the completion it's confirming, and silently no-ops for a UID that
somehow isn't registered. This is what answers "when was this tag last
actually seen" from the admin side, without a separate audit table.

## In-app scan-to-complete binding

Same shape as before the registry, with claiming now folded invisibly into
the first bind (see "Claiming" above) — do not conflate this with the
registry, which only gates *whether/who* a bind is allowed for, not how
binding/completion themselves work:

- **Identifies a tag by** the tag's own raw hardware UID — nothing is
  written to the tag.
- **Stored** on `TaskDefinition.nfcTagUid` / `InventoryItemType.nfcTagUid`
  — one saved task/item ↔ one **or more** tags is not the shape; it's the
  reverse, one tag ↔ one or more saved tasks/targets, see "Multi-target
  binding" below.
- **Reads the tag** in-app, via `NFCTagReaderSession`
  (`ios/App/App/NfcScanPlugin.swift`).
- **Purpose**: gating a form task's completion (or an opted-in inventory
  item's count-logging) on proving the right physical, *claimed* tag is
  present.
- **Who can trigger it**: any signed-in company user — but only after a
  manager has bound it in Manage Task List / the Task Catalog / Manage
  Inventory (which, per "Claiming" above, is also what claims the tag the
  very first time).

**Binding a tag** (manager-only, in a shared "Scan-to-Complete Tag" panel —
`components/task-panels/NfcBindingPanel.tsx`, backed by
`lib/client/use-task-definition-panel.ts`'s `useTaskDefinitionPanel` hook,
see [`unified-task-edit-surface.md`](unified-task-edit-surface.md) —
rendered both inline in `components/TaskListEditView.tsx`'s `SortableRow`
and in the Task Catalog's `components/ManageTaskDetailSheet.tsx`; Inventory
has its own inline, unhooked equivalent in
`components/ManageInventoryDetailSheet.tsx`): tapping **Scan to Link**
calls `lib/native/nfc-scan.ts`'s `scanNfcTag()`, which opens
`NfcScanPlugin`'s native `NFCTagReaderSession` sheet. On a successful read,
the lowercase-hex UID is POSTed to the target's own `nfc-tag` route, whose
`bindNfcTag`/`bindInventoryNfcTag` call claims-then-binds in one step (see
"Claiming" above) — there is no intermediate "unclaimed" state the manager
ever sees; either it works, or `bindError` shows a genuine failure (tag not
recognized, or already claimed by a different company).

**One tag, more than one placement**: since the binding lives on the
`TaskDefinition` and the same definition can be placed in more than one
list (the "Company Task Catalog" design), `GET /api/tasks/by-nfc-uid` (the
FAB's "scan to open" shortcut, below) picks among several active
placements *for the same definition* via `lib/task-definitions.ts`'s
`resolveMostRelevantPlacement` — see
[task-lists.md](task-lists.md)'s "Company Task Catalog" section for exactly
how it decides. This is distinct from — and resolved before — the
multi-*target* disambiguation described next, which is about the same UID
meaning more than one different saved task, and/or an `InventoryItemType`
(see `docs/features/inventory.md`) — a genuinely different thing, not
another placement of the same one.

### Multi-target binding

A physical tag's UID is not required to resolve to exactly one
`TaskDefinition`. Binding is a plain field set (`TaskDefinition.nfcTagUid`
/ `InventoryItemType.nfcTagUid`) with **no uniqueness enforcement** —
`bindNfcTag` (`lib/task-definitions.ts`) and `bindInventoryNfcTag`
(`lib/inventory.ts`) each just set the UID on the target being bound, once
the registry gate above passes; neither clears that UID off any other
target first. This is what lets the same claimed physical tag (e.g. the
one stuck to the walk-in freezer door) back more than one thing a person
might scan it for — a temperature-log task AND an Inventory item type
(`docs/features/inventory.md`), simultaneously.

- **The same UID CAN bind to more than one `TaskDefinition`, and/or more
  than one `InventoryItemType`.** Nothing prevents it, deliberately — this
  is the whole point of the feature, unchanged by the registry gate (which
  only checks who *claimed* the tag, never how many things it's bound to).
- **Binding never fails because the UID is "already used" — only because
  it isn't claimed.** `POST /api/tasks/[id]/nfc-tag` and
  `POST /api/task-definitions/[id]/nfc-tag` return
  `{ nfcTagUid, alsoBoundTo: Array<{ name: string; locationName: string | null }> }`
  (`POST /api/inventory-item-types/[id]/nfc-tag` still returns the older
  `alsoBoundTo: string[]` shape — `InventoryItemType` stays company-wide,
  unaffected by the task-catalog location fix) — `alsoBoundTo` lists any
  other active target (`TaskDefinition` OR `InventoryItemType`, checked
  across BOTH collections regardless of which one is being bound)
  currently sharing this UID, shown once, right after a successful bind
  so a manager isn't surprised the tag is doing double duty. **This
  collision check is deliberately still COMPANY-WIDE, not
  location-filtered**, even though the bind itself is now location-scoped
  — seeing "this UID is also used at your other store" is exactly the
  useful signal for a manager who scanned the wrong physical tag; each
  `TaskDefinition` match carries its own `locationName` so the UI can say
  which store. Shown at bind time only — not persisted or re-fetched on a
  later page load.
- **Unbinding only ever manages the panel's own binding.** "Unbind" on one
  task's row (or one Inventory item's "Location Tag" panel) clears that one
  document's `nfcTagUid` only — it has no effect on any other
  `TaskDefinition` or `InventoryItemType` sharing the same UID, and no
  effect on the registry claim itself (the tag stays `claimed` by the
  company/location either way).
- **Resolution fans out, then disambiguates.** `GET /api/tasks/by-nfc-uid`
  (see "FAB 'scan to open' shortcut" below) is the one place a scanned
  UID's ambiguity is actually resolved — every other scan in the app
  already knows what it's looking for (a specific task's own `nfcTagUid`
  checked by `TaskFormScreen.tsx`, or a specific Inventory item's own
  `nfcTagUid` checked by `InventoryItemDetailView.tsx`'s "Save via NFC")
  and stays exactly as unambiguous as before.
- **Inventory** is the second bindable target type, resolved by the same
  route the same way (`InventoryItemType.find({ companyId, nfcTagUid, isActive: true })`
  alongside the `TaskDefinition.find` below, combined into one option list
  when both match). By default, binding an `InventoryItemType` doesn't gate
  anything the way a bound `TaskDefinition` always does — but a manager can
  opt a specific item into that same behavior via its `nfcRequiredToLog`
  flag, at which point it *does* gate (`assertInventoryNfcVerified`,
  mirroring `assertNfcVerified`) — see that doc's "NFC binding" and "NFC
  enforcement" sections.
- **Task ↔ Inventory Linking** (`docs/features/inventory.md`'s section of
  the same name) is what makes the common case — a task and a linked
  `InventoryItemType` sharing one physical tag — pay off: a single scan
  that verifies the task's own completion also verifies any linked item
  bound to that identical UID, no second scan.

**Completing a bound task**: the task still opens through the normal
fill-in flow (`components/TaskFormScreen.tsx` — timer/form fields exactly
as for any other task). Only the final step changes: with `item.nfcTagUid`
set, the primary button reads **Scan NFC** instead of **Save**. Tapping it
validates the form fields first, then opens the same native scan sheet;
the read UID must case-insensitively match `item.nfcTagUid` or the task is
*not* marked done — an inline error is shown and the employee can retry or
back out via "Missed it".

**Save chirp**: once either NFC-verified completion path in
`TaskFormScreen.tsx` actually saves (a fresh "Scan NFC" tap, or the FAB's
pre-verified `alreadyVerified` path), it plays a short confirmation sound
via `lib/notification-sound.ts`'s `playNotificationSound()`.

**Enforcement is server-side, not just the button in
`TaskFormScreen.tsx`.** Every write path that can set a `TaskLog` to `done`
calls `assertNfcVerified(taskId, verifiedNfcUid, performedByUserId)`
(`lib/task-log-actions.ts`) before it happens, throwing
`NfcTagRequiredError` (caught and turned into a `409`) when the placement's
`TaskDefinition` has an `nfcTagUid` bound (resolved via `taskId`'s
`definitionId`) and no matching UID was supplied — and, when it *does*
match, stamps `NfcTag.lastUsedAt` via `stampNfcTagUsage` (see "Usage
stamping" above):

- `completeInProgressLog` / `startImmediateLog` — the shared low-level
  completion helpers used by `PATCH /api/task-logs` (the in-app
  timer/form Save path — the *only* caller that can ever supply a matching
  `verifiedNfcUid`, threaded from `TaskFormScreen.tsx`'s scan result all
  the way through `TasksView.tsx`/`TaskListSessionView.tsx`).
- `POST /api/task-logs`'s terminal branch and `PATCH`'s manual-time-edit
  branch — the quick-complete/back-entry "Done" buttons in `TaskCard.tsx`
  (also disabled/relabeled client-side for a bound task, so the tap
  doesn't even reach the server) — blocked the same way, **except** the
  manual-time-edit branch skips the check when the log was *already*
  `done`: that path doubles as "Edit time" on an already-verified
  completion, not a new completion claim.
- `completeStrayInProgressLogs` — auto-closes a *different*, abandoned
  in-progress timer when a person starts something else. For a bound task
  this never happened via a scan, so it's recorded honestly as `missed`
  instead of silently `done`.

A caller that can't supply a verified UID (back-entry) gets a clean
rejection rather than being able to complete a bound task at all — the only
way to complete one is `TaskFormScreen.tsx`'s Scan NFC step.

**FAB "scan to open" shortcut** (`components/BottomNav.tsx`): when nothing
is currently running, the FAB shows an NFC icon instead of resuming a
timer. Tapping it calls `scanNfcTag()` directly (no task screen open yet),
then resolves the read UID via
`GET /api/tasks/by-nfc-uid?uid=<uid>&date=<localDate>&nowMinutes=<n>` —
open to any signed-in company user, not manager-gated.

**Disambiguation** (see "Multi-target binding" above): the route first
looks up every active `TaskDefinition` AND every active `InventoryItemType`
whose `nfcTagUid` matches the scanned UID, combines both lists, and
branches on the total count:

- **Zero matches** → `404`, "not recognized."
- **Exactly one match** → a `TaskDefinition` match resolves to a single
  `taskId` via `resolveMostRelevantPlacement`, then calls
  `lib/task-list-session-actions.ts`'s `resolveFabScanTarget` to decide
  what to do next. An `InventoryItemType` match returns
  `{ mode: "inventory", itemTypeId }` directly.
- **More than one match** →
  `{ mode: "disambiguate", options: [{ targetType, targetId, name }, …] }`,
  sorted by name, mixing both target types freely. Tapping an option
  re-calls the same route with `targetType`/`targetId` added — reusing the
  same already-scanned UID, no second scan.

**A physical tag identifies exactly one task, permanently** — a scan never
opens, redirects to, or advances into a different task.
`resolveFabScanTarget` resolves the task's list type (shift-window vs.
anytime) and its `TaskLog` for today, then decides between four response
modes: `already-logged`, `anytime`, `session`, `locked` — see the route's
own implementation and `TasksView.tsx`'s FAB-navigation effect for the
full detail on each; unchanged by this rework.

**This scan pre-satisfies that task's own Scan NFC step** — two equivalent
ways to finish a bound task, one scan either way (scan on the way in via
the FAB, or scan on the way out via TaskFormScreen's own Scan NFC button).
`preVerified` state (keyed by `taskId`, never leaks onto a different task)
is single-use per open — reopening a task later always requires proving
the tag again.

**Native requirements**: `ios/App/App/App.entitlements`'s
`com.apple.developer.nfc.readersession.formats` entitlement (`TAG` only —
`NDEF`/`PACE` were dropped after an App Store Connect upload started
failing with error 90778; the app only ever opens `NFCTagReaderSession` for
raw-UID scanning, never `NFCNDEFReaderSession`), an
`NFCReaderUsageDescription` string in `Info.plist`, and the "Near Field
Communication Tag Reading" capability added once in Xcode's Signing &
Capabilities. Physical-device only (the Simulator has no NFC radio).

**Do not add `.iso18092` (FeliCa) to `NfcScanPlugin.swift`'s polling
options.** FeliCa requires a separate, restricted entitlement
(`com.apple.developer.nfc.readersession.felica.systemcodes`) that Apple
grants only on request — it is NOT included by standard NFC Tag Reading.
Requesting it anyway fails the *entire* session with `NFCError` code 2
("Missing required entitlement"). `.iso14443`/`.iso15693` alone cover
MiFare/NTAG/vicinity tags, which is what this feature is built for.

### Scan to Find (Manage Tasks)

A read-only sibling of the FAB's "scan to open" shortcut above, solving a
different problem: a manager standing at the **Manage Tasks** screen
(`/tasks/manage`, `components/ManageTasksView.tsx`) troubleshooting a
specific physical tag has no way to know its raw UID by sight, so typing it
into that screen's search box isn't a real option. The **Scan to Find**
button next to that search box (`handleScanToFind`) calls the same
`scanNfcTag()` used everywhere else, then matches the read UID client-side
against the Company Task Catalog data the screen already has loaded
(`GET /api/task-definitions`, which includes each definition's own
`nfcTagUid`) — no server round-trip.

- **Zero matches** → an inline message. Deliberately scoped to
  `TaskDefinition` only — an `InventoryItemType` bound to the same UID
  isn't reported here, a manager looking for one uses Inventory's own
  screen instead.
- **One match** → opens that definition's `ManageTaskDetailSheet` directly.
- **More than one match** → a small tap-to-pick list of matching task
  names renders inline below the search bar.
- Off-device shows the same "Open the app on your phone to scan a tag."
  message the catalog's own "Scan to Link" button uses.

Unlike the FAB's shortcut, this never resolves a *placement*, starts a
timer, or completes anything — it only locates a `TaskDefinition` in the
catalog and opens its detail view. There's no dedicated API route for it.

## Manage Ch'rps

**"Ch'rp" is this app's product-facing name for a physical NFC tag** (a nod
to the completion "Save chirp" sound above) — introduced specifically for
this screen's copy. Internal code keeps `NfcTag`/"tag" naming throughout
(the model, the routes, every variable); only user-facing text says
"Ch'rp(s)".

A manager-only read/edit screen over the tag registry — `/nfc/manage`
(`components/ManageNfcTagsView.tsx`), reached from a "Manage Ch'rps" card
on Profile, a third "Manage" entry point alongside `/tasks/manage` and
`/inventory/manage`. Unlike those two, there's nothing to *create* here —
a Ch'rp is claimed by binding it to a task or item elsewhere (see
"Claiming" above), not from this screen — so it's list-and-edit only, no
"+ Add".

**`GET /api/nfc-tags`** — manager-or-above, company+location-scoped (same
`pickActiveLocationId` resolution as every other manager-write route, so
an owner's header switcher narrows this too). Returns every tag with
status `claimed` OR `retired` for this location (an `unclaimed` tag isn't
this company's to see — it belongs to no one yet), each joined with:

- **`boundTo`** — every active `TaskDefinition`/`InventoryItemType` at this
  location currently sharing the UID (see "Multi-target binding" above),
  by name. Empty means claimed but not yet bound to anything.
- **`claimedAt`/`claimedByName`**, **`lastUsedAt`/`lastUsedByName`** —
  straight off the registry row, user ids resolved to display names in one
  batched `User.find` (same pattern as every other name-join in this app,
  e.g. `GET /api/inventory-item-types`'s `lastLoggedByName`).

The view splits results into **Active**/**Retired** sections, searchable
by label or raw UID. Tapping a row opens `components/ManageChrpDetailSheet.tsx`.

### Labeling

`NfcTag.label` (previously inert, see the "Deferred" note in "The tag
registry" above) is now editable here — free text, 60 chars, trimmed empty
back to `null`. Purely cosmetic: shown instead of the raw UID in this list
and the detail sheet's header, never read by any bind/verify logic.
`imageUrl` stays inert — no photo-upload UI added in this pass.

### Retiring a tag

**`PATCH /api/nfc-tags/[uid]`** — manager-or-above, and scoped to a tag
this exact company+location already has claimed (the query filter
`{ uid, companyId, locationId, status: { $in: ["claimed", "retired"] } }`
is the whole guard — this can never touch another company's tag or an
unclaimed one). Body `{ label? }` and/or `{ status: "claimed" | "retired" }`
— the detail sheet's "Retire"/"Reactivate" button flips `status` only,
label saves independently.

**Retiring isn't just a display flag — it actually disables the tag**, per
the model's own "soft-disable slot (lost tag, decommissioned)" intent:

- `lib/task-log-actions.ts`'s `assertNfcVerified` and `lib/inventory.ts`'s
  `assertInventoryNfcVerified` both now look up the registry row for a
  matched UID and reject (same `NfcTagRequiredError`/
  `InventoryNfcRequiredError` as a genuinely wrong scan) if its `status`
  is `retired` — even though the UID still matches
  `TaskDefinition.nfcTagUid`/`InventoryItemType.nfcTagUid` exactly. A
  retired tag can no longer complete a bound task or satisfy
  `nfcRequiredToLog`, full stop, until a manager reactivates it.
- This is a small extra lookup only on the already-rare "a real scan just
  matched" path (every ordinary, unbound-task `assertNfcVerified` call
  still returns immediately with no registry query at all) — negligible
  overhead.
- **Deliberately does NOT unbind** `TaskDefinition.nfcTagUid`/
  `InventoryItemType.nfcTagUid` — the binding stays exactly as it was, so
  reactivating (finding the tag, or a working replacement with the same
  UID re-provisioned — physically impossible for a real tag, but the
  registry doesn't know that) instantly restores function with no
  re-binding step.
- Reactivating (`status: "claimed"`) is a plain status flip back — no
  re-verification of anything, since the row already belongs to this
  company+location and never stopped.

## History: Tap-to-trigger (removed)

Kept for institutional memory — none of this describes current behavior.
The old tap-to-trigger system used a separate `models/NfcTag.ts` shape
(`tagCode` written into a URL on the tag's NDEF content, not the raw
hardware UID), `models/PendingNfcLink.ts` (an "arm, then tap" linking
flow), and Universal Links (`app/nfc/[tagCode]/page.tsx`,
`app/.well-known/apple-app-site-association/route.ts`, the
`com.apple.developer.associated-domains` entitlement,
`components/UniversalLinkHandler.tsx`) to open the app directly and run
`lib/task-trigger.ts`'s `triggerTask()` — starting/advancing/completing a
task from a tap, anywhere, any time, with no scan required.

**Why it was removed, not just deprecated:** the underlying flaw was
structural, not fixable in place — tapping *any* NFC tag, including one
never provisioned or sold by Ch'rps, could be walked through the app's own
"claim a cold tag" picker (`components/NfcClaimTagPicker.tsx`) and bound to
a task with zero verification it was ever a real Ch'rps tag. A generic,
mass-produced blank NFC sticker from any hardware store could be claimed
this way. `triggerTask()`'s dispatch logic also instant-completed any
`form`-type task with no data captured on a tap — this app's tasks are now
almost entirely `form`-type, so a tap silently recorded empty checks with
no human ever seeing a screen to notice; see the now-superseded "Known gap
for form tasks" this doc used to carry. Rebuilding the whole tag concept
on the registry+claim model (this doc, top section) fixes both problems at
once — a tag must be a real, provisioned Ch'rps tag before it can be bound
to anything, and the only completion path left is the in-app scan-to-
complete flow above, which always requires a real field-filled form
first.

An earlier layer on top of tap-to-trigger — a per-tag Shortcuts/NFC
Automation combo for *silent*, phone-locked triggering, plus the entire
API-key-authenticated `/api/external/*` surface it depended on
(`GET /api/external/nfc/[tagCode]`, `POST /api/external/trigger-task`,
`start-timer`, `complete-active-task`, `GET /api/external/tasks`,
`lib/api-key.ts`, `User.apiKey`, the native
`ios/App/App/AppIntents/` Swift layer) — had already been removed before
this rework, for the identical instant-complete-with-no-data reason; see
`docs/project-structure.md`'s "iOS Native Shell" section.

**Left untouched, not cleaned up as part of this removal**:
`ios/App/App/SceneDelegate.swift`'s `scene(_:continue:)`/
`scene(_:openURLContexts:)` forwarding to `SceneDelegateProxy.shared` is
now dead code (nothing on the JS side listens for the `appUrlOpen` event it
broadcasts, since `UniversalLinkHandler.tsx` is deleted) but was left in
place rather than edited — same caveat as the `RoutineActivity` Xcode
target in CLAUDE.md's Vocabulary section: a native Xcode-target change
needs Xcode itself to verify safely, unlike a text-only pass over the
Next.js codebase.

## No more external API

There used to be an entire API-key-authenticated `/api/external/*` surface
here backing Shortcuts/Siri and the NFC silent-trigger flow — all deleted,
see "History: Tap-to-trigger (removed)" above.
