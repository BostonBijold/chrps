> **Keep this file updated after any code change in this area — do not let it drift from actual implementation.**

# Team & Invites

A **Team** tab in the bottom nav where every company member can see the roster, and a way for managers to add new users to the company **without any full-user-directory search**. Joining is invite-token-only: a manager generates a link, shares it out-of-band (text/email/AirDrop/OS share sheet), and opening that link is what attaches a person to the company. Nothing about company assignment is ever client-supplied — it's always resolved server-side from the token.

This mirrors the existing `/nfc/[tagCode]` pattern (public, unauthenticated deep link → forced sign-in with `callbackUrl` preserved → server-side claim) rather than inventing a new auth flow — see [`features/nfc.md`](nfc.md).

## Why token-based, not directory search

Ch'rps is multi-tenant — a manager searching "the full user catalog" would mean browsing every Ch'rps user across every company, a privacy leak with no product upside. An invite token scopes the join action to exactly the company and role the manager intended, and is the only thing that authorizes it.

## Data model

Collection: `invites` (`models/Invite.ts`):

```ts
Invite {
  companyId,
  token: string,             // crypto.randomBytes(24).toString("base64url") — unguessable, never derivable from the Invite's own _id
  role: "employee" | "manager",   // preset by the manager at creation time; applied to the User on redemption
  locationId,                // string | null — see docs/features/locations.md. Stamped from the creating
                              // manager's own User.locationId, or picked explicitly if an owner created it.
                              // Applied to User.locationId on redemption. Required going forward — POST
                              // /api/invites 400s without a valid one.
  createdByUserId,           // attribution only, same pattern as NfcTag.claimedByUserId
  createdAt,
  expiresAt: Date,           // default now + 7 days
  maxUses: number (default 1),    // 1 for "this one new hire"; the Invite sheet's "Reusable link" toggle sets 50 instead (a generous but non-infinite cap, not a real limit anyone's expected to hit — see components/InviteSheet.tsx's REUSABLE_MAX_USES)
  useCount: number (default 0),
  revokedAt: Date | null,
}
```

