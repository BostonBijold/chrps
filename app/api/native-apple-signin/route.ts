import { NextRequest, NextResponse } from "next/server";
import { signIn } from "@/lib/auth";

// Deliberately a plain GET redirect endpoint, not the app/login/actions.ts
// server action it replaces — that action set the state/nonce cookies via
// a request from the app's own WKWebView, while Apple's callback lands
// inside the separate in-app browser sheet (@capacitor/browser,
// SFSafariViewController on iOS) components/AppleSignInButton.tsx opens;
// those turned out NOT to share a cookie jar (confirmed via a live
// InvalidCheck: state value could not be parsed failure), unlike a plain
// WKWebView-to-Safari handoff, which does. Having the sheet load THIS
// route directly means the cookie-set (via signIn's own cookies().set(),
// which Route Handlers support same as Server Actions) and the eventual
// Apple callback both happen inside the one browsing context the sheet
// owns, start to finish.
//
// Once Apple's callback completes (still inside the sheet), redirectTo
// sends the sheet to app/api/native-handoff/complete instead of the real
// destination directly — the session that Apple's callback just
// established lives only in the sheet's own cookie jar, not the app's own
// WKWebView (confirmed live — the app stayed signed out after the sheet
// closed), so that hop is what actually gets the user signed in inside
// the real app. See models/NativeSignInHandoff.ts for the full handoff.
export async function GET(request: NextRequest) {
  const callbackUrl = request.nextUrl.searchParams.get("callbackUrl") || "/welcome";
  const handoffId = request.nextUrl.searchParams.get("handoffId") || "";
  const completeUrl = new URL("/api/native-handoff/complete", request.url);
  completeUrl.searchParams.set("handoffId", handoffId);
  const url = await signIn("apple", { redirectTo: completeUrl.toString(), redirect: false });
  return NextResponse.redirect(url);
}
