# Ch'rps — Project Brief for Claude Code

## Vision
A restaurant shift-check app built around one core insight: the job isn't
done until the checklist is — fridge and freezer temps, restroom checks,
cash counts, opening/closing tasks, all done consistently and left as an
honest record. Ch'rps started as a lean fork of a personal habit/routine
tracker (itself a fork of an earlier, more philosophy-heavy app, "A Good
Man") — that personal-habit framing has since been retired in favor of
restaurant work checks: structured checklist tasks (`form`-type) with
numeric readings or yes/no fields, an honest "missed" skip state,
streaks, and completion analytics. The old timer-based "habit" item types
(countdown/stopwatch/checkbox) and the Sunday "Routine Review" time-variance
feature are gone — a checklist's value is in what got checked, not how long
it took.

Ch'rps is also multi-tenant — every restaurant, gym, or hotel using it is
a `Company`, with its own users, task lists, tasks, and check history — and
a manager can create, rename, schedule, and delete task lists directly from
the app rather than being limited to the three seeded ones. See
"Multi-Tenancy" and "Task Lists" below.

Primary user: restaurant managers and staff running shift checklists —
opening/mid-shift/closing checks plus anytime tasks (fridge, freezer,
restrooms) and any custom task lists a manager sets up. Built mobile-first
as a Vercel web app, designed to eventually become a native iOS/Android app.
The data layer must stay consistent for that future migration (MongoDB +
REST API).

---

## Vocabulary

The product vocabulary is **TaskList** for a group of checks and **Task**
for an individual item within one — full stop, applied consistently across
model/collection names, component names, variable names, internal API route
naming, code comments, and product-facing UI text and documentation. This
supersedes all earlier vocabulary from this app's pivot history: "Routine"
(→ TaskList), "RoutineItem"/"Habit item" (→ Task), "check"/"Facility Checks"
as product-concept nouns, and "habit" as this app's core concept (a
`HabitTemplate` is now a `TaskTemplate`, etc.). Plain English use of "check"
describing what a task actually does (e.g. a seeded task literally named
"Restroom Check", or a temperature "check") is unaffected — only the old
*product* vocabulary was renamed, not every occurrence of the word.

**One deliberate, permanent exception remains** (a second one, the external
API's un-renamed wire-contract field names, no longer applies — that whole
surface was deleted, see `docs/project-structure.md`'s "iOS Native Shell"
section):

**The `RoutineActivity` Xcode target/Widget Extension's `Habit`/`Routine`
naming** (`RoutineActivityAttributes`, its `ContentState` push/Live-Activity
contract) still uses the pre-pivot vocabulary. This was a deliberate scope
cut, not an oversight: a native Xcode-target rename needs Xcode itself to
verify safely, unlike a text-only pass over the Next.js codebase. See
`docs/project-structure.md`'s "iOS Native Shell" section. The app's own
brand-name naming in this same layer (`ios/App/App/ChrpsAPI.swift`,
`ChrpsShortcuts.swift`, previously `BeOneAPI.swift`/`BeOneShortcuts.swift`
from the "Be One" app this was originally forked from, then briefly
"TapCheck") is moot now too — both files were deleted along with the App
Intents/Shortcuts layer they backed, not just renamed.

---

## Tech Stack
- **Framework**: Next.js 14 (App Router)
- **Database**: MongoDB via Mongoose
- **Auth**: Auth.js (NextAuth v5)
- **Styling**: Tailwind CSS
- **Deployment**: Vercel (free tier)
- **Future**: React Native wrapper around same API

---

## Design System

### Colors
White-background, high-readability palette with a single brand accent
(blue), a green reserved for confirmed-complete indicators, and a minimal
red for errors/missed — everything else is a neutral slate/gray. Amber
survives as a functional timer-warning status color (on-track → warning →
over-target), not a brand accent.
```
bg:             #ffffff   (white — all backgrounds)
card:           #f8fafc   (card surfaces)
card-hover:     #f1f5f9
text:           #0f172a   (near-black, high contrast)
muted:          #64748b
dim:            #94a3b8
olive:          #2563eb   (primary accent — actions, buttons, links, streaks)
olive-light:    #3b82f6
done:           #22b37c   (Ch'rps Green — sampled from the logo's own
                           checkmark; completion badges/borders/dots ONLY —
                           e.g. a task card's "✓ Done" pill, StreakDots'
                           done dot — kept distinct from olive so "this is
                           actually finished" reads apart from ordinary blue
                           actions/buttons, especially now that blue also
                           covers TaskFormScreen/TaskListSessionView's
                           task-swap transition backdrop)
gold:           #3b82f6   (special-item highlights — same accent family)
tobacco:        #78716c   (neutral — past-window states)
burgundy:       #dc2626   (missed, over-timer states)
burgundy-light: #ef4444
amber:          #d97706   (timer warning — 75% of target elapsed)
blue-muted:     #71717a   (neutral — standalone/To-Do task layer; also the retired
                           "rest" state's legacy display color, see "Skip Types" below)
border:         #e2e8f0
border-light:   #cbd5e1
```
Token *names* (olive, gold, burgundy, etc.) are kept from the previous dark
theme for continuity with existing component code — only their hex values
changed. Don't read the names as literal colors. `done` is the one
exception: a genuinely new token (not inherited from the old theme), added
specifically to separate completion indicators from the broader blue accent.

### Typography
- **Headings**: Playfair Display (serif)
- **Data/Timers/Labels**: IBM Plex Mono
- **Body/UI**: Inter
- All loaded via Google Fonts

### Border Radius
- Cards: 12px
- Buttons: 8px
- Badges/pills: 20px (full round)
- Bottom sheet / modals: 16px top corners

### Layout
- Max width: 420px, centered
- Mobile-first
- Bottom navigation bar (Tasks, Team, Reports, Inventory) around a center
  FAB — see "Current App State" below for the exact tab layout

---

## Data Models

Ch'rps is multi-tenant: every restaurant, gym, or hotel using Ch'rps is a
Company, and every other collection scopes its data either to the Company
(shared configuration) or to the Company plus the specific user who acted
(activity records). See "Multi-Tenancy" below for the full reasoning.

### Company
```js
{
  _id,
  companyName,
  industry,                   // stubbed, not read anywhere yet
  timezone,                   // IANA zone name ('America/Chicago') or null — no longer stubbed as of
                               // the missed-shift-list alert sweep (see "Notifications" below), which
                               // needs a company-local "now" independent of any browser's own offset.
                               // Manager-set from Profile > Company Settings; null skips that company
                               // in the sweep entirely (see docs/features/notifications.md).
  notificationPreferences,    // stubbed, not read anywhere yet
  notificationSound,          // 'standard' | 'male' — defaults 'standard'; which chirp plays on a
                               // device that completes an NFC-bound task via "Scan NFC to Save"
                               // (docs/features/nfc.md). Manager-set from Profile > Company Settings.
  notificationsEnabled,        // bool, defaults true — company-wide kill switch for BOTH shift-window
                               // alert types (see "Notifications" below). No per-manager mute in v1.
  missedAlertGraceMinutes,     // number | null, defaults 30 — minutes past a shift-window list's
                               // derived end time before the missed-list sweep alerts managers it's
                               // still not done; manager-set from Profile > Company Settings, one
                               // value for every shift-window list company-wide (not per-list). null
                               // turns missed alerts off entirely for this company — a narrower switch
                               // than notificationsEnabled above, since it leaves start-time reminders
                               // untouched. A pre-existing company with this field unset falls back to
                               // 30 (the original hardcoded value), not "off" — only an explicit null
                               // means off. See "Notifications" below.
  subscription: {              // stubbed — no Stripe integration wired up yet
    status,                   // 'trialing' | 'active' | 'past_due' | 'canceled' | 'none' — defaults 'trialing'
    tier,                     // 'free' | 'starter' | 'pro' — defaults 'free'
    stripeCustomerId,         // "cus_..." — set once they exist in Stripe, even pre-payment
    stripeSubscriptionId,     // "sub_..." — set once they actually subscribe
    trialEndsAt,              // Date, if timed trials are used
    seatLimit,                // for later per-seat pricing
    currentPeriodEnd,         // Date — shows "renews on X" without hitting the Stripe API
  },
  createdAt
}
```

