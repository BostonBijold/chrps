import { Schema, model, models } from "mongoose";

// Extends the NextAuth MongoDBAdapter `users` collection with app-specific fields.
// Do not redeclare fields the adapter owns (email, name, image, emailVerified).
const UserSchema = new Schema(
  {
    // Tenant this user belongs to. Null until a developer manually attaches
    // a pre-created Company doc by hand in MongoDB — v1 has no self-serve
    // company creation or invitation flow. A null companyId means "not yet
    // provisioned," never "shared across every unassigned user" — every
    // company-scoped query must treat it as no access, not as its own tenant.
    companyId: { type: Schema.Types.ObjectId, ref: "Company", default: null },
    // Freely editable by hand in MongoDB for manual testing until a real
    // invitation/role-assignment flow exists. Defaults to "manager" on
    // signup (stamped explicitly in lib/auth.ts's createUser event, since
    // the MongoDB adapter inserts the user doc directly and never applies
    // Mongoose schema defaults).
    // null is also valid here (alongside companyId: null) — the state
    // DELETE /api/team/[userId] leaves a removed teammate in, "not yet
    // attached to any company," same as a brand-new sign-up. Every
    // company-scoped route already gates on companyId being non-null first,
    // so a null role never grants access on its own — see lib/session.ts's
    // resolveSessionUser(), which only reads role once companyId is known.
    // Widened to a third tier, "owner" (see docs/features/locations.md) — a
    // strict superset of "manager": every location under this owner's
    // companyId, not just one. `owner` is never the invite-redemption
    // default (Invite.role stays "employee" | "manager") — it's assigned by
    // hand in MongoDB, same as a company's very first manager.
    role: { type: String, enum: ["manager", "employee", "owner", null], default: "manager" },
    // Set alongside companyId/role at invite redemption (see
    // app/invite/[token]/page.tsx and docs/features/team-invites.md) —
    // distinct from the adapter-owned account-creation timestamp, so
    // re-joining a *different* company later reflects current tenure there,
    // not when the underlying account was first created. Null for anyone
    // hand-attached to a company directly in MongoDB rather than through an
    // invite (all pre-existing users, and any future manual assignment).
    companyJoinedAt: { type: Date, default: null },
    // Live Activity push-update token — see docs/features/live-activity.md's
    // "Push-driven updates" section and lib/apns.ts. Re-issued by iOS
    // periodically; POST /api/live-activity/push-token always overwrites
    // rather than versioning, since only the latest token is ever usable and
    // there's at most one relevant Live Activity per user at a time (the
    // single-active-timer invariant).
    liveActivityPushToken: { type: String, default: null },
    // "sandbox" for a Development-signed build (Xcode Debug config — what
    // this personal app runs today), "production" for a Distribution-signed
    // build (App Store/TestFlight). APNs rejects a token sent to the wrong
    // host outright, so this has to travel with the token, not be a single
    // server-wide setting.
    liveActivityPushEnvironment: { type: String, enum: ["sandbox", "production"], default: null },
    // bcrypt hash for manual email/password sign-in (see lib/password.ts,
    // the Credentials provider in lib/auth.ts, and app/signup) — added
    // alongside Google OAuth so Apple's App Review team has a sign-in path
    // that doesn't depend on a real Google account. Null for a Google-only
    // account; the Profile page lets a Google user set one later, and
    // lets anyone with one change it, via PATCH /api/user/password. Never
    // include this field in a value returned from an API response —
    // existing User queries elsewhere all project specific fields rather
    // than returning the raw doc, keep that pattern.
    passwordHash: { type: String, default: null },
    // This user's primary Location (see docs/features/locations.md) — set
    // once, at invite redemption, never client-supplied. For
    // employee/manager this is also their ONLY visible location, by design
    // — there is no separate "accessible locations" list for these two
    // roles. For an owner, this is just their default location context
    // (which location's Today view opens to first); an owner's actual
    // visible-locations set is computed at read time (every active Location
    // under their companyId), not stored here or anywhere else. Null for
    // every pre-Locations user until the one-off backfill script runs (see
    // scripts/backfill-locations.mjs) and for anyone hand-attached to a
    // company without a location assigned.
    locationId: { type: Schema.Types.ObjectId, ref: "Location", default: null },
    // An owner's current location-switcher selection (see
    // docs/features/locations.md's "Location switcher") — distinct from
    // locationId above, which is this user's fixed home/default location.
    // Meaningless for employee/manager (they have no switcher — see
    // lib/session.ts's pickActiveLocationId). null means "no override set,"
    // which resolves differently per page: Tasks/Reports/Inventory fall
    // back to this owner's own locationId (unchanged pre-switcher
    // behavior); the Team roster falls back to no filter at all (also
    // unchanged pre-switcher behavior — it's never been location-scoped).
    // Set only via PATCH /api/session/active-location.
    activeLocationId: { type: Schema.Types.ObjectId, ref: "Location", default: null },
    // Company-defined job function tags (server/cook/busser/host/…) for
    // task-list assignment — orthogonal to `role`, which governs access.
    // Optional: a company that never sets any tag keeps every task list
    // visible to everyone, unchanged from today. Not yet read anywhere —
    // the tag-catalog/task-list-targeting UI is a separate, unbuilt pass,
    // see docs/features/locations.md's "Job tags".
    jobTags: { type: [String], default: [] },
    // Set by self-service account deletion (DELETE /api/account — see
    // docs/features/account-deletion.md). Null for every existing user.
    // Presence of this alone is what lib/auth.ts's jwt callback checks to
    // force-invalidate any JWT issued before the scrub, since companyId/
    // role being cleared to null isn't distinguishable from an ordinary
    // not-yet-provisioned sign-up.
    deletedAt: { type: Date, default: null },
  },
  {
    strict: false, // allow adapter-owned fields to coexist without declaring them
    timestamps: true,
  }
);

export default models.User || model("User", UserSchema);
