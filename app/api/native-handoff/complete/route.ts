import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { connectDB } from "@/lib/mongoose";
import NativeSignInHandoff from "@/models/NativeSignInHandoff";

// Runs while still inside the @capacitor/browser in-app sheet, right after
// Apple's OAuth callback finishes and sets that sheet's own session cookie
// — see app/api/native-apple-signin/route.ts's redirectTo and
// models/NativeSignInHandoff.ts for why this hop exists at all. Writes a
// short-lived record keyed by the handoffId components/AppleSignInButton.tsx
// generated before the sheet ever opened, so app/api/native-handoff/status
// (polled from the app's own webview once the sheet closes) can pick this
// user up and sign them in for real, outside the sheet.
export async function GET(request: NextRequest) {
  const session = await auth();
  const handoffId = request.nextUrl.searchParams.get("handoffId");
  if (!session?.user?.id || !handoffId) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  await connectDB();
  await NativeSignInHandoff.create({
    handoffId,
    userId: session.user.id,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  });

  return NextResponse.redirect(new URL("/auth/native-complete", request.url));
}