### Location
One physical store under a Company — see docs/features/locations.md.
Scope is deliberately narrow: one company, many locations, never the other
way around.
```js
{
  _id,
  companyId,          // ref Company — the only relationship; a Location never exists without a Company
  name,                // e.g. "Salt Lake City"
  address,             // string | null
  timezone,            // IANA name | null — not yet read anywhere
  isActive,            // bool, default true — soft-delete/close, same convention as TaskList.isActive
  createdAt
}
```

### User
```js
{
  _id, email, name,
  companyId,                   // ref Company — null until attached via an Invite redemption or (still supported)
                               // a developer manually attaching one in MongoDB
  role: 'manager' | 'employee' | 'owner' | null, // defaults to 'manager' on signup; null after
                               // DELETE /api/team/[userId] detaches a user from their company (see "Team &
                               // Invites" below) — a null role never grants access on its own, every route
                               // gates on companyId first. 'owner' (see "Locations" below) is a strict
                               // superset of 'manager' — sees/administers every Location under the company,
                               // not just one — and is never assigned through any in-app flow, only by hand
                               // in MongoDB, same as a company's very first manager.
  companyJoinedAt,             // Date | null — set at Invite redemption alongside companyId/role; null for
                               // anyone attached by hand in MongoDB. Distinct from account-creation createdAt
                               // so re-joining a *different* company later reflects current tenure there.
  locationId,                  // ref Location | null — see "Locations" below. This user's PRIMARY location;
                               // for 'employee'/'manager' it's also their ONLY visible location. For 'owner'
                               // it's just their default context — an owner's actual visible-locations set is
                               // computed (every active Location under companyId), never stored. Set at
                               // Invite redemption from the invite's own locationId, or by an owner via
                               // PATCH /api/team/[userId]. Null until the one-off backfill script runs
                               // (scripts/backfill-locations.mjs) for any pre-Locations user.
  activeLocationId,            // ref Location | null — an owner's location-switcher selection (see
                               // "Locations" below's "Location switcher"), distinct from locationId above
                               // (that's this user's fixed home/default). Meaningless for employee/manager.
                               // null = no override; resolves to locationId (Tasks/Reports/Inventory) or
                               // "no filter, show everyone" (Team) depending on the page. Set only via
                               // PATCH /api/session/active-location.
  jobTags,                     // string[], default [] — company-defined job function tags (server/cook/
                               // busser/host/…), orthogonal to role (role = access, jobTags = task-list
                               // assignment). Catalog + assignment UI live in the Admin Console (Team
                               // page); not yet read by any task-list-visibility logic — see
                               // docs/features/locations.md's "Job tags" and
                               // docs/features/admin-console.md's "Job Tags catalog".
  deletedAt,                   // Date | null — set by self-service account deletion (DELETE
                               // /api/account); null for every existing user. lib/auth.ts's jwt
                               // callback checks this on every session read and invalidates any
                               // still-live JWT once it's set, since this app runs JWT sessions (no
                               // adapter-side session row to just delete) — see
                               // docs/features/account-deletion.md.
  liveActivityPushToken,      // iOS Live Activity push updates
  liveActivityPushEnvironment,// 'sandbox' | 'production'
  createdAt
}
```

### Invite
Ownership-level, company-scoped join token — see "Team & Invites" below and
`docs/features/team-invites.md`.
```js
{
  _id,
  companyId,
  token,             // crypto.randomBytes(24).toString("base64url") — unguessable, opening
                     //   /invite/<token> is what attaches a user to companyId
  role: 'employee' | 'manager', // preset by the manager who generated it; applied to the User on redemption
  locationId,        // see "Locations" below — stamped from the creating manager's own User.locationId, or
                     //   picked explicitly if an owner created it; applied to the User on redemption
  createdByUserId,   // attribution only, same convention as NfcTag.claimedByUserId
  expiresAt,         // Date — default now + 7 days
  maxUses,           // default 1; a "reusable link" invite sets a higher cap
  useCount,          // incremented atomically on each redemption
  revokedAt,         // Date | null — soft-delete, set by a manager revoking a pending invite
  createdAt
}
```

### TaskList
Ownership-level — the company's shared task-list configuration, not any
individual's personal data. A manager can create, rename, schedule, and
soft-delete these directly from the app — see "Task Lists" below.
```js
{
  _id,
  companyId,
  name,             // 'Opening Shift', 'Mid-Shift', 'Closing Shift', 'Anytime Tasks', or any manager-created name
  timeOfDay: 'morning' | 'evening' | 'custom' | 'anytime',
  startTime,        // 'HH:MM' — drives the time-aware collapse window (null for 'anytime' lists, which never collapse)
  order,            // same-`startTime` tie-breaker only — lists display sorted by
                    // `startTime` (anytime lists, `startTime: null`, sort separately),
                    // not by this field; a duplicated list inherits its source's
                    // `startTime` with a strictly higher `order`, landing right after it
  isDefault: bool,
  isActive: bool,   // soft-delete flag — same convention as Task.isActive
  scheduledDays,    // 0=Sun..6=Sat — a default pushed down onto every Task in the list when changed
  qstashScheduleId, // string | null — the QStash schedule backing this list's start-time reminder push
                    // (see "Notifications" below); deterministic (`tasklist-<_id>`), re-upserted
                    // whenever startTime/scheduledDays/the company's timezone changes, null = none
}
```

### Task / TaskDefinition
Ownership-level — same reasoning as TaskList. `Task` is a lightweight list
**placement**, not a self-contained document; the check's actual content
lives one layer up on `TaskDefinition`, the company's reusable saved-task
catalog ("Company Task Catalog" — see `docs/features/task-lists.md`). The
same `TaskDefinition` can be placed in more than one list (e.g. the same
fridge-temp check in both the opening and closing lists), each placement
getting its own independent `TaskLog` history and streak strip. Every API
response is still the same flat, resolved shape client code has always
consumed — `lib/task-definitions.ts`'s `resolveTasks`/`resolveTask` join
these two collections server-side on every read.
```js
// Task — the placement
{
  _id,
  taskListId,
  companyId,
  definitionId,      // ref TaskDefinition, required
  projectedMinutes,  // this placement's *override* of the definition's default; null = inherit
  order,
  isActive: bool,
  scheduledDays,     // 0=Sun..6=Sat — which days this task is expected; also gates whether
                     //   it actually appears on the Tasks page that day, not just analytics
  successThreshold,  // how many of this week's scheduled days = 100%
}

// TaskDefinition — the catalog entry (name/icon/type/fields/NFC binding)
{
  _id,
  companyId,
  templateId,        // ref TaskTemplate this was cloned from, informational only, null for custom tasks
  name,              // 'Walk-in Fridge Temp'
  icon,              // lucide icon key, e.g. 'refrigerator' — see components/AppIcon.tsx
  taskType: 'form' | 'standard' | 'stopwatch' | 'checkbox',
  // form = the only creatable type — a structured checklist item, see formFields below
  // standard/stopwatch/checkbox = retired personal-habit timer types, kept only for schema
  //   compatibility with pre-pivot data — nothing in the UI creates them anymore
  formFields,        // FormFieldDef[] — only populated for form: { key, label,
                     //   type: 'number'|'text'|'boolean'|'checklist', unit?, min?, max?, items? }
                     //   checklist = one or more to-do sub-items (items) that must all be
                     //   checked to save, distinct from a single yes/no boolean answer
  projectedMinutes,  // default time budget; a placement's own projectedMinutes overrides it
  nfcTagUid,         // raw hardware UID of a bound physical NFC tag, scanned in-app; null = no
                     //   binding. Completing this task then requires a matching "Scan NFC"
                     //   instead of a plain Save — see docs/features/nfc.md's "In-app
                     //   scan-to-complete binding". Distinct from the separate NfcTag
                     //   collection used for tap-to-trigger. Binding lives here, one layer
                     //   above any single placement, so every list a task is placed in
                     //   shares the same tag.
  instructionSteps,  // up to 3 manager-authored { description, imageUrl } steps showing what the
                     //   finished result should look like — see
                     //   docs/features/task-completion-instructions.md. Same layer as formFields.
  requiresPhoto,     // bool, default false — whether an employee must attach a completion photo
                     //   before a "done" write for this task is accepted, enforced server-side —
                     //   see docs/features/task-completion-photo.md. Same layer as formFields/
                     //   instructionSteps, applies to every taskType.
  isActive: bool,    // soft-delete — blocked while any active Task placement still references it
}
```