Indexes: `{ token: 1 }` (unique), `{ companyId: 1, revokedAt: 1 }` (for the manager's pending-invites list).

`models/User.ts` gained one field: `companyJoinedAt: Date | null`, set alongside `companyId`/`role` at redemption time — distinct from the adapter-owned account-creation timestamp, so re-joining a *different* company later reflects current tenure there, not original account creation. Null for anyone hand-attached to a company directly in MongoDB rather than through an invite (every pre-existing user).

`User.role`'s enum was later widened again to add a third tier, `owner` —
see docs/features/locations.md. Every "manager-only" gate below is,
strictly, "manager-or-above": `owner` passes the same checks, since it's a
strict superset of `manager`. Separately, the enum also allows `null` — the state `DELETE /api/team/[userId]` leaves a removed teammate in, alongside `companyId: null`, "not yet attached to any company," same as a brand-new sign-up. This is safe because every company-scoped route already gates on `companyId` being non-null before ever reading `role` (see `lib/session.ts`'s `resolveSessionUser()`); a null role never grants access on its own, it just avoids a stale role value surviving a company detach.

## Redemption flow — "share a link, then open it"

1. Manager taps **+ Invite** on the Team tab → picks a role and one-time-vs-reusable → `POST /api/invites` (manager-only) creates the `Invite`, returns `{ token, url }` where `url` is `<request origin>/invite/<token>` — the origin is read off the incoming request (`new URL(req.url).origin`), not a hardcoded domain constant, so it's correct in production, on a Vercel preview deploy, and in local dev alike.
2. `components/InviteSheet.tsx` shares that URL via the Web Share API (`navigator.share`) where available — no native Capacitor plugin needed, it works inside the app's WKWebView on iOS — falling back silently to a visible Copy Link button everywhere else (desktop browsers, etc).
3. Recipient opens it. `/invite/[token]` is **not** in `middleware.ts`'s `PUBLIC_PAGE_PATHS`, so a logged-out tap redirects to `/login?callbackUrl=/invite/<token>` — `app/login/page.tsx` already reads `callbackUrl` generically, same as the NFC flow.
4. `app/invite/[token]/page.tsx` (server component) looks up the `Invite` and validates, in order:
   - Not found, `revokedAt` set, `expiresAt` passed, or `useCount >= maxUses` → renders a generic "This invite is no longer valid" message. Doesn't distinguish *why* — no useful info for the recipient, and avoids leaking internal state to whoever holds the link.
   - Signed-in `User.companyId` is non-null **and different** from `invite.companyId` → blocks with "You're already part of a team — contact support to switch companies." Never silently reassigns a user who already belongs somewhere.
   - Signed-in `User.companyId` already equals `invite.companyId` → treated as idempotent success (double-tap, refresh) — redirects straight to `/tasks`, no double-increment.
   - Otherwise → redeems: atomically `findOneAndUpdate({ token, revokedAt: null, expiresAt: { $gt: now }, $expr: { $lt: ["$useCount", "$maxUses"] } }, { $inc: { useCount: 1 } })`. If that update matches nothing (lost a race to another simultaneous redemption against a `maxUses: 1` link), falls back to the "no longer valid" message rather than a 500. On success, sets `User.companyId`/`role`/`companyJoinedAt`, redirects to `/welcome` (the existing splash screen — see `app/welcome/page.tsx`, unchanged).

The atomic increment-with-filter is what keeps a `maxUses: 1` link from being redeemed twice by two people who open it at the same moment — same spirit as the single-active-timer invariant elsewhere in this app, just applied to invite consumption instead of task logs.

All of the validation/redemption logic above now lives in one shared helper, `lib/invites.ts`'s `redeemInvite(token, sessionUser)`, called by both `app/invite/[token]/page.tsx` (opening the link directly) and `POST /api/invites/redeem` (below) — the two entry points differ only in how they got the token and what they do with the result, not in any redemption rule.

## Joining without leaving the app (paste-link redemption)

`components/NoCompanyMessage.tsx` — shown to a signed-in user with no `companyId` yet — used to be a dead end unless the recipient physically opened their invite link (email, text, AirDrop). It now has a "Have an invite link?" field: pasting the full `.../invite/<token>` URL, or just the bare token, and tapping **Join** calls `POST /api/invites/redeem` with `{ link }`. `extractToken()` in that route pulls the token out of a pasted URL via `/\/invite\/([^/?#\s]+)/`, falling back to the trimmed input itself so a bare copied token still works. On success, `router.refresh()` re-runs the page's server component — since `companyId`/`role` are always resolved fresh from the `User` document per request (see CLAUDE.md's "Multi-Tenancy"), the newly-attached company shows up immediately, no re-sign-in needed. On failure, the same two messages `app/invite/[token]/page.tsx` renders ("already part of a different team" / "invite isn't valid") come back as inline errors instead.

This exists for the case a link only reaches someone as plain text they can't tap through as a URL (read aloud, texted without a live preview, etc.) — the original tap-the-link flow is unchanged and still the primary path.

`NoCompanyMessage.tsx` also has its own **Sign out** button (`signOut({ callbackUrl: "/login" })`) — this screen renders before the app shell (`Header.tsx`/bottom nav) exists, so there's otherwise no way back out of a wrong-account sign-in short of killing the app/clearing cookies by hand.

## API

Auth follows the existing pattern throughout: `lib/session.ts`'s `resolveSessionUser()`, `SKIP_AUTH`-gated dev fallback, `401` otherwise. `companyId`/`role` read fresh from the `User` document on every call, never trusted from the client.

### `POST /api/invites`
**Manager-or-above** (`403` for an employee). Body: `{ role: "employee" | "manager", maxUses?: number, expiresInDays?: number, locationId?: string }` — `400` if `role` is missing or not one of the two values. `locationId` is only read from the body for an **owner** creator (validated against the company's active locations); a manager's own `locationId` is always stamped instead, regardless of what's sent. `400` ("A valid locationId is required") if the resolved locationId is still empty — an owner with no location picked, or a manager with no `locationId` on their own `User` doc yet (see docs/features/locations.md's migration script). Defaults: `maxUses: 1`, `expiresInDays: 7`. Response: `{ _id, token, url, role, maxUses, expiresAt }`.

### `GET /api/invites`
**Manager-or-above**. This company's non-revoked invites, newest first: `{ _id, role, maxUses, useCount, expiresAt, createdAt, createdByName }`. Excludes `revokedAt: { $ne: null }` entirely — a revoked invite just disappears from this list, no "revoked" state ever shown.

### `DELETE /api/invites/[id]`
**Manager-or-above**. Sets `revokedAt: new Date()` — `404` if not found or not this company's. Soft-delete, not a hard remove, so a redemption already in flight still fails cleanly against the revoked state rather than a missing document.

### `POST /api/invites/redeem`
**Any signed-in user** (not company-gated — this is exactly how someone with no `companyId` gets one). Body: `{ link: string }` — a pasted invite URL or bare token, see "Joining without leaving the app" above. `400` if `link` is missing/blank. Delegates to `lib/invites.ts`'s `redeemInvite()`, the same helper `app/invite/[token]/page.tsx` uses. `400` with a user-facing message on `"different-company"` or `"invalid"`; `200 { ok: true }` on success (including the idempotent already-a-member case). Unlike the page version there's no redirect — the client (`NoCompanyMessage.tsx`) calls `router.refresh()` itself.

### `GET /api/team`
**Any signed-in company member** (not manager-gated — this is the read-only roster everyone sees). **Unfiltered by location by default** — returns every `User` in the company regardless of `locationId`, a location-bound manager included — **unless the caller is an owner with a location switcher selection set** (`sessionUser.activeLocationId`, see `docs/features/locations.md`'s "Location switcher"), in which case it filters to `{ companyId, locationId: activeLocationId }`. An employee/manager's `activeLocationId` is always `null` (no switcher for those roles), so this has no effect on them — they always see the full roster, unchanged from before that feature. Every `User` matched: `{ _id, name, image, role, joinedAt }`, owners first, then managers, then alphabetical by name within each. `joinedAt` is `companyJoinedAt ?? createdAt` (falls back for anyone attached before this feature existed). `image` is returned but not currently rendered anywhere — the Team tab uses the same initials-only avatar convention as `Header.tsx`/`ProfileView.tsx`, kept for design consistency rather than introducing photo rendering as a one-off.

### `PATCH /api/team/[userId]`
**Manager-or-above** for `role`; **owner-only** for `locationId` (see docs/features/locations.md's "Location assignment"). Body: `{ role?: "employee" | "manager", locationId?: string }` — at least one of the two must be present; `403` if `locationId` is sent by a non-owner; `404` if the resolved `locationId` doesn't name an active Location under this company; `404` if the target user isn't found or isn't this company's member. `403` ("Owners only") if the target's own role is `owner` and the caller isn't — a plain manager can't touch a fellow owner's role at all. **Guard**: `400` if changing `role` to `employee` would demote the company's last remaining manager AND the company has zero owners (`owner` alone is enough to avoid the lockout, since it administers everything a manager can) — a company with zero managers AND zero owners is a lockout state nobody can recover from through the UI.

### `DELETE /api/team/[userId]`
**Manager-or-above**. `$set: { companyId: null, role: null, companyJoinedAt: null, locationId: null }` — the same "not yet attached" state a brand-new sign-in sees (`components/NoCompanyMessage.tsx`). Soft company-detach, not an account deletion — historical `TaskLog`s etc. stay scoped to the company (and location) they belonged to at the time. Same last-manager-or-owner guard as `PATCH` above; also `403` ("Owners only") if the target is an `owner` and the caller isn't, and `400` if the target is the company's last remaining `owner`.

## Team tab UI

`components/BottomNav.tsx`'s bottom nav grew from Tasks | FAB | Analytics (renamed to Reports, see [reports.md](reports.md)) to **four tabs, two per side**: Tasks, Team | FAB | Reports, and a 4th slot after Reports that's an inert placeholder (`MoreHorizontal` icon, non-interactive, not a `Link`) reserved for a future tab — added purely to keep both sides visually balanced rather than leaving Team lopsided alone on the left. Profile stays exactly where it already was: the avatar icon in the top nav (`Header.tsx`), not a bottom-nav tab — this was a deliberate choice when the tab was added, not an oversight.

`app/(app)/team/page.tsx` + `components/TeamView.tsx`:

- **Roster** (everyone): rows from `GET /api/team` — initials avatar, name (current user tagged "(you)"), joined date, role badge. Read-only for an employee; tapping a row for a manager opens `components/TeamMemberActionSheet.tsx`.
- **Pending Invites** (managers only, below the roster): rows from `GET /api/invites` — role badge, uses-remaining, expiry, creator name, a **Revoke** button per row (`DELETE /api/invites/[id]`).
- **+ Invite** button (managers-or-above): opens `components/InviteSheet.tsx` — pick role, pick "Just this person" vs "Reusable link", and (**owner only**) pick a location from a fetched `GET /api/locations` list — required before Generate is enabled; a manager never sees this picker at all, their own `locationId` is stamped server-side. Tap Generate → `POST /api/invites` → Web Share API (falls back to a visible Copy Link button).
- **`TeamMemberActionSheet.tsx`** (managers-or-above): "Make Manager"/"Make Employee" (single toggle button, since there are only two roles this sheet can assign) and "Remove from team" (`window.confirm()` first — same destructive-confirmation convention `TaskListEditView.tsx`'s delete-list button already uses, not a custom multi-step confirmation UI). Both actions disable, with an inline explanation, whenever this row is the company's last remaining manager with no owner to cover it (computed client-side from the already-fetched roster's manager/owner counts), or whenever the row itself is an `owner` (its role is never touchable from this sheet at all — owner assignment is manual-only, see docs/features/locations.md). **Not yet built**: a location-reassignment control on this sheet — `PATCH /api/team/[userId]`'s owner-only `locationId` field has no UI caller yet.

## Open questions / deferred

- Whether an invite can be scoped to a specific email address (locking redemption to that Google account) rather than "whoever has the link" — not in this first pass; every invite here is link-possession-based, same trust model as the NFC tag links.
- Whether employees should see *who* invited whom, or only the current roster — current implementation keeps the roster minimal (name/role/joined) and puts inviter attribution only in the manager-only Pending Invites list.
- ~~Whether removing a user from a company should also revoke their `apiKey`~~ — moot now: `User.apiKey` and the entire external API surface it authenticated were removed outright (see `docs/project-structure.md`'s note on the removal), so there's no longer a lingering key to worry about revoking on team removal.

## Depends on

[`api/task-lists-api.md`](../api/task-lists-api.md) and [`features/nfc.md`](nfc.md) for the established auth/session-resolution and public-deep-link patterns this feature reuses. [`features/locations.md`](locations.md) layers the `owner` role tier and location-scoping on top of everything in this doc without replacing any of it.
