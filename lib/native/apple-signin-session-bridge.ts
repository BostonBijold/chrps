import { registerPlugin } from "@capacitor/core";

// Bridges to ios/App/App/AppleSignInSessionPlugin.swift — wraps
// ASWebAuthenticationSession, Apple's own API for "open a web page for
// auth, then hand control back to the app automatically," used in place
// of @capacitor/browser's plain SFSafariViewController for the native
// Sign in with Apple flow specifically (see that Swift file for why: iOS
// itself watches for the OAuth redirect, not this app's own WKWebView JS,
// which testing showed effectively stops running while a sheet covers
// it). No-op-safe to call on web/PWA: registerPlugin resolves to a stub
// there that rejects every call, same as lib/native/nfc-scan-bridge.ts —
// components/AppleSignInButton.tsx never calls this outside
// Capacitor.isNativePlatform() anyway.
interface AppleSignInSessionPlugin {
  // Resolves once the session's navigation reaches a URL whose scheme
  // matches callbackURLScheme (default "chrps") — see
  // app/api/native-apple-signin/route.ts's redirectTo. Rejects with
  // "User cancelled" if the user backs out of the system sheet, or the
  // session's own error message for any other failure.
  start(options: { url: string; callbackURLScheme?: string }): Promise<{ url: string }>;
}

export const AppleSignInSession = registerPlugin<AppleSignInSessionPlugin>("AppleSignInSession");
