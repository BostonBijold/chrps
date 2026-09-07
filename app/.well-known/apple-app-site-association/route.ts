import { NextResponse } from "next/server";

// Universal Links config for the NFC feature (see docs/features/nfc.md) —
// scoped to /nfc/* only, not the whole site. Served as a route handler
// rather than a static public/ file so Content-Type: application/json is
// guaranteed regardless of static-file content-type quirks; Apple fetches
// this over HTTPS with no redirect allowed.
//
// Sign in with Apple's in-app-browser flow (components/AppleSignInButton.tsx)
// briefly used /welcome and /tasks here too, relying on Universal Links to
// auto-close the sheet — dropped in favor of an explicit handoffId polling
// mechanism (models/NativeSignInHandoff.ts) after that auto-close proved
// unreliable in testing.
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
          paths: ["/nfc/*"],
        },
      ],
    },
  });
}
