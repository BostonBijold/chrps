// Pure role-tier helpers — no server-only imports (unlike lib/session.ts,
// which pulls in @/lib/auth and mongoose), so client components can import
// this directly instead of pulling those into the browser bundle.
// lib/session.ts re-exports these for server-side call sites.

export type UserRole = "manager" | "employee" | "owner" | "developer";

// "manager or above" — the gate every existing manager-only surface used to
// spell as `role === "manager"` / `role !== "manager"`. `owner` is a strict
// superset of `manager` (see docs/features/locations.md's Role tiers), so
// every one of those checks widens to this instead of a parallel
// owner-only UI path. `developer` is a strict superset of `owner` in turn
// (see docs/features/nfc.md's "Provisioning" — internal-only, never
// assigned through any in-app flow, hand-set in MongoDB same as `owner`),
// so it passes this gate too.
export function isManagerOrAbove(role: UserRole): boolean {
  return role === "manager" || role === "owner" || role === "developer";
}

// A couple of actions (creating a Location, reassigning a teammate between
// locations) are gated tighter than plain "manager or above" — see
// docs/features/locations.md's Permissions audit. `developer` passes this
// too, same superset reasoning as isManagerOrAbove above.
export function isOwner(role: UserRole): boolean {
  return role === "owner" || role === "developer";
}

// Gates the NFC tag registry's "Provision Tag" action only — see
// docs/features/nfc.md's "Provisioning". The one place `developer` is
// checked as its own tier rather than folded into isOwner, since
// provisioning is narrower than anything owner already does (it isn't
// company-scoped at all — a provisioned tag has no companyId yet).
export function isDeveloper(role: UserRole): boolean {
  return role === "developer";
}
