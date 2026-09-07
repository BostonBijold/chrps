import NextAuth from "next-auth";
import authConfig from "@/lib/auth.config";

// Edge-safe auth instance (no MongoDB adapter) — middleware runs on the Edge runtime.
const { auth } = NextAuth(authConfig);

// Sign-in/sign-up only — a logged-in user gets bounced off these back to
// /tasks, since there's nothing for them to do there.
const AUTH_PAGES = ["/login", "/signup"];
const AUTH_PAGE_PATHS = new Set(AUTH_PAGES);

// Reachable with no session at all, but NOT redirected away from when
// logged in — /privacy stays visible either way (e.g. linked from the
// Profile page), and apple-app-site-association must be reachable with no
// session since Apple's CDN fetches it directly to validate Universal
// Links (see docs/features/nfc.md's "Native setup"), never carrying a
// login cookie.
const PUBLIC_PAGE_PATHS = new Set([...AUTH_PAGES, "/privacy", "/.well-known/apple-app-site-association"]);

export default auth((req) => {
  // Local dev escape hatch — lets you work without Google OAuth creds configured.
  // Never set SKIP_AUTH in the Vercel production environment.
  if (process.env.SKIP_AUTH === "true") return;

  const { pathname } = req.nextUrl;
  const isLoggedIn = !!req.auth;
  const isApiRoute = pathname.startsWith("/api");
  const isAuthPage = AUTH_PAGE_PATHS.has(pathname);
  const isPublicPage = PUBLIC_PAGE_PATHS.has(pathname);

  console.log(`[middleware] ${pathname} — isLoggedIn:${isLoggedIn} isPublicPage:${isPublicPage} isApiRoute:${isApiRoute} token:`, JSON.stringify(req.auth));

  if (isLoggedIn && isAuthPage) {
    return Response.redirect(new URL("/tasks", req.nextUrl.origin));
  }

  if (!isLoggedIn && !isPublicPage) {
    if (isApiRoute) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", req.nextUrl.origin);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return Response.redirect(loginUrl);
  }
});

export const config = {
  // Run on everything except static assets, images, PWA files, and
  // NextAuth's own callback/session endpoints (those must stay reachable
  // without a session — api/auth is what establishes one in the first
  // place). Also excludes api/cron — the QStash-scheduled sweep/reminder
  // routes (see docs/features/notifications.md) have no user session at
  // all by design; their auth boundary is QStash's own request signature,
  // verified inside each route handler via Receiver.verify(). Without this
  // exclusion, this middleware's own session check rejects every QStash
  // call with a 401 before the route ever runs its signature check —
  // confirmed in production: QStash's delivery logs showed a generic
  // {"error":"Unauthorized"} (this middleware's own response, complete
  // with NextAuth Set-Cookie headers) rather than either of the route's
  // own "Missing signature"/"Invalid signature" messages, and the
  // repeated failures caused QStash to auto-pause the schedule entirely.
  // Used to also exclude api/external — the API-key-authenticated
  // external API surface (Shortcuts/Siri App Intents, NFC silent triggers)
  // — but that whole surface was removed; see docs/features/nfc.md's
  // history note on why.
  //
  // api/native-apple-signin and api/native-handoff are excluded for the
  // same reason api/auth is: they're unauthenticated entry points in the
  // Sign in with Apple flow (see components/AppleSignInButton.tsx) — the
  // former kicks off sign-in with no session yet by definition,
  // api/native-handoff/status is literally the request that ESTABLISHES
  // the app's own session (see models/NativeSignInHandoff.ts), so it can
  // never itself require one. Without this exclusion this middleware 401s
  // them before their own route handlers ever run, the same
  // {"error":"Unauthorized"} failure mode the api/cron comment above
  // already documents for QStash — confirmed live for
  // api/native-apple-signin before this exclusion existed.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/auth|api/cron|api/native-apple-signin|api/native-handoff|manifest\\.json|sw\\.js|.*\\.(?:png|jpg|jpeg|svg|ico|webp)$).*)",
  ],
};
