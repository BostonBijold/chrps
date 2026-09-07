import { NextRequest, NextResponse } from "next/server";
import { signIn, NATIVE_HANDOFF_COOKIE } from "@/lib/auth";

// Deliberately a plain GET redirect endpoint, not the app/login/actions.ts
// server action it replaces — that action set the state/nonce cookies via
// a request from the app's own WKWebView, while Apple's callback lands
// inside the separate in-app browsing context
// ios/App/App/AppleSignInSessionPlugin.swift's ASWebAuthenticationSession
// opens (components/AppleSignInButton.tsx); that turned out NOT to share a
// cookie jar with the app's own WKWebView (confirmed via a live
// InvalidCheck: state value could not be parsed failure), unlike a plain
// WKWebView-to-Safari handoff, which does. Having the session load THIS
// route directly means the cookie-set (via signIn's own cookies().set(),
// which Route Handlers support same as Server Actions) and the eventual
// Apple callback both happen inside the one browsing context the session
// owns, start to finish.
//
// A handoffId means components/AppleSignInButton.tsx opened this from the
// native app — the session Apple's callback establishes lives only in
// that browsing context, not the app's own WKWebView (confirmed live —
// the app stayed signed out afterward), so handoffId is also stamped onto
// a cookie here (read back by lib/auth.ts's jwt callback, which does the
// actual NativeSignInHandoff write inline during Apple's own callback —
// see that callback for why). redirectTo goes to the real
// app/auth/native-complete page, NOT chrps://native-auth-complete
// directly — Auth.js validates its own callbackUrl cookie against a
// same-origin http(s) check before lib/auth.config.ts's redirect()
// callback ever runs (confirmed live: "InvalidCallbackUrl", thrown before
// that callback's own log line ever printed), so a custom scheme can
// never be redirectTo itself. That landing page does the chrps:// hop
// itself, client-side, once loaded — see its own comment for why that's
// safe from the WKWebView-suspension bug the rest of this flow works
// around. models/NativeSignInHandoff.ts has the full handoff. Plain web
// has no such split (it's the same browser tab throughout), so it skips
// the detour and goes straight to callbackUrl.
export async function GET(request: NextRequest) {
  const callbackUrl = request.nextUrl.searchParams.get("callbackUrl") || "/welcome";
  const handoffId = request.nextUrl.searchParams.get("handoffId");

  const redirectTo = handoffId ? new URL("/auth/native-complete", request.url).toString() : callbackUrl;

  const url = await signIn("apple", { redirectTo, redirect: false });
  const response = NextResponse.redirect(url);

  if (handoffId) {
    response.cookies.set(NATIVE_HANDOFF_COOKIE, handoffId, {
      httpOnly: true,
      maxAge: 60 * 10,
      path: "/",
      ...(process.env.NODE_ENV === "production" ? { sameSite: "none" as const, secure: true } : {}),
    });
  }

  return response;
}
