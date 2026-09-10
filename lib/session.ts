import { auth } from "@/lib/auth";
import { connectDB } from "@/lib/mongoose";
import User from "@/models/User";
import { isManagerOrAbove, isOwner, isDeveloper } from "@/lib/roles";
import type { UserRole } from "@/lib/roles";

export type { UserRole };
// Re-exported for every server-side call site that already imports these
// from here — the actual definitions live in lib/roles.ts, which has no
// server-only imports, so client components import from there directly
// instead of pulling @/lib/auth/mongoose into the browser bundle.
export { isManagerOrAbove, isOwner, isDeveloper };

export interface SessionUser {
  userId: string;
  // Null means "not yet provisioned" — a signed-in user with no Company
  // attached in MongoDB yet. Callers must treat this as no access, never as
  // its own shared tenant.
  companyId: string | null;
  role: UserRole;
  // This user's primary Location (see docs/features/locations.md) — the
  // only location an employee/manager can see, and an owner's default
  // context. Null until the backfill migration runs, or for anyone
  // hand-attached to a company without one assigned. Callers that need the
  // location actually IN VIEW right now (which differs from this for an
  // owner who has switched) should use pickActiveLocationId below rather
  // than reading this field directly.
  locationId: string | null;
  // An owner's current location-switcher selection (see
  // docs/features/locations.md's "Location switcher") — null means no
  // override is set. Always null for employee/manager. Most callers should
  // go through pickActiveLocationId below rather than reading this
  // directly; the one exception is GET /api/team, whose own "no override"
  // default (show the whole company) differs from every other page's (fall
  // back to this owner's own locationId), so it reads this field straight.
  activeLocationId: string | null;
}

export const DEV_USER_ID = "dev-local-user";
export const DEV_COMPANY_ID = "dev-local-company";
export const DEV_LOCATION_ID = "dev-local-location";

// Resolves the signed-in user's id, companyId, role, and locationId for
// scoping every DB query. companyId/role/locationId are read fresh from the
// User document on every call rather than cached on the JWT — since v1 has
// no invitation flow for a company's very first member, a company/role/
// location assignment is made by hand directly in MongoDB, and it needs to
// take effect on the very next request instead of waiting for a new
// sign-in to refresh the token.
export async function resolveSessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  const sessionUserId = session?.user?.id;

  if (!sessionUserId) {
    if (process.env.SKIP_AUTH === "true") {
      return {
        userId: DEV_USER_ID,
        companyId: DEV_COMPANY_ID,
        role: "manager",
        locationId: DEV_LOCATION_ID,
        activeLocationId: null,
      };
    }
    return null;
  }

  await connectDB();
  const user = await User.findById(sessionUserId, "companyId role locationId activeLocationId").lean<{
    companyId?: { toString(): string } | null;
    role?: UserRole;
    locationId?: { toString(): string } | null;
    activeLocationId?: { toString(): string } | null;
  }>();
  if (!user) return null;

  return {
    userId: sessionUserId,
    companyId: user.companyId ? user.companyId.toString() : null,
    role: user.role ?? "manager",
    locationId: user.locationId ? user.locationId.toString() : null,
    activeLocationId: user.activeLocationId ? user.activeLocationId.toString() : null,
  };
}

// Resolves which Location a request is actually acting against. For an
// employee/manager this is always their own stored locationId — there is
// no switcher for these two roles, by design. An owner has no single
// "current" location, so the fallback chain is: an explicit one-off
// ?locationId=<id> on this request, then the switcher selection they've
// persisted (activeLocationId — see docs/features/locations.md's
// "Location switcher"), then their own default locationId. This only
// trusts requestedLocationId once the caller has confirmed it names an
// active Location under the same companyId (see
// app/api/locations/route.ts / lib/locations.ts's validateLocationId) —
// this helper itself does no DB check, it just picks which id to use, so
// callers that accept a raw query param must still validate it belongs to
// the company before trusting it further.
export function pickActiveLocationId(sessionUser: SessionUser, requestedLocationId: string | null): string | null {
  if (!isOwner(sessionUser.role)) return sessionUser.locationId;
  return requestedLocationId || sessionUser.activeLocationId || sessionUser.locationId;
}
