"use client";

import { useState } from "react";
import { Capacitor } from "@capacitor/core";

// Apple's sign-in page won't run inside Capacitor's own WKWebView — iOS
// hands navigation to appleid.apple.com off to the system browser instead
// of honoring capacitor.config.ts's allowNavigation, which used to strand
// the user in standalone Safari with no way back into the app. Opening it
// in an in-app browser sheet (@capacitor/browser, backed by
// SFSafariViewController on iOS) keeps it visually inside the app.
//
// Opens app/api/native-apple-signin directly (not a server action that
// fetches the Apple URL first) — a server action invoked from this
// component runs in the app's own WKWebView context, and that turned out
// NOT to share a cookie jar with the @capacitor/browser sheet (confirmed
// via a live InvalidCheck: state value could not be parsed failure): the
// state cookie set there was invisible to Apple's callback landing in the
// sheet. Loading the route directly means the cookie-set and Apple's
// eventual callback both happen inside the one browsing context the sheet
// owns.
//
// That same cookie-jar split means the session Apple's callback
// establishes ALSO never reaches the app's own webview on its own
// (confirmed live: the app stayed signed out after the sheet closed) — a
// handoffId generated here, threaded through the whole flow, and picked up
// by app/api/native-handoff/status once the sheet closes is what actually
// signs the app itself in. See models/NativeSignInHandoff.ts for the full
// mechanism and why Universal Links weren't reliable enough to carry this
// on their own.
//
// Plain web (not the native app) keeps the simple top-level redirect the
// Google button still uses — Browser.open() on web just opens a new tab,
// and the handoff mechanism above only matters for the split-cookie-jar
// problem native has.
export default function AppleSignInButton({ destination }: { destination: string }) {
  const [pending, setPending] = useState(false);

  async function handleClick() {
    setPending(true);
    try {
      if (!Capacitor.isNativePlatform()) {
        window.location.href = `${window.location.origin}/api/native-apple-signin?callbackUrl=${encodeURIComponent(destination)}`;
        return;
      }

      const handoffId = crypto.randomUUID();
      const url = `${window.location.origin}/api/native-apple-signin?callbackUrl=${encodeURIComponent(destination)}&handoffId=${handoffId}`;

      const { Browser } = await import("@capacitor/browser");
      const handle = await Browser.addListener("browserFinished", async () => {
        handle.remove();
        try {
          const res = await fetch(`/api/native-handoff/status?handoffId=${handoffId}`);
          const { done } = await res.json();
          if (done) {
            window.location.href = destination;
          } else {
            setPending(false);
          }
        } catch {
          setPending(false);
        }
      });
      await Browser.open({ url });
    } catch {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={pending}
      className="w-full flex items-center justify-center gap-3 bg-black border-2 border-black text-white py-4 rounded-xl font-body font-medium hover:bg-gray-900 transition-colors disabled:opacity-60"
    >
      <AppleIcon />
      Continue with Apple
    </button>
  );
}

function AppleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 384 512" fill="#fff">
      <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
    </svg>
  );
}