### TaskLog
Activity-level — scoped to the company AND location for tenant isolation
(see docs/features/locations.md), with performedByUserId recording who
actually did it. Any employee on shift can complete a given task, so
uniqueness is one log per task per day for the whole location
(`companyId + locationId + taskId + date`), not per user — and, since the
task catalog stays shared company-wide, not per company alone either (two
locations both running the same shared list get independent logs).
```js
{
  _id,
  companyId,
  locationId,       // string | null — see docs/features/locations.md; null only for pre-Locations rows
  performedByUserId,
  taskId,
  date,             // YYYY-MM-DD
  actualMinutes,    // null if skipped
  state: 'in_progress' | 'paused' | 'done' | 'missed' | 'rest',
  // 'missed' = breaks streak, honest record
  // 'rest'   = retired (see "Skip Types" below) — legacy value only, kept in the
  //            type for any pre-existing TaskLog document that already has it;
  //            no code path can write a new one
  startedAt, pausedSeconds, sessionTaskListId, // timer bookkeeping — see docs/features/timer.md
  formData,         // { [fieldKey]: string | number | boolean } — captured field values for a form task
  photoUrl,         // string | null — Blob URL of the employee-captured completion photo, set only
                    //   when the completing write actually included one — see
                    //   docs/features/task-completion-photo.md
  note,             // optional manual back-entry note
  isBackEntry: bool,
  createdAt
}
```

### Todo
Standalone quick-capture to-do, unrelated to any task list or goal concept —
see `docs/features/todos.md`. Activity-level: scoped to the company and to
the specific user who created it (still personal, no shared/assigned
concept yet).
```js
{
  _id,
  companyId,
  userId,
  name,
  scheduledDate,     // YYYY-MM-DD
  done: bool,
  completedAt,
  estimatedMinutes,
  note,
  order,
  createdAt
}
```

### InventoryItemType / InventoryGroup / InventoryLog
A top-up count tracker, not a decrement ledger — nothing ever automatically
subtracts a count when a task completes. Ownership-level catalog entry plus
an append-only activity-level log — see `docs/features/inventory.md`.
```js
// InventoryItemType — the manager-defined catalog entry
{
  _id,
  companyId,
  name,              // 'Toilet Paper', 'Cases of Meat'
  unit,              // free-text display label ('rolls', 'cases', 'lbs') — display only, null = none
  parLevel,          // number | null — read at request time for the below-par red-tint/warning
                     //   cascade (item -> group), see docs/features/inventory.md's "Par-level alerting"
  groupId,           // ref InventoryGroup, or null = the implicit "Ungrouped" bucket — one group per
                     //   item, see docs/features/inventory.md's "Grouping"
  nfcTagUid,         // raw hardware UID of a bound physical tag, or null — see docs/features/nfc.md's
                     //   "Multi-target binding". Optional; by default (nfcRequiredToLog: false) never
                     //   GATES logging a count — a shortcut/verification, not a requirement — but see next.
  nfcRequiredToLog,  // bool, default false — manager opt-in per item. When true, logging a count DOES
                     //   require a matching scan (POST /api/inventory-logs -> 409 otherwise), the same
                     //   way TaskDefinition.nfcTagUid always gates task completion. See
                     //   docs/features/inventory.md's "NFC enforcement".
  createdByUserId,
  isActive: bool,    // soft-delete/archive — same convention as TaskDefinition.isActive
}

// InventoryGroup — a manager-defined organizational label ("Freezer," "Bar," "Dry Storage")
{
  _id,
  companyId,
  name,
  createdByUserId,
  isActive: bool,    // archiving does NOT archive its items — every member InventoryItemType's groupId
                     //   is set back to null ("Ungrouped") as part of the same request
}

// InventoryLog — one count entry, append-only (a correction is a new row, never an edit)
{
  _id,
  companyId,
  itemTypeId,        // ref InventoryItemType
  count,
  loggedByUserId,
  loggedAt,
  verifiedNfcUid,    // set only when this save's NFC scan matched the item type's own nfcTagUid; else null
}
```

### TaskInventoryLink
Optional join connecting a `TaskDefinition` to an `InventoryItemType`, so
completing that task also captures an inventory count in the same flow —
see "Task ↔ Inventory Linking" in `docs/features/inventory.md`.
```js
{
  _id,
  companyId,
  taskDefinitionId,  // ref TaskDefinition — lives at the definition level, shared by every list placement
  itemTypeId,        // ref InventoryItemType
  required: bool,    // a property of the PAIRING — the same item type can be required on one task, optional on another
}
```

### JobTag
Company-level catalog entry for job-function labels ("Server," "Cook,"
"Busser," "Host") — see "Job tags" in `docs/features/locations.md` and
"Job Tags catalog" in `docs/features/admin-console.md`. Assigned to a
`User` by name (`User.jobTags: string[]`, not a ref) from the Admin
Console's Team page; not yet read by any task-list-visibility logic.
```js
{
  _id,
  companyId,
  name,              // 'Server' — renaming cascades onto every User.jobTags entry holding the old name
  createdByUserId,
  isActive: bool,    // archiving strips this tag from every User.jobTags array that held it (no
                     //   "Ungrouped"-style fallback the way InventoryGroup has one)
}
```

### PushToken / MissedListAlert
Back the two shift-window alert types — see "Notifications" below and
`docs/features/notifications.md`.
```js
// PushToken — one row per device (not per user), a standing registration
// for ordinary remote notifications, distinct from User's own ephemeral
// liveActivityPushToken (tied to a single running timer's Live Activity).
// Registered by any signed-in company user (manager or employee) — not
// role-gated at registration time; "missed" alerts filter to managers only
// when fanning out, not by restricting who can hold a token.
{
  _id,
  userId,
  companyId,
  token,             // unique — a reinstalled app re-registers the same physical device under a
                     //   fresh token; the old row is pruned lazily on a BadDeviceToken APNs response
  environment,       // 'sandbox' | 'production' — hardcoded to 'sandbox' server-side (not trusted from
                     //   the client, but also not inferred from NODE_ENV — that was tried and was
                     //   backwards, see docs/features/notifications.md's "Device registration"); stays
                     //   'sandbox' until App.entitlements' aps-environment becomes build-config-dependent
  platform,          // 'ios'
  lastSeenAt,
}

// MissedListAlert — one row per (company, list, day) the MISSED alert actually fired; exists purely
// to make the missed-list sweep idempotent (unique index on companyId+taskListId+date) and doubles
// as an audit trail. Start-time reminders (see "Notifications" below) need no equivalent table — each
// fire of a list's own QStash schedule is already a distinct, non-repeating occurrence by construction.
{
  _id,
  companyId,
  taskListId,
  date,              // YYYY-MM-DD, company-local
  sentAt,
}
```
`TaskList.qstashScheduleId` (see the TaskList model above) is the other
half of start-time reminders' own dedup-equivalent — the QStash schedule
ID itself, not a per-fire row.

---

## Multi-Tenancy

Every restaurant, gym, or hotel using Ch'rps is a `Company` — the tenant
anchor. Nothing in the Company model or its surrounding code is
restaurant-specific; gyms and hotels are expected customers too.

- **Ownership-level** collections (`TaskList`, `Task`, `TaskTemplate`,
  `InventoryItemType`, `InventoryGroup`) scope by `companyId` — they're the
  company's shared configuration, not any individual's data.
- **Activity-level** collections (`TaskLog`, `TaskListSession`,
  `InventoryLog`) scope by `companyId` *and* stamp a `performedByUserId`/
  `loggedByUserId` as an attribute, not part of the uniqueness key — any
  employee on shift might complete a given task or log a count, so the
  record is shared per task/day (or, for `InventoryLog`, just appended),
  not per person.
- `Todo` is scoped by both `companyId` and `userId` — still personal, but
  tenant-isolated.
- `AppIntentLink` stays scoped only to the specific user — it tracks which
  person's Shortcut is connected to a task, not company configuration.

