"use client";

import { useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";

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
// handoffId generated here, threaded through the whole flow, is what
// actually signs the app itself in. See models/NativeSignInHandoff.ts for
// the full mechanism and why Universal Links weren't reliable enough to
// carry this on their own.
//
// The app polls app/api/native-handoff/status WHILE the sheet is still
// open (rather than waiting for the user to close it first, which used to
// be the only trigger and left the sheet stranded open with no way to
// know sign-in had actually finished) and closes the sheet itself the
// moment the handoff succeeds. The browserFinished listener is kept only
// as a fallback for a user who manually dismisses the sheet early.
//
// Plain web (not the native app) keeps the simple top-level redirect the
// Google button still uses — Browser.open() on web just opens a new tab,
// and the handoff mechanism above only matters for the split-cookie-jar
// problem native has.

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 90_000;

export default function AppleSignInButton({ destination }: { destination: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const settledRef = useRef(false);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listenerHandleRef = useRef<PluginListenerHandle | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cleanupTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function cleanupTimers() {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (listenerHandleRef.current) {
      listenerHandleRef.current.remove();
      listenerHandleRef.current = null;
    }
  }

  // Tagged so it's easy to filter in the device console (Capacitor's own
  // "⚡️ To Native ->" bridge logging only shows plugin calls, not fetch
  // results — these are what actually explain a poll/handoff failure).
  function log(...args: unknown[]) {
    // eslint-disable-next-line no-console
    console.log("[AppleSignIn]", ...args);
  }

  async function closeSheetBestEffort() {
    try {
      const { Browser } = await import("@capacitor/browser");
      await Browser.close();
    } catch (err) {
      // Already closed (e.g. the user tapped "Done" right as this
      // resolved) — Browser.close() rejects with "No active window to
      // close!" in that case, which is an expected benign race, not a
      // real failure.
      log("Browser.close() rejected (sheet likely already closed):", err);
    }
  }

  async function checkHandoffStatus(handoffId: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/native-handoff/status?handoffId=${handoffId}`);
      const { done } = await res.json();
      log("handoff status check ->", { handoffId, httpStatus: res.status, done });
      return Boolean(done);
    } catch (err) {
      log("handoff status check failed:", err);
      return false;
    }
  }

  async function checkExistingSession(): Promise<boolean> {
    try {
      const res = await fetch("/api/auth/session");
      const session = await res.json();
      const hasUser = Boolean(session?.user);
      log("existing session check ->", { httpStatus: res.status, hasUser });
      return hasUser;
    } catch (err) {
      log("existing session check failed:", err);
      return false;
    }
  }

  async function finishSuccess(opts: { skipClose?: boolean } = {}) {
    if (settledRef.current) return;
    settledRef.current = true;
    log("finishSuccess — navigating to", destination);
    cleanupTimers();
    if (!opts.skipClose) await closeSheetBestEffort();
    if (mountedRef.current) {
      window.location.href = destination;
    }
  }

  async function finishFailure(message: string, opts: { skipClose?: boolean } = {}) {
    if (settledRef.current) return;
    // A poll tick's request can succeed server-side (consuming the
    // handoff row, setting the session cookie) even if its response never
    // reaches this client — re-check for an actual session before
    // reporting a false failure.
    if (await checkExistingSession()) {
      log("finishFailure superseded — a session already exists, treating as success");
      await finishSuccess(opts);
      return;
    }
    settledRef.current = true;
    log("finishFailure —", message);
    cleanupTimers();
    if (!opts.skipClose) await closeSheetBestEffort();
    if (mountedRef.current) {
      setPending(false);
      setError(message);
    }
  }

  async function pollTick(handoffId: string) {
    if (settledRef.current) return;
    const done = await checkHandoffStatus(handoffId);
    if (done) {
      await finishSuccess();
    }
    // A false/failed tick isn't terminal — the next tick or the timeout
    // resolves it.
  }

  async function handleClick() {
    setPending(true);
    setError(null);
    try {
      if (!Capacitor.isNativePlatform()) {
        window.location.href = `${window.location.origin}/api/native-apple-signin?callbackUrl=${encodeURIComponent(destination)}`;
        return;
      }

      settledRef.current = false;
      const handoffId = crypto.randomUUID();
      const url = `${window.location.origin}/api/native-apple-signin?callbackUrl=${encodeURIComponent(destination)}&handoffId=${handoffId}`;

      const { Browser } = await import("@capacitor/browser");
      listenerHandleRef.current = await Browser.addListener("browserFinished", async () => {
        if (settledRef.current) return;
        // browserFinished only ever fires once the native sheet is ALREADY
        // gone (the user tapped "Done"/dismissed it) — never as a result of
        // our own Browser.close() call (confirmed: that bypasses this
        // delegate entirely). So there is never a sheet left to close here;
        // skipClose avoids an always-guaranteed-to-fail Browser.close() call.
        log("browserFinished fired (user dismissed the sheet manually)");
        const done = await checkHandoffStatus(handoffId);
        if (done) {
          await finishSuccess({ skipClose: true });
        } else {
          await finishFailure("Sign-in wasn't completed. Please try again.", { skipClose: true });
        }
      });

      log("opening sheet, handoffId =", handoffId);
      await Browser.open({ url });

      pollIntervalRef.current = setInterval(() => {
        void pollTick(handoffId);
      }, POLL_INTERVAL_MS);
      timeoutRef.current = setTimeout(() => {
        void finishFailure("Sign-in timed out. Please try again.");
      }, POLL_TIMEOUT_MS);
    } catch {
      cleanupTimers();
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
