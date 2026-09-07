import { Capacitor } from "@capacitor/core";
import { AppleSignInSession } from "@/lib/native/apple-signin-session-bridge";

export type AppleSignInSessionResult =
  | { status: "ok" }
  | { status: "cancelled" }
  | { status: "unsupported" } // web/PWA
  | { status: "error"; message: string };

// Thin, always-safe wrapper around lib/native/apple-signin-session-bridge.ts,
// same shape as lib/native/nfc-scan.ts.
export async function startAppleSignInSession(url: string): Promise<AppleSignInSessionResult> {
  if (!Capacitor.isNativePlatform()) return { status: "unsupported" };
  try {
    await AppleSignInSession.start({ url, callbackURLScheme: "chrps" });
    return { status: "ok" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "User cancelled") return { status: "cancelled" };
    return { status: "error", message };
  }
}
