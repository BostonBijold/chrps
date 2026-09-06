> **Keep this file updated after any code change in this area — do not let it drift from actual implementation.**

# Account Deletion

**Status: BUILT.**

Apple's App Store Review Guideline 5.1.1(v) requires that any app supporting account creation must also let a user initiate deletion of their account **from within the app**, and that deletion must remove personal data, not merely disable/deactivate the account. Apple's own carve-out is that an app may retain information it needs for legitimate business/legal purposes (the same reasoning banking apps rely on to keep transaction records after account deletion), as long as that's disclosed.

Ch'rps is multi-tenant: the **company** (the `owner`) is the paying customer and owns the operational record — `TaskLog`, `TaskListSession`, `InventoryLog`, and eventually `TimeLog` entries a person creates belong to the business for payroll, compliance, and reporting purposes, not to the individual who tapped the NFC tag. So "delete my account" means **scrub the person, keep the record**: strip personally-identifying fields from `User` and kill their ability to sign back in, while every log they created stays exactly where it is, still attributable to the company/location it happened at.

## Who can self-serve, and who can't

- **`employee` / `manager`** → full self-service in-app deletion (below).
- **`owner`** → **blocked**, by design. The owner is the billing contact (`Company.subscription.stripeCustomerId`, see [`admin-console.md`](admin-console.md) and CLAUDE.md) and, in a single-owner company, the only account that can administer every location. Scrubbing that `User` document doesn't touch Stripe or hand off administration to anyone. Rather than build a "transfer ownership first" flow for a v1 that has no evidence anyone needs it yet, `components/ProfileView.tsx` shows an owner a static message instead of a working delete button:

  > To delete your account and your company's data, contact **contact@usechrps.com**.

  This still satisfies 5.1.1(v) for the owner tier — Apple's guidance recognizes that some account types have unwind implications (subscriptions, dependent data) that need a human in the loop, as long as the app doesn't just hide the request path entirely. The in-app message *is* the initiation step; the actual purge happens manually, by whoever handles that inbox, per [Manual owner deletion](#manual-owner-deletion-support-runbook) below.

## Data model

No new collection. `models/User.ts` has one added field:

```ts
deletedAt: Date | null,   // set by self-service deletion; null for every existing user
```

On deletion (`app/api/account/route.ts`), a single `User` update:

```ts
{
  $set: {
    name: "Deleted User",
    email: `deleted-${_id}@deleted.usechrps.com`,   // adapter's unique index on email means this can't just go null
    image: null,
    companyId: null,
    role: null,
    companyJoinedAt: null,
    locationId: null,
    liveActivityPushToken: null,
    liveActivityPushEnvironment: null,
    passwordHash: null,
    deletedAt: new Date(),
  }
}
```

The `companyId: null, role: null, companyJoinedAt: null, locationId: null` block is exactly the state `DELETE /api/team/[userId]` already leaves a removed teammate in (see [`team-invites.md`](team-invites.md)) — self-deletion is that same company-detach, plus the PII scrub and the login kill-switch below. `lib/session.ts`'s `resolveSessionUser()` needed no change: it already treats `companyId: null` as "not attached to a company," and a scrubbed user is never signed back in with a fresh session to notice.

Alongside the `User` update, the route also:

- Deletes every `PushToken` row for this `userId` (see [`notifications.md`](notifications.md)'s `models/PushToken.ts`) — no more alert pushes to a device that isn't this person's anymore.
- Deletes the NextAuth adapter's `accounts` collection rows for this user (unlinks Google OAuth), keyed by `userId` as an `ObjectId` — same field the adapter's own `deleteUser` uses (`node_modules/@auth/mongodb-adapter`). `passwordHash` is cleared in the same `User` update above rather than a separate step.
- Deletes the adapter's `sessions` collection rows for this user. **Confirmed against `lib/auth.config.ts`: this app runs `session: { strategy: "jwt" }`**, so the adapter's `sessions` collection is never populated in practice (a no-op delete, kept for correctness if that ever changes) — the actual problem is a previously-issued JWT surviving until its own expiry regardless of what's scrubbed in Mongo. `lib/auth.ts`'s `jwt` callback now does a `User.findById(token.id, "deletedAt")` check on every session read and returns `null` when `deletedAt` is set (the documented NextAuth pattern for forcing a session invalid) — `@auth/core`'s session action then clears the session cookie for that response instead of calling `callbacks.session` at all. `middleware.ts` runs its own Edge-only NextAuth instance (`lib/auth.config.ts`, no MongoDB access, so no `deletedAt` check there) and won't itself reject a stale-but-cryptographically-valid JWT — but the very next request that reaches a Node-runtime route/page (which all data-bearing routes are) invalidates the session and clears the cookie, so every request after that is blocked by middleware too. One extra `User` lookup per session read is the cost of this; `resolveSessionUser()` already does a separate lookup of its own for `companyId`/`role`/etc., so this doubles that per-request read rather than reusing it — accepted as a small, correct fix over a larger refactor to share one query across the two Node-runtime NextAuth configs.

**What deliberately doesn't change:** `TaskLog`, `TaskListSession`, `InventoryLog`, `MissedListAlert` — all already carry `companyId`/`locationId` denormalized (see [`locations.md`](locations.md)), so none of Reports, Logs, or CSV exports lose any company-side data. Everywhere the UI joins on `User.name` for history (leaderboard, logs tab, streaks), it'll just render "Deleted User" going forward with zero code changes elsewhere — same reason `DELETE /api/team/[userId]` didn't need any either.

**Last-manager guard reused:** if the requester is a `manager` and is the company's last remaining manager with no `owner` to cover it, `app/api/account/route.ts` blocks with the same 400 `PATCH`/`DELETE /api/team/[userId]` already return for that state (see [`team-invites.md`](team-invites.md)) — self-deleting shouldn't be able to leave a company with zero people who can administer it, any more than another manager removing them could.

## API

### `DELETE /api/account`
**Self only** — no `userId` in the body or URL; always acts on the caller's own session (`resolveSessionUser()`). `403` ("Owners can't self-delete — contact contact@usechrps.com") if `role === "owner"`. `400` (same message as the existing last-manager guard) if the caller is a `manager` and the company's last remaining manager with no owner. Otherwise performs the full scrub above, then calls `signOut({ redirect: false })` (the server-side NextAuth action, imported from `lib/auth.ts`) so the response itself clears the session cookie rather than leaving the client to hold a stale one until its own next signed-out request.

No `GET`/list endpoint — this is a single self-serve action, not an admin tool.

## UI

`components/ProfileView.tsx` has a **Delete Account** row at the bottom of the Profile page, styled with the same destructive-action convention as the existing "Sign out" button (a bordered burgundy row) and `TeamMemberActionSheet.tsx`'s "Remove from team" (`window.confirm()`-level confirmation, consistent with this app's existing destructive-action pattern):

- **`employee`/`manager`**: tapping opens a `window.confirm()` explaining what's removed vs. retained → `DELETE /api/account` → on success, a hard navigation (`window.location.href`, not `router.push`) to `/login`, since no client-side session cache should outlive the deletion.
- **`owner`**: the row is replaced by the static "contact contact@usechrps.com" message (a `mailto:` link) — no button, no confirmation, nothing that looks actionable, since there's no in-app action to take.

Reachable in two taps from Profile (tap Profile, tap Delete Account) — App Review checks for exactly that.

## Manual owner deletion (support runbook)

When an owner emails asking to delete their account and company data:

1. Cancel the Stripe subscription (`Company.subscription.stripeSubscriptionId`) before touching anything else, so no charge fires mid-cleanup.
2. Delete or scrub every `User` under that `companyId` (same per-user scrub as self-service, run manually or via a one-off script — not built yet, low urgency until this is a real support ticket).
3. Decide, at that time, whether the company's operational records (`TaskLog` history, reports) get hard-deleted too, or retained for whatever legal window applies and then purged — this is a business/legal call, not an engineering one, and isn't resolved by this doc. Flagging as an [open question](#open-questions--deferred) rather than assuming an answer.
4. No automation planned for this path yet — it's rare enough, and consequential enough, that a human doing it by hand with a checklist is the right amount of process for now.

## Privacy policy / disclosure

The app's privacy policy (and the App Store Connect privacy label) needs a line covering what Apple's guideline requires be disclosed: that requesting deletion removes personal information, but the company's task/time records the user created are retained for the business's own employment, payroll, and compliance recordkeeping, per Apple's own permitted-retention language. Not built as part of this change — `app/privacy` still needs that line added before this ships to App Review, since App Review checks the privacy policy against what the deletion flow actually does.

## Open questions / deferred

- Whether the eventual `TimeLog` feature (see the on-the-horizon payroll-export work) needs its own retention-period policy independent of `TaskLog` — payroll records often have longer statutory retention requirements than a completed-task checklist does. Not resolved here.
- Whether owner-initiated full company deletion (step 3 above) should eventually get a real in-app or admin-console flow instead of a manual runbook — deferred until it's a recurring request, not a hypothetical one.
- Whether a `manager` deleting their own account should trigger any notification to the company's `owner` — not built; the roster will simply show one less manager.

## Depends on

[`team-invites.md`](team-invites.md) for the `companyId: null`/`role: null` detach state and the last-manager-or-owner guard this reuses. [`locations.md`](locations.md) for the `owner` role tier that this feature routes around self-service entirely. [`notifications.md`](notifications.md) for `PushToken` cleanup.
