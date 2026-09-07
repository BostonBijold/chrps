import { NextResponse } from "next/server";

// Universal Links config for the NFC feature (see docs/features/nfc.md) —
// scoped to /nfc/* only, not the whole site — plus /welcome and /tasks for
// the Sign in with Apple in-app-browser flow (see
// docs/features/task-completion-photo.md's App Store submission notes and
// components/AppleSignInButton.tsx): Apple's own auth page can't run
// inside Capacitor's WKWebView (iOS hands it to an in-app Safari sheet via
// @capacitor/browser instead), so the only way back into the app once
// sign-in finishes is Universal Links intercepting the post-auth landing
// page and closing that sheet — components/UniversalLinkHandler.tsx does
// the actual in-app routing once that handoff fires. Not widened to the
// whole site, same deliberate scoping as /nfc/*.
//
// appID's team ID (X3DPK5Y29G) is the paid Developer Program team — update
// this (and ios/App/App.xcodeproj's DEVELOPMENT_TEAM) together if the app
// is ever re-signed under a different team, or Universal Links will
// silently stop matching.
export async function GET() {
  return NextResponse.json({
    applinks: {
      apps: [],
      details: [
        {
          appID: "X3DPK5Y29G.com.bostonbijold.chrps",
          paths: ["/nfc/*", "/welcome", "/tasks"],
        },
      ],
    },
  });
}
