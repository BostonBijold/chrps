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
// see that callback for why). redirectTo goes to chrps://native-auth-complete,
// a custom URL scheme AppleSignInSessionPlugin.swift's
// ASWebAuthenticationSession intercepts and auto-dismisses on — see that
// file and lib/auth.config.ts's redirect callback (which allow-lists this
// one scheme past Auth.js's default same-origin-only redirect check).
// models/NativeSignInHandoff.ts has the full handoff. Plain web has no
// such split (it's the same browser tab throughout), so it skips the
// detour and goes straight to callbackUrl.
export async function GET(request: NextRequest) {
  const callbackUrl = request.nextUrl.searchParams.get("callbackUrl") || "/welcome";
  const handoffId = request.nextUrl.searchParams.get("handoffId");

  const redirectTo = handoffId ? "chrps://native-auth-complete" : callbackUrl;

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
