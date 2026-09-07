"use client";

import { useState } from "react";
import { Capacitor } from "@capacitor/core";
import { startAppleSignInSession } from "@/lib/native/apple-signin-session";

// Apple's sign-in page won't run inside Capacitor's own WKWebView — iOS
// hands navigation to appleid.apple.com off to the system browser instead
// of honoring capacitor.config.ts's allowNavigation, which used to strand
// the user in standalone Safari with no way back into the app. Opening it
// in a dedicated in-app auth session
// (ios/App/App/AppleSignInSessionPlugin.swift's ASWebAuthenticationSession)
// keeps it visually inside the app.
//
// That session runs in its own browsing context, separate from the app's
// own WKWebView — same split @capacitor/browser's plain SFSafariViewController
// had before it (confirmed via a live InvalidCheck: state value could not
// be parsed failure when this used a server action from the app's own
// webview instead of loading app/api/native-apple-signin directly), and
// the session's establishment of Apple's cookie/session never reaches the
// app's own WKWebView on its own either (confirmed live: the app stayed
// signed out afterward). A handoffId generated here, threaded through the
// whole flow, is what actually signs the app itself in — see
// models/NativeSignInHandoff.ts for the full mechanism.
//
// This used to open @capacitor/browser's SFSafariViewController and have
// this component's own JS poll for completion and close the sheet itself.
// Live device testing across three rounds of fixes showed the app's
// WKWebView stops running JS entirely while that sheet covers it — no
// poll tick, no timeout, ever fired until the user manually dismissed it
// — making any JS-driven detection fundamentally unreliable regardless of
// how the polling itself was tuned. ASWebAuthenticationSession replaces
// that: iOS itself watches for the OAuth flow's final redirect
// (chrps://native-auth-complete, see app/api/native-apple-signin/route.ts)
// and auto-dismisses the session the instant it sees it, entirely in
// native code — so by the time startAppleSignInSession() below resolves,
// the app's own WKWebView is guaranteed foregrounded and running again,
// and the single handoff-status check that follows can be trusted to
// actually execute. No polling, no listeners, no manual Browser.close()
// needed anymore.
//
// Plain web (not the native app) keeps the simple top-level redirect the
// Google button still uses — the handoff mechanism above only matters for
// the split-browsing-context problem native has.
export default function AppleSignInButton({ destination }: { destination: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function checkHandoffStatus(handoffId: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/native-handoff/status?handoffId=${handoffId}`);
      const { done } = await res.json();
      return Boolean(done);
    } catch {
      return false;
    }
  }

  async function handleClick() {
    setPending(true);
    setError(null);
    try {
      if (!Capacitor.isNativePlatform()) {
        window.location.href = `${window.location.origin}/api/native-apple-signin?callbackUrl=${encodeURIComponent(destination)}`;
        return;
      }

      const handoffId = crypto.randomUUID();
      const url = `${window.location.origin}/api/native-apple-signin?callbackUrl=${encodeURIComponent(destination)}&handoffId=${handoffId}`;

      const result = await startAppleSignInSession(url);
      if (result.status === "cancelled") {
        setPending(false);
        return;
      }
      if (result.status !== "ok") {
        setPending(false);
        setError(
          result.status === "unsupported"
            ? "Apple sign-in isn't supported here."
            : "Something went wrong. Please try again."
        );
        return;
      }

      // The session only resolves once the app is foregrounded and
      // running again, so the handoff row (written inline during Apple's
      // own callback — see lib/auth.ts's jwt callback) should already be
      // there. A couple of short retries cover only the status check's
      // own network round trip, not the underlying write.
      let done = false;
      for (let attempt = 0; attempt < 3 && !done; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500));
        done = await checkHandoffStatus(handoffId);
      }

      if (done) {
        window.location.href = destination;
      } else {
        setPending(false);
        setError("Sign-in wasn't completed. Please try again.");
      }
    } catch {
      setPending(false);
      setError("Something went wrong. Please try again.");
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        className="w-full flex items-center justify-center gap-3 bg-black border-2 border-black text-white py-4 rounded-xl font-body font-medium hover:bg-gray-900 transition-colors disabled:opacity-60"
      >
        <AppleIcon />
        Continue with Apple
      </button>
      {error && <p className="text-burgundy-light text-xs text-center mt-2">{error}</p>}
    </div>
  );
}

function AppleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 384 512" fill="#fff">
      <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
    </svg>
  );
}