**v1 still has no self-serve company *creation* UI** — a company's very
first manager is manually attached to a pre-created `Company` document
directly in MongoDB by the developer. Every *subsequent* member joins
through an in-app invite instead: a manager generates a link (`POST
/api/invites`) scoped to a company and a preset role, shares it
out-of-band, and opening it (`/invite/[token]`) is what attaches
`companyId`/`role` to that person's `User` document — see "Team & Invites"
below and `docs/features/team-invites.md`. `User.role`
(`'manager' | 'employee' | null`) defaults to `'manager'` on signup.
Managers also get real, in-app-built role-switching UI on the Team tab
(`PATCH /api/team/[userId]`) and can remove a teammate from the company
entirely (`DELETE /api/team/[userId]`, which sets `companyId`/`role` back
to `null` — the same "not yet provisioned" state as a brand-new sign-up).
Hand-editing a `User` document directly in MongoDB still works and is still
the only path for a company's first manager.

`companyId`/`role` are resolved fresh from the `User` document on every
request (see `lib/session.ts`'s `resolveSessionUser()`), never cached on the
JWT — so a hand-edited company/role assignment takes effect on the very next
request instead of waiting for a new sign-in. A `null` companyId means "not
yet provisioned" and must always be treated as no access, never as its own
shared tenant — every route checks for it explicitly before scoping any
query.

`companyId` fields are plain `String`, not `ObjectId` refs — same reasoning
as the pre-existing `userId` fields they replaced: they carry whatever
string a session or API key resolves to, and `SKIP_AUTH`'s local dev company
id isn't a valid ObjectId at all.

---

## Team & Invites

A **Team** tab (bottom nav) shows every company member's roster to any
signed-in company user; adding a new member is invite-token-only, never a
directory search across every Ch'rps company. A manager generates a link
from the Team tab (`POST /api/invites`), preset to a role and to either
`maxUses: 1` ("just this person") or a reusable cap; sharing and opening
that link is the only way `companyId`/`role` get attached to a new `User`
— see the `Invite` model above. Managers can also change a teammate's role
or remove them from the company (`PATCH`/`DELETE /api/team/[userId]`) —
both block rather than round-trip and fail if they'd leave the company with
zero managers, a lockout state nobody could recover from through the UI.

Full detail — redemption flow, API shapes, the bottom-nav layout change,
and deferred items (email-locked invites) — is in
`docs/features/team-invites.md`.

---

## Task Lists

Beyond the three seeded shift lists (Opening/Mid-Shift/Closing) and the
auto-provisioned "Anytime Tasks" list, a manager (`User.role === "manager"`)
can:

- **Create** a new task list from the Tasks page's "+ Add Task List" button
  — name and optional start time (blank = a never-collapsing anytime list),
  then straight into the same browse-catalog-or-build-custom flow used for
  any other task list to add its tasks.
- **Rename** an existing task list, and **set its day-of-week schedule**,
  from that list's edit page (`PATCH /api/task-lists/[taskListId]`).
  Changing a list's `scheduledDays` pushes that value down onto (overwrites)
  every `Task` currently in the list — a manager turning Sunday off for the
  whole list doesn't need to edit each task by hand. This always overwrites,
  even a task customized independently before — simplest option to build,
  documented as a deliberate choice, not a bug; a task can still be
  reopened and re-customized afterward on top of the new default (a
  default-then-override relationship, not a hard lock), it just doesn't
  survive the *next* list-level schedule change.
- **Delete** a task list — a **soft delete** (`TaskList.isActive: false`),
  consistent with the existing per-task soft-delete convention, so its
  `TaskLog`/`TaskListSession` history is preserved even after it's removed
  from the active Tasks page.

Create/rename/schedule/delete are all manager-only server-side (`403` for
an employee) — see `docs/api/task-lists-api.md`.

**Day-of-week visibility**: a `Task`'s own `scheduledDays` now gates whether
it actually renders on the Tasks page for a given date (`lib/task-visibility.
ts`), not just its weekly-analytics streak dot as before. Since a list-level
schedule change pushes its `scheduledDays` down onto every task in it, a
not-scheduled list's tasks disappear for the day as a direct consequence —
no separate list-level visibility check needed. A task still shows despite
its list being off that day only if it was individually re-edited afterward
to include that day. This is a deliberate simplification: it applies to
every task uniformly, including ones with a schedule set before this feature
existed. The missed-shift-list-alert sweep (`app/api/cron/check-missed-lists`,
see "Notifications" below and `docs/features/notifications.md`) honors this
same `scheduledDays` check — a list with nothing scheduled today is skipped
entirely, same as it not rendering on the Tasks page.

See `docs/features/task-lists.md` for the full detail.

---

## Inventory

A **top-up count tracker**, not a decrement ledger — nothing in the app
ever automatically subtracts from an inventory count when a task is
completed (considered and rejected: "clean bathroom" doesn't reliably mean
"minus 4 rolls of toilet paper," and a count that drifted out of sync with
reality is worse than no count at all). A manager defines item types
(toilet paper, cases of meat...); anyone logs the *current* count when they
check/restock; that's the whole loop. Its own bottom-nav tab (5th slot,
after Reports) — see "Current App State" below.

Item types are organized into manager-defined **groups** ("Freezer," "Bar,"
"Dry Storage" — `InventoryGroup`, one per item, nullable = the implicit
"Ungrouped" bucket), and a `parLevel` drives a **below-par red-tint/warning
cascade** (item row → group header) computed at read time from each item's
latest logged count — see "Grouping" and "Par-level alerting" in
`docs/features/inventory.md`.

