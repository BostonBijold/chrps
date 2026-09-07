import { Schema, model, models } from "mongoose";

// Bridges a Sign in with Apple flow completed inside a dedicated in-app
// auth session (ios/App/App/AppleSignInSessionPlugin.swift's
// ASWebAuthenticationSession) back into the native app's own WKWebView —
// those two turned out not to share a cookie jar (confirmed live via
// InvalidCheck, then again by the app staying signed out afterward), so
// the session Apple's callback establishes can't just be picked up by the
// app on its own. handoffId is generated client-side by
// components/AppleSignInButton.tsx before the session opens; lib/auth.ts's
// jwt callback writes this row inline while processing Apple's own OAuth
// callback (reading handoffId back off a cookie app/api/native-apple-signin
// set before the session ever navigated to Apple) — not via any later
// request, since an earlier design that wrote this row from a follow-up
// route instead broke the moment a user closed the (previous,
// @capacitor/browser-based) sheet before that follow-up request landed —
// a live Vercel trace showed the callback's own POST getting cut off
// mid-request. Once AppleSignInSessionPlugin.swift's session resolves
// (iOS itself intercepts the flow's final redirect and auto-dismisses,
// independent of whether this app's own WKWebView JS is even running —
// see that file for the full history of why), the app's own WKWebView is
// guaranteed foregrounded again, and app/api/native-handoff/status's
// single check, on a match, signs that same user in for real via
// lib/auth.ts's Credentials provider — a request now correctly
// originating from the app's own WKWebView. Single-use (consumed) and
// short-lived (expiresAt), same unguessable-token-with-expiry shape as
// models/Invite.ts.
const NativeSignInHandoffSchema = new Schema({
  handoffId: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true },
  consumed: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
});

// TTL index — Mongo auto-deletes the row once expiresAt passes, no cron
// needed (this collection has no other cleanup path, unlike Invite's
// soft-delete convention, since a stale handoff has no audit value).
NativeSignInHandoffSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default models.NativeSignInHandoff || model("NativeSignInHandoff", NativeSignInHandoffSchema);
