import { NextRequest, NextResponse } from "next/server";
import { signIn } from "@/lib/auth";

// Polled by components/AppleSignInButton.tsx from the app's OWN webview
// once the in-app browser sheet closes (whether Universal Links closed it
// automatically or the user tapped the sheet's own Done button — either
// way this is a plain fetch originating from the app's real WKWebView, not
// the sheet). Deliberately public — see middleware.ts's exclusion list —
// since this IS the request that establishes a session, there's nothing to
// gate it on yet. signIn's own handoffId lookup (lib/auth.ts's Credentials
// provider) is single-use and short-lived, so there's no meaningful window
// to abuse even without a session cookie already present.
export async function GET(request: NextRequest) {
  const handoffId = request.nextUrl.searchParams.get("handoffId");
  if (!handoffId) return NextResponse.json({ done: false });

  const resultUrl = await signIn("credentials", { handoffId, redirect: false }).catch(() => null);
  const done = !!resultUrl && !resultUrl.includes("error=");
  return NextResponse.json({ done });
}
