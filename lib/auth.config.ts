import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import Apple from "next-auth/providers/apple";

// Edge-safe config (no MongoDB adapter — the driver isn't Edge-compatible).
// Used directly by middleware; extended with the adapter in lib/auth.ts for
// route handlers and server components, which run in the Node runtime.
export default {
  providers: [
    Google,
    // App Store Review Guideline 4.8: offering Google Sign-In as a
    // third-party login requires Sign in with Apple as an equivalent
    // option. Apple's clientSecret must be a pre-signed ES256 JWT (Apple
    // doesn't accept a plain static secret the way Google does) — generate
    // one with scripts/generate-apple-client-secret.mjs and set it as
    // APPLE_CLIENT_SECRET; it expires after ~6 months and must be
    // regenerated, unlike Google's clientSecret above which never expires.
    Apple({
      clientId: process.env.APPLE_CLIENT_ID,
      clientSecret: process.env.APPLE_CLIENT_SECRET,
    }),
  ],
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
  },
  // Apple's provider uses response_mode: "form_post" (it POSTs the callback
  // instead of redirecting with a GET), which the browser treats as a
  // cross-site request — Auth.js's default state/nonce cookies are
  // SameSite=Lax, and Lax cookies are withheld on cross-site POSTs, so the
  // callback can never read back the state it set before redirecting to
  // Apple ("InvalidCheck: state value could not be parsed"). SameSite=None
  // fixes it; only applied in production since None requires Secure, which
  // plain http://localhost can't set — Google's redirect-based flow is
  // unaffected either way, since None is a superset of Lax for GETs.
  //
  // callbackUrl gets the same treatment for the same reason: it's the
  // cookie that actually carries native-apple-signin's redirectTo
  // (chrps://native-auth-complete) across Apple's cross-site POST to the
  // redirect() callback below — without it, that cookie is withheld same
  // as state/nonce were, redirect() never sees the chrps:// URL, and the
  // ASWebAuthenticationSession sheet lands on the plain site instead of
  // ever hitting a scheme it can intercept (confirmed live: jwt/signIn
  // both completed successfully, but the sheet never closed).
  cookies:
    process.env.NODE_ENV === "production"
      ? {
          state: { options: { sameSite: "none", secure: true } },
          nonce: { options: { sameSite: "none", secure: true } },
          callbackUrl: { options: { sameSite: "none", secure: true } },
        }
      : undefined,
  callbacks: {
    // Auth.js's default redirect callback only allows same-origin URLs
    // (anything else silently falls back to baseUrl), which would swallow
    // the one redirect the native Apple sign-in flow actually depends on:
    // app/api/native-apple-signin/route.ts's redirectTo sends the OAuth
    // flow's FINAL redirect to chrps://native-auth-complete, a custom URL
    // scheme ios/App/App/AppleSignInSessionPlugin.swift's
    // ASWebAuthenticationSession intercepts before it's ever actually
    // navigated to (see that file for why this replaced a plain in-app
    // browser sheet + JS polling). Every other redirect target keeps the
    // default same-origin-only behavior — this only special-cases that one
    // known, fixed scheme, not arbitrary external URLs.
    redirect({ url, baseUrl }) {
      console.log("[auth] redirect callback — url:", url, "baseUrl:", baseUrl);
      if (url.startsWith("chrps://")) return url;
      if (url.startsWith("/")) return `${baseUrl}${url}`;
      try {
        if (new URL(url).origin === baseUrl) return url;
      } catch {
        // Not a parseable absolute URL — fall through to baseUrl below.
      }
      return baseUrl;
    },
  },
} satisfies NextAuthConfig;
