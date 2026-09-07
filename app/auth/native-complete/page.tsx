"use client";

import { useEffect } from "react";

// Real https:// landing page Apple's OAuth callback redirects to (see
// app/api/native-apple-signin/route.ts's redirectTo) — required because
// Auth.js validates its own callbackUrl cookie against a same-origin
// http(s) check BEFORE lib/auth.config.ts's redirect() callback ever runs
// (confirmed live: "InvalidCallbackUrl", thrown with zero custom-callback
// log output, the moment redirectTo was chrps://native-auth-complete
// directly). A custom URL scheme can never satisfy that check, so it can
// never be redirectTo itself.
//
// This page's own job is the client-side hop that check can't see:
// immediately on load, it navigates to chrps://native-auth-complete via
// plain JS, which ios/App/App/AppleSignInSessionPlugin.swift's
// ASWebAuthenticationSession intercepts and auto-dismisses on, exactly as
// before. Unlike the app's own separate WKWebView (which live testing
// showed stops running JS entirely behind a covering sheet), this page
// renders INSIDE the ASWebAuthenticationSession's own foreground browsing
// context, so its JS is guaranteed to actually run — no suspension risk
// here. The NativeSignInHandoff row this depends on is already written by
// the time this page ever loads (lib/auth.ts's jwt callback, inline
// during Apple's own callback, before NextAuth computes any response).
export default function NativeAuthCompletePage() {
  useEffect(() => {
    window.location.replace("chrps://native-auth-complete");
  }, []);

  return (
    <main className="min-h-dvh bg-bg flex flex-col items-center justify-center p-6 text-center">
      <div
        className="w-8 h-8 rounded-full border-2 border-border border-t-olive animate-spin mb-4"
        aria-hidden="true"
      />
      <h1 className="font-brand font-bold text-2xl text-text mb-3">You&apos;re signed in</h1>
      <p className="text-muted text-sm max-w-mobile">Returning to the app&hellip;</p>
    </main>
  );
}