Uses the multi-target NFC binding model (`docs/features/nfc.md`'s
"Multi-target binding"): an `InventoryItemType.nfcTagUid` binds to a
**storage location**, not exclusively to that item type — the same
physical tag can (and often will) also be bound to a `TaskDefinition` at
the same location (e.g. the walk-in freezer's tag backing both "Log
Freezer Temperature" and "Meat Inventory Count"). By default, binding a tag
to an item type never gates logging a count the way a bound
`TaskDefinition` gates task completion — it's a shortcut/verification layer
only, manual entry always works, tag or no tag — **unless** a manager opts
that specific item into `nfcRequiredToLog`, at which point a matching scan
*is* required, mirroring `TaskDefinition`'s own enforcement exactly. See
"NFC enforcement" in `docs/features/inventory.md`.

A manager can also **link** one or more `InventoryItemType`s directly to a
task (`TaskInventoryLink` — see the Data Models section above), so checking
that area captures a count in the same flow — e.g. "Clean Bathroom" linked
to Toilet Paper, Soap, and Paper Towels, each independently marked required
or optional. When a task and a linked item share the same physical tag, one
NFC scan verifies both — no second scan. See "Task ↔ Inventory Linking" in
`docs/features/inventory.md`.

A manager-only **"Manage Inventory" hub** (`/inventory/manage`, reached from
the Inventory tab's bottom "Manage" button and a Profile page card, same
two-entry-point convention as `/tasks/manage`) is where item name/unit/
parLevel/group editing, NFC tag sync, and Groups CRUD all live — search +
"Scan to Find" included. The item detail/log screen
(`components/InventoryItemDetailView.tsx`) keeps a lightweight pencil
"Edit" icon in its own header, right under the top nav's profile icon, that
opens the same editor sheet without leaving the log-count flow.

Full detail — data model, roles, UI structure, task linking, and open
questions (par-level alerting, Reports integration) — is in
`docs/features/inventory.md`.

---

## Notifications

Two independent push alerts, structurally different mechanisms:

- **Start-time reminders** — fires at a shift-window `TaskList`'s exact
  `startTime`, via its own standing **per-list QStash schedule** (a cron
  expression with a `CRON_TZ=<company.timezone>` prefix, deterministically
  IDed `tasklist-<listId>` and stored on `TaskList.qstashScheduleId`) —
  not a poll. Skips silently if nothing's scheduled that day or everything's
  already done. Reaches **managers and employees** — a nudge to whoever's
  on shift.
- **Missed** — the list's derived end time (`startTime` + today's
  projected minutes) + a manager-configurable grace period
  (`Company.missedAlertGraceMinutes`, default 30, company-wide for every
  shift-window list — set from Profile > Company Settings, `null` turns
  missed alerts off entirely) has passed with any of today's scheduled
  tasks still not in a terminal state (`done`/`missed`). Driven by
  a single **shared recurring QStash sweep** (`POST
  /api/cron/check-missed-lists`, every 5 minutes — a poll, since "closed
  *around* N minutes ago" doesn't need to-the-minute precision). Reaches
  **managers only** — an escalation.

These use genuinely different QStash primitives on purpose: a poll rounds
to its own interval, and "starts now" read oddly arriving several minutes
early or late, so start-time reminders get one exact schedule per list
instead (`lib/qstash-schedules.ts`'s `upsertStartTimeSchedule`/
`deleteStartTimeSchedule`, wired into task-list create/update/delete/
duplicate and into a company-timezone change on Company Settings, since
every existing schedule's `CRON_TZ` goes stale otherwise). Both routes'
only auth boundary is verifying QStash's own request signature, since
neither has a user session. `Company.timezone` (see "Data Models" above)
is what lets both mechanisms ask "has this actually happened yet?"
independent of server UTC or any device's own offset — a company with no
timezone set is skipped by the sweep, and `upsertStartTimeSchedule`
refuses to create a schedule without one. `Company.notificationsEnabled`
is a single company-wide kill switch: the sweep filters disabled companies
out entirely, while `task-list-reminder` checks the flag at send time
instead (schedules keep firing regardless — not worth the QStash churn of
deleting/recreating every list's schedule on every toggle). Any signed-in
company user's device registers a standing `PushToken` (distinct from
`User.liveActivityPushToken`'s ephemeral, single-timer token) via
`@capacitor/push-notifications` — registration itself isn't role-gated,
since start-time reminders reach employees too; "missed" stays
manager-only via its own query filter at send time, not a
registration-time restriction. `MissedListAlert` makes the sweep
idempotent (write-then-send: the dedup row is written before the push
fan-out) and doubles as an audit trail — start-time reminders need no
equivalent table, since each QStash fire of a per-list schedule is
already a distinct, non-repeating occurrence by construction.

The missed-list window math lives in `lib/task-list-window.ts`:
`deriveCollapseAfter`/`isPastWindow`/`isBeforeWindow` are shared between
the sweep and `components/TaskListCard.tsx`'s own client-side collapse
logic — one pure function, multiple callers, same pattern as
`lib/task-progress.ts`/`lib/placement-resolution.ts`. `isPastGraceWindow`/
`DEFAULT_MISSED_LIST_GRACE_MINUTES` are sweep-only (the client card has no
grace-period concept) and take the caller's resolved per-company
`Company.missedAlertGraceMinutes` rather than one flat constant.

Deferred beyond v1: par-level inventory alerts (same missed-list QStash
infra, a different trigger — natural fast-follow), a **per-list**
configurable grace period for the missed alert (built at the company
level — see `Company.missedAlertGraceMinutes` above — but still one value
for every shift-window list within a company), email fallback for a user
who never grants push permission, per-user/per-alert-type mute, and
reconciling schedule drift (nothing re-verifies a list's
`qstashScheduleId` still matches a live QStash schedule). QStash's
free-tier 10-active-schedule cap is also worth watching — every
shift-window list consumes one. Full detail — data model, both
mechanisms, push payload shape, and failure handling — is in
`docs/features/notifications.md`.

---

## Locations

One company can now run multiple physical stores — a new `Location` model,
one-to-many under `Company` (see "Data Models" above and
`docs/features/locations.md`). Deliberately narrow scope: one company, many
locations, never "one login, many companies" (a separate business still
needs its own `Company`).

Adds a third `User.role` tier, `owner` — a strict superset of `manager` that
sees/administers every `Location` under their company rather than just
one, computed at read time rather than stored. `owner` is assigned by hand
in MongoDB only, never through any in-app flow. Every former
`role !== "manager"` gate across the app now reads `!isManagerOrAbove(role)`
(`lib/roles.ts`/`lib/session.ts`).

`User.locationId` is an employee/manager's one and only visible location,
stamped at invite redemption from the invite's own `locationId` (itself
stamped from the inviting manager's `locationId`, or picked explicitly by
an owner). `TaskLog`/`TaskListSession`/`InventoryLog`/`MissedListAlert` all
gained a `locationId` field and their lookup/uniqueness indexes were
updated to include it, so two locations running the same shared task-list
catalog never collide into one location's data.

Also adds a second, independent axis on `User` — `jobTags: string[]`
(server/cook/busser/host/…), assignable via a company-level `JobTag`
catalog managed from the Admin Console's Team page (see "Job Tags
catalog" in `docs/features/admin-console.md`) — for a future task-list-
by-job-function *targeting* pass that isn't built yet (a tag is currently
pure metadata, not read by any task-list-visibility check).

An owner now gets a real **location switcher** — a control on all 4
bottom-nav pages (Tasks, Team, Reports, Inventory) to pick which location's
data they're viewing (and, on Tasks, acting against), persisted server-side
on `User.activeLocationId` (not a URL param or browser storage). Team is
the one page where a `null` selection means "no filter, show the whole
company" rather than falling back to the owner's own location — its
roster has never been location-scoped before this, so that default
preserves existing behavior for anyone who hasn't touched the switcher.
Full detail — permissions audit, migration script, notification fan-out
changes, the switcher's own resolution rules, and every other open gap —
is in `docs/features/locations.md`.

---

## Feature Build Order

### Phase 1 — Task Lists (built)
- [x] MongoDB connection + Mongoose models
- [x] Auth (Google OAuth via Auth.js)
- [x] Multi-tenant Company/User model, session-resolved companyId/role
- [x] Seed default shift task lists + tasks on first company load
- [x] Today view: shift task lists (Opening/Mid-Shift/Closing), time-aware collapse/expand
- [x] Task card: tap to expand actions (Start task / Missed it) — a "Rest+Life" skip option existed here too until it was retired, see "Skip Types" below
- [x] Form task screen: one control per field (number reading or yes/no), actual time logged on save
- [x] TaskLog write on complete/skip, including captured `formData`
- [x] 7-day streak dots per task
- [x] Back-entry: manual log when a list's window has passed
- [x] Task List Session flow (multi-task guided walkthrough) — see docs/features/timer.md
- [x] Reports tab (renamed from Analytics) — task completion, variance, plus a manager/employee role split and a Logs history sub-tab — see docs/features/reports.md
- [x] Standalone To-Dos — see docs/features/todos.md
- [x] Live Activity (iOS Lock Screen timer) — see docs/features/live-activity.md
- [x] Manager-created/renamed/deleted task lists + list-level day-of-week scheduling — see "Task Lists" above
- [x] NFC tap-to-trigger tasks (Universal Links) — see docs/features/nfc.md
- [x] In-app NFC scan-to-complete task binding (distinct from the above) — see docs/features/nfc.md
- [x] Team tab + invite-token-only company joining, manager role-switching/removal — see "Team & Invites" above and docs/features/team-invites.md
- [x] Multi-target NFC binding (a tag can back more than one task/item type, with FAB-scan disambiguation) — see docs/features/nfc.md's "Multi-target binding"
- [x] Inventory tab (top-up count tracker, not a decrement ledger) — see "Inventory" above and docs/features/inventory.md
- [x] Task ↔ Inventory Linking (a task can capture one or more Inventory counts as part of its own form, with shared NFC verification when a tag backs both) — see "Inventory" above and docs/features/inventory.md's "Task ↔ Inventory Linking"
- [x] Inventory grouping, par-level red-tint/warning cascade, per-item `nfcRequiredToLog` enforcement, and the manager-only "Manage Inventory" hub — see "Inventory" above and docs/features/inventory.md
- [x] Shift-window alert push notifications — "start-time reminders" (per-list QStash schedule, managers+employees) and "missed" (shared QStash sweep, managers) — device registration for any company user, Company timezone/notificationsEnabled — see "Notifications" above and docs/features/notifications.md
- [x] Self-service account deletion (App Store Review Guideline 5.1.1(v)) — a
      "Delete Account" row on Profile for `employee`/`manager` scrubs PII off
      their `User` document (name/email/image, company/location detach,
      passwordHash, push tokens) and kills their session, while every
      `TaskLog`/`TaskListSession`/`InventoryLog` they created stays put,
      still attributed to the company/location; `owner` is blocked
      self-service and shown a contact-support message instead (billing
      contact, sole company administrator) — see
      docs/features/account-deletion.md
- [x] Admin Console (desktop) — a separate `app/(console)/console/**` route group, manager-or-above gated (originally owner-only): a net-new cross-location Rollup Dashboard (`GET /api/reports/rollup`, `lib/reports.ts`) as the console's own homepage (`/console` itself — Locations CRUD, its original Phase 1a slice, was later removed entirely, and Rollup moved off its own `/console/rollup` route to take that spot), a company-wide Team & Access table (with the location-reassignment wiring mobile's Team tab never had) and a Job Tags catalog, Task & Task List Management (`/console/tasks` — the same task-list/task CRUD as mobile's `ManageTasksView.tsx`/`TaskListEditView.tsx`, reused APIs, no NFC scan action, plus a Task Catalog pane for editing/creating/deleting a saved task independent of any list placement), a desktop-shaped single-location Reports page (`/console/reports` — new presentational components over the same `GET /api/reports`/`/api/reports/leaderboard`/`/api/reports/inventory`/`GET /api/task-logs/history` mobile uses, replacing the Rollup Dashboard's old row-click jump into mobile's phone-width `/reports`), and an Inventory Management page (`/console/inventory` — item-type/group catalog CRUD + log-a-count, no NFC anywhere: an item with `nfcRequiredToLog` set from mobile 409s here with console-specific copy) — reached from a manager-or-above "Admin Console" card on the Profile page (no auto-redirect on login); Team & Access and the Rollup Dashboard homepage stay owner-only and self-gate now that the blanket layout gate loosened — see docs/features/admin-console.md, docs/features/console-task-management.md, docs/features/console-reports.md, and docs/features/console-inventory.md
- [x] Task Completion Instructions (manager-authoring side) — a manager
      attaches up to 3 steps (photo and/or caption) to a `TaskDefinition`
      from its Company Task Catalog detail sheet
      (`components/ManageTaskDetailSheet.tsx`'s "Instructions" section),
      showing what the finished check should look like; images upload
      straight from the browser to Vercel Blob via a client-upload token
      (`app/api/blob/upload/route.ts`), text lives on
      `TaskDefinition.instructionSteps` in MongoDB. The employee-side
      "attach a photo to complete the task" half is a separate, later
      piece — see docs/features/task-completion-instructions.md and, for
      that later piece, docs/features/task-completion-photo.md
- [x] Task Instructions — Employee View — a read-only "Instructions" button
      under the task's title/name on every screen a task appears on: the
      collapsed list row (`TaskRow.tsx` for shift-window tasks,
      `TaskCard.tsx` for anytime tasks) AND the active-task screens
      (`TaskFormScreen.tsx` — standalone and embedded in
      `TaskListSessionView.tsx`'s guided session — and the retired
      `TimerScreen.tsx`), shown only when that task has at least one
      manager-authored instruction step; opens `TaskInstructionsSheet.tsx`
      (image-forward steps, no edit affordances). Not a gate on
      completion, no per-employee dismiss state — see
      docs/features/task-instructions-employee-view.md. The employee
      *photo-capture-on-completion* half is now built separately — see
      docs/features/task-completion-photo.md.
- [x] Manage Tasks Task Lists / Task Catalog toggle (mobile) — a top-level
      segmented control on `/tasks/manage` (mirroring the Admin Console's
      `TaskManagementView.tsx`) splits the screen into a Task Lists tab
      (Task Lists + Standalone Tasks, unchanged) and a Task Catalog tab
      (Company Task Catalog on its own full-width screen, with "Scan to
      Find" now catalog-tab-only) — see
      docs/features/manage-tasks-tabs.md
- [x] Instruction Steps — Camera Capture — the "+ Add Step" editor's
      file-picker input is replaced with a direct device-camera capture
      (`@capacitor/camera`, `lib/client/capture-image.ts`'s shared, reusable
      `capturePhoto()` helper), plus the `validUntil`/size-cap bumps on
      `POST /api/blob/upload` a live camera flow needs over an
      already-chosen file — see
      docs/features/instruction-steps-camera-capture.md
- [x] Task Completion — Required Photo — the employee-side half of the
      two-sided photo feature: a manager toggles "Require Photo at
      Completion" per `TaskDefinition`
      (`components/ManageTaskDetailSheet.tsx`, alongside its Instructions
      panel), and an employee must attach a completion photo via the
      shared `components/TaskPhotoCaptureButton.tsx` (reusing
      `capturePhoto()` and a newly-shared `lib/client/upload-image.ts`)
      before Done becomes tappable on `TimerScreen.tsx`,
      `TaskFormScreen.tsx`, and `TaskCard.tsx`'s back-entry mode.
      Server-enforced (not just a disabled button) at every `state: "done"`
      write boundary via `lib/task-log-actions.ts`'s
      `assertPhotoProvided` — see docs/features/task-completion-photo.md
- [x] Unified Task Edit Surface (Task Lists ↔ Task Catalog) — a manager
      opening a task from either tab of `/tasks/manage` now sees the same
      field set: Instructions and "Require Photo at Completion" (previously
      Task Catalog-only, in `ManageTaskDetailSheet.tsx`) are now also on a
      Task Lists placement row's inline edit form
      (`TaskListEditView.tsx`'s `SortableRow`), and Name/Icon/Form Fields/
      Estimated Time and Linked Inventory (previously Task Lists-only) are
      now also on the Task Catalog's detail sheet. Scan-to-complete NFC
      binding was already dual-editable and is unaffected. Scheduled days/
      success threshold stay Task Lists-only, since they're inherently a
      placement concept with no list to attach to from the catalog. The
      four fields that were always definition-level regardless of entry
      point (NFC, Instructions, Require Photo, Linked Inventory) are now
      backed by shared client hooks
      (`lib/client/use-task-definition-panel.ts`,
      `lib/client/use-inventory-links.ts`) and shared presentational
      components (`components/task-panels/*.tsx`) instead of two
      hand-duplicated implementations, all calling definitionId-scoped
      routes (`PATCH /api/task-definitions/[id]`,
      `POST/DELETE /api/task-definitions/[id]/nfc-tag`, and a new
      `GET/POST /api/task-definitions/[id]/inventory-links` +
      `PATCH/DELETE .../inventory-links/[itemTypeId]` pair mirroring the
      existing placement-keyed inventory-links routes) — see
      docs/features/unified-task-edit-surface.md

Personal-habit-tracker features from before the restaurant pivot — the
timer-based Countdown/Stopwatch/Checkbox item types and the Sunday "Routine
Review" goal-vs-average-minutes comparison — have been retired. Future
phases (Goals, Virtues, Quotes) from the original "A Good Man" brief were
stripped out even earlier and are not planned here either. The recurring
"every thirty minutes" task-frequency concept is a distinct, unbuilt future
feature, not part of anything above. The native App Intents/Shortcuts
"Trigger Habit" action and the API-key-authenticated external API it (and
NFC's old silent-trigger flow) depended on were built, then later removed
entirely — not deprecated in place — since Shortcuts integration wasn't
considered load-bearing and the whole surface shared an unfixable gap with
`form`-type tasks; see `docs/project-structure.md`'s "iOS Native Shell"
section for the full removal note.

---

## Task Behavior Rules

### Time-Aware Collapse
- Each TaskList has a `startTime`; the list auto-collapses once its
  projected total run time has elapsed past that start time
- Collapsed state shows: list name, dot summary, time-warning badge
- Expanding a past-window list shows a "Back-entry" banner above tasks
- Custom lists do not auto-collapse

### Skip Types
One skip state, an honest record of not doing it:

**Missed it** (`state: 'missed'`)
- User forgot, chose not to, couldn't be bothered
- Breaks streak — red dot in history
- Honest record of not doing it

A restaurant work task has no personal "rest day" concept — a shift check
either got done or it didn't, so there is no protected/excused skip state.
`'rest'` (a remnant of this app's pre-pivot personal-habit-tracker
foundation — see "Vision" above) has been retired: no UI can create a new
`TaskLog`/`TaskListSession` entry with this state anymore (enforced at
`POST /api/task-logs`), and every calculation (streaks, weekly progress,
Reports aggregates) now treats it the same as "no log at all," not as a
protected success. `models/TaskLog.ts`'s `LogState` type (and
`models/TaskListSession.ts`'s `CompletionState`) keep `'rest'` as a listed
value purely so a pre-existing document that already has it stays
type-safe to read/display — no historical data was migrated or deleted.

### Variance Tracking
Every TaskLog with `state: 'done'` stores `actualMinutes`, and — for a
`form` task — the captured `formData` (each field's reading or yes/no
value). Over time this builds a picture of projected vs actual time per
task, and a record of what was actually checked. The Reports tab's Overview
shows average actual vs projected per task, identifying where tasks
consistently over/under-run their time budget.

---

## Default Seed Data

Every seeded task is `taskType: 'form'` with its own `formFields`
(number readings or yes/no checklist entries) — see `lib/seed-templates.ts`
for each task's exact fields.

Icons are lucide icon keys (`components/AppIcon.tsx`'s `ICON_MAP`), not
emoji — the app renders a clean, monochrome icon set, not colorful pictorial
glyphs. Raw emoji only ever appears as a graceful fallback for legacy data
AppIcon doesn't recognize.

### Opening Shift
| name | icon | projectedMinutes |
|---|---|---|
| Walk-in Fridge Temp | `refrigerator` | 2 |
| Walk-in Freezer Temp | `snowflake` | 2 |
| Handwashing Stations Stocked | `droplets` | 3 |
| Floors & Surfaces Clean | `spray-can` | 5 |
| Opening Cash Count | `banknote` | 5 |
| Staff Uniform & Hygiene | `shirt` | 3 |
| Opening Walkthrough | `clipboard-check` | 5 |

### Mid-Shift
| name | icon | projectedMinutes |
|---|---|---|
| Line Temp Check | `thermometer` | 3 |
| Restock Check | `package` | 5 |
| Restroom Check | `toilet` | 3 |
| Trash & Recycling | `trash-2` | 5 |

### Closing Shift
| name | icon | projectedMinutes |
|---|---|---|
| Walk-in Fridge Temp (Close) | `refrigerator` | 2 |
| Walk-in Freezer Temp (Close) | `snowflake` | 2 |
| Equipment Powered Down | `power-off` | 5 |
| Deep Clean Kitchen | `sparkles` | 15 |
| Closing Cash Reconciliation | `banknote` | 10 |
| Trash Taken Out | `trash-2` | 5 |
| Doors Locked / Alarm Set | `lock-keyhole` | 3 |

### Anytime Tasks (standalone, never collapses)
| name | icon | projectedMinutes |
|---|---|---|
| Fridge | `refrigerator` | 2 |
| Freezer | `snowflake` | 2 |
| Men's Room | `toilet` | 3 |
| Women's Room | `toilet` | 3 |

See `lib/seed.ts` / `lib/seed-templates.ts` for the source of truth — this
table is a quick reference, not authoritative.

---

## Current App State
- Task Lists: BUILT — Opening/Mid-Shift/Closing shift lists + standalone Anytime Tasks list + manager-created custom lists, time-aware collapse/expand, dot progress, Edit button per list
- Task List Session: BUILT — guided multi-task walkthrough with live projected-finish/timeline
- Reports tab: BUILT — renamed from Analytics; manager sees the company-wide task completion/variance dashboard, employee sees a personal-only Overview (streak + weekly % + charts scoped to self), plus a chronological Logs history sub-tab for both roles, see `docs/features/reports.md`
- To-Dos: BUILT — standalone quick-capture list, shown on the Today view
- Live Activity: BUILT — iOS Lock Screen timer (see `docs/features/live-activity.md`); its Lock Screen button opens the app rather than completing a task directly (see the doc's "Open App button" section)
- Manager task-list management: BUILT — create/rename/schedule/delete, see "Task Lists" above
- NFC tap-to-trigger: BUILT — physical tags linked to a task (manager-only), triggered via Universal Links only by any company user, see `docs/features/nfc.md`
- NFC scan-to-complete binding: BUILT — manager scans a physical tag's raw UID onto a task from Manage Task List; completing that task then requires a matching in-app "Scan NFC" instead of a plain Save, see `docs/features/nfc.md`
- Multi-target NFC binding: BUILT — a tag can back more than one task and/or Inventory item type at once; the FAB's blind scan disambiguates with a picker when a scan resolves to more than one, see `docs/features/nfc.md`'s "Multi-target binding"
- Offline support: BUILT — native SQLite cache mirrors task lists/tasks/definitions/today's logs, task-log mutations (start/complete/miss) queue locally and sync on reconnect, and in-app NFC scan-to-complete resolves against the local cache when offline; a cold app launch/full reload while offline is a known, documented gap (server-URL Capacitor mode), see `docs/features/offline.md`
- FAB button (center bottom nav): resumes the active timer when one exists; otherwise scans an NFC tag and opens whichever task or Inventory item it's bound to, disambiguating first if it's bound to more than one (`components/BottomNav.tsx`, see `docs/features/nfc.md`)
- Team & Invites: BUILT — Team tab roster (everyone) + manager-only invite-link generation/revocation and role-switching/removal, see "Team & Invites" above and `docs/features/team-invites.md`
- Inventory: BUILT — Inventory tab (top-up count tracker), grouped into manager-defined sections with search and a below-par red-tint cascade, manager-managed item-type catalog with optional NFC location binding (and a per-item `nfcRequiredToLog` toggle that turns that binding into an actual gate), plus a manager-only "Manage Inventory" hub (`/inventory/manage`) for name/unit/parLevel/group/tag editing and Groups CRUD, see "Inventory" above and `docs/features/inventory.md`
- Task ↔ Inventory Linking: BUILT — a manager can attach Inventory item types to a task (required or optional per link); the task form then captures a count per linked item on Save, sharing NFC verification with the task's own scan when the tags match, see "Inventory" above and `docs/features/inventory.md`'s "Task ↔ Inventory Linking"
- Task Completion Instructions: BUILT (manager-authoring side) — up to 3 photo/caption steps per `TaskDefinition`, authored from the Company Task Catalog detail sheet via a direct device-camera capture (`lib/client/capture-image.ts`'s `capturePhoto()`, not a file picker — see `docs/features/instruction-steps-camera-capture.md`), images stored in Vercel Blob (`app/api/blob/upload/route.ts`) via a direct upload call (`lib/client/upload-image.ts`'s `uploadImageDirect` — not `@vercel/blob/client`'s `upload()`, which silently masked errors behind retries, see the doc's "Blob upload flow"); employee-side read view also BUILT (see next line); the employee *photo-capture-on-completion* half is now built too, see `docs/features/task-completion-photo.md`
- Task Instructions — Employee View: BUILT — a read-only "Instructions" button under the task title/name on the list row (`TaskRow.tsx`/`TaskCard.tsx`) AND the active-task screens (`TaskFormScreen.tsx`, `TimerScreen.tsx`), shown only when a task has instruction steps, opening `TaskInstructionsSheet.tsx`; not a completion gate, see `docs/features/task-instructions-employee-view.md`
- Task Completion — Required Photo: BUILT — a manager-set `TaskDefinition.requiresPhoto` toggle (`ManageTaskDetailSheet.tsx`) requires an employee to attach a completion photo (`components/TaskPhotoCaptureButton.tsx`) before Done becomes tappable on `TimerScreen.tsx`/`TaskFormScreen.tsx`/`TaskCard.tsx`'s back-entry mode; enforced server-side on every `state: "done"` write (`lib/task-log-actions.ts`'s `assertPhotoProvided`), stored as `TaskLog.photoUrl`. A manager-facing review surface for the captured photo is not built, see `docs/features/task-completion-photo.md`
- Manage Tasks Task Lists/Task Catalog toggle: BUILT — `/tasks/manage` now opens on a Task Lists tab (Task Lists + Standalone Tasks) with a separate full-width Task Catalog tab, matching the Admin Console's segmented-control pattern; search and "Scan to Find" scope to whichever tab is active, see `docs/features/manage-tasks-tabs.md`
- Unified Task Edit Surface: BUILT — a Task Lists placement row (`TaskListEditView.tsx`'s `SortableRow`) and the Task Catalog's detail sheet (`ManageTaskDetailSheet.tsx`) now edit the same field set (Name/Icon/Form Fields/Estimated Time, Scan-to-Complete NFC, Instructions, Require Photo, Linked Inventory) regardless of which one a manager opens a task from — only Scheduled Days/Success Threshold stay Task Lists-only. The four definition-level panels are shared components/hooks (`components/task-panels/*.tsx`, `lib/client/use-task-definition-panel.ts`, `lib/client/use-inventory-links.ts`) calling definitionId-scoped routes, including a new `GET/POST /api/task-definitions/[id]/inventory-links` + `PATCH/DELETE .../inventory-links/[itemTypeId]` pair, see `docs/features/unified-task-edit-surface.md`
- Notifications: BUILT — two independent shift-window alerts: "start-time reminders" fire at a list's exact startTime via its own per-list QStash schedule (managers+employees), "missed" fires 30min past the window's end via a shared QStash sweep every 5min (managers only, tasks still outstanding); device registration via `@capacitor/push-notifications` open to any company user, `Company.timezone`/`notificationsEnabled` drive both, see "Notifications" above and `docs/features/notifications.md`
- Locations: BUILT — `Location` model, new `owner` role tier, invite/team location assignment, Location CRUD API, locationId-scoping across TaskLog/TaskListSession/InventoryLog/MissedListAlert, and an owner-facing location switcher (`components/LocationSwitcher.tsx`) on Tasks/Team/Reports/Inventory; migration script at `scripts/backfill-locations.mjs`. Job tags now have a catalog + assignment UI (Admin Console's Team page — see `docs/features/admin-console.md`'s "Job Tags catalog"), though the tag-based task-list *targeting* they were originally meant for is still not built. NOT built: per-location split of the start-time-reminder cron — see "Locations" above and `docs/features/locations.md`'s "Known gaps"
- Admin Console: BUILT — desktop-first `/console` section (`app/(console)/console/**`, gated manager-or-above in its `layout.tsx`, blocked from the native iOS shell): a Rollup Dashboard (`GET /api/reports/rollup`) as `/console`'s own homepage, giving an owner a cross-location snapshot (completion rate, tasks logged, missed lists, below-par items, active employees) that has no mobile equivalent (Locations CRUD, the console's original Phase 1a page, was removed entirely; Rollup moved off its own `/console/rollup` route to become the homepage in its place), a company-wide Team & Access table + invite panel + Job Tags catalog (create/rename/archive tags, per-teammate toggle assignment), Task & Task List Management (`/console/tasks`, manager-or-above) — a two-pane task-list/task editor reusing mobile's exact APIs and field-editing building blocks, NFC status-only (no scan action), plus a Task Catalog pane for editing/creating/deleting a saved task independent of any list placement — a Reports page (`/console/reports`, manager-or-above) — desktop-shaped stat strip/leaderboard table/task-list grid/Logs table/Inventory card grid, all fed by mobile's exact `GET /api/reports`/`/api/reports/leaderboard`/`/api/reports/inventory`/`GET /api/task-logs/history` responses (new presentational layouts, reused pure math/types from `components/reports/shared.ts`) — and an Inventory Management page (`/console/inventory`, manager-or-above) — grouped item-type table with always-visible log-a-count input + expandable history per row, plus a persistent Manage Groups panel below it; no NFC anywhere (an item with `nfcRequiredToLog` set from mobile 409s here with console-specific error copy, not mobile's "use Save via NFC"). Team & Access and the Rollup Dashboard homepage stay owner-only, each self-gating now that the blanket layout check loosened; Task Management, Reports, and Inventory are the three manager-and-up pages. Reached via a manager-or-above card on the Profile page (`components/ProfileView.tsx`) — login itself still always lands on Tasks, same as every other role — see `docs/features/admin-console.md`, `docs/features/console-task-management.md`, `docs/features/console-reports.md`, and `docs/features/console-inventory.md`

- Account Deletion: BUILT — Profile's "Delete Account" row (`employee`/`manager` only) scrubs PII off the caller's own `User` document, detaches them from their company/location, deletes their `PushToken`s and OAuth account link, and invalidates their session (`DELETE /api/account`, `lib/auth.ts`'s jwt callback); `owner` sees a static contact-support message instead of a button, see `docs/features/account-deletion.md`

Routine Review (the old Sunday goal-vs-average-minutes comparison) has been
retired — it doesn't fit a checklist-based work app.

**Bottom nav** (grew from Tasks/FAB/Analytics to four tabs, two per side,
when Team was added — see `docs/features/team-invites.md`; Analytics was
later renamed to Reports, see `docs/features/reports.md`; the reserved 5th
placeholder slot became Inventory, see `docs/features/inventory.md`):
1. Tasks (left 1) — Today view
2. Team (left 2) — company roster; managers also see Pending Invites + "+ Invite"
3. FAB (center) — active-timer resume indicator, or (when nothing is running) an NFC-scan shortcut to open a bound task or Inventory item directly (disambiguating first if the tag is bound to more than one)
4. Reports (right 1) — task trends, variance, adherence (manager) or personal streak/completion + charts scoped to self (employee), plus an Overview/Logs segmented control
5. Inventory (right 2) — item-type list grouped into sections with search, current counts (red-tinted when at/below par); tap to log a new count or view history; managers also see "+ Add Item Type" and a "Manage" button into `/inventory/manage`

**Top nav:**
- Left: Jackalope logo mark
- Center: app name + date
- Right: Profile avatar (Google icon or initial — opens profile/settings)

---

## UI Reference

### Today View Structure (top to bottom)
1. Top nav: Jackalope left, app name / date center, profile avatar right
2. Date navigator: < Today >
3. Progress counter + progress bar
4. Opening Shift list (collapsible, time-aware)
5. To-dos for the day
6. Mid-Shift list (collapsible, time-aware)
7. Closing Shift list (collapsible, time-aware)
8. "+ Add Task List" button (managers only)
9. Standalone Anytime Tasks list(s)
10. Bottom nav: Tasks / Team / Reports / Inventory

### Task List — Time-Aware Collapse Logic
```
Before startTime                        → collapsed (not yet)
Between startTime and start+projected    → expanded (active window)
Shortly after that window                → expanded with "back-entry" banner (manual logging)
After that                               → collapsed (window passed, dots show summary)
```
User can customize `startTime` per list via the list's Edit screen; a
manager can also set the list's `scheduledDays` there (see "Task Lists"
above).

### Timer Screen
- Full screen takeover
- Ring countdown (SVG circle, stroke animates)
- Color states: olive (on track) → amber (75% elapsed) → burgundy (over target)
- Over-target shows +MM:SS in burgundy
- Pause / Resume / Log buttons

### Task Card States
- **open**: pending, dark card, "Pending" badge, tap expands to actions
- **done**: olive border, "Done" badge, variance shown (+/-Xm)
- **missed**: burgundy border, "Missed" badge
- **rest**: blue-muted border, "Rest" badge — retired (see "Skip Types" above); this state only ever renders for a pre-existing log that already has it, never reachable via any current action

---

## Environment Variables Needed
```
MONGODB_URI=
NEXTAUTH_SECRET=
NEXTAUTH_URL=
GOOGLE_CLIENT_ID=      # if using Google OAuth
GOOGLE_CLIENT_SECRET=  # if using Google OAuth
APNS_KEY_ID=           # Apple Push Notifications Auth Key — see docs/features/live-activity.md
APNS_TEAM_ID=          # X3DPK5Y29G
APNS_PRIVATE_KEY=      # contents of the downloaded .p8 file
QSTASH_TOKEN=              # Upstash QStash — see docs/features/notifications.md
QSTASH_URL=                # Upstash account's REGIONAL endpoint (e.g. https://qstash-us-east-1.
                           #   upstash.io) — required for lib/qstash-schedules.ts's outbound calls
                           #   (creating/deleting a list's start-time reminder schedule); the generic
                           #   https://qstash.upstash.io endpoint 404s/misroutes for some accounts.
                           #   Not needed by the missed-list sweep route itself (inbound-only,
                           #   verifies via signing keys, no outbound QStash API calls)
QSTASH_CURRENT_SIGNING_KEY=
QSTASH_NEXT_SIGNING_KEY=
BLOB_READ_WRITE_TOKEN=    # Vercel Blob — instruction-step and completion-photo storage, see
                          # docs/features/task-completion-instructions.md and
                          # docs/features/task-completion-photo.md. Auto-populated by
                          # Vercel when a Blob store is connected to the project; @vercel/blob's
                          # handleUpload (app/api/blob/upload/route.ts) reads it implicitly.
```

---

## Notes for Claude Code
- Write to the top-level `app/`, `components/`, `lib/`, `models/` directories (no `/src` wrapper)
- Use server components where possible, client components only where interactivity needed
- API routes under `app/api/`
- Keep Mongoose models in `models/`
- DB connection utility in `lib/mongoose.ts`
- Do not use localStorage or sessionStorage — all state lives in MongoDB
- The app should feel native on mobile Safari — test tap targets at 44px minimum
- Seed script should be idempotent (safe to run multiple times)
- Follow the Vocabulary section above for any new code, comments, or UI text —
  "TaskList"/"Task", never "Routine"/"Habit"/"check" as product-concept nouns,
  except the two documented exceptions (external API wire contract, iOS Swift layer)
