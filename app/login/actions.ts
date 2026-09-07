"use server";

import { signIn } from "@/lib/auth";

// Apple's own sign-in page can't run inside Capacitor's WKWebView (see
// components/AppleSignInButton.tsx) — the button instead opens this URL in
// an in-app browser sheet. signIn(..., { redirect: false }) sets the
// state/nonce cookies on this server action's own response (same cookie
// store the in-app browser sheet reads, since Capacitor's WKWebView and
// SFSafariViewController share iOS's default WKWebsiteDataStore) and
// returns Apple's authorization URL instead of issuing a redirect itself.
export async function getAppleSignInUrl(destination: string): Promise<string> {
  return signIn("apple", { redirectTo: destination, redirect: false });
}
