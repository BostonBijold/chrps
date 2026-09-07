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
} satisfies NextAuthConfig;
