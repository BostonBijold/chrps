import { Schema, model, models } from "mongoose";

// Bridges a Sign in with Apple flow completed inside the @capacitor/browser
// in-app sheet (SFSafariViewController) back into the native app's own
// WKWebView — those two turned out not to share a cookie jar (confirmed
// live via InvalidCheck, then again by the app staying signed out after
// the sheet closed), so the session established in the sheet can't just
// be picked up by the app on its own. handoffId is generated client-side
// by components/AppleSignInButton.tsx before the sheet opens; lib/auth.ts's
// jwt callback writes this row inline while processing Apple's own OAuth
// callback (reading handoffId back off a cookie app/api/native-apple-signin
// set before the sheet ever navigated to Apple) — not via any later
// request, since a live device trace showed the callback's own POST
// getting cut off mid-request the moment a user closed the sheet, which
// silently dropped an earlier design that wrote this row from a follow-up
// route instead. app/api/native-handoff/status is polled by the app's own
// webview while the sheet is still open and, on a match, signs that same
// user in for real via lib/auth.ts's Credentials provider — a request now
// correctly originating from the app's own WKWebView. Single-use
// (consumed) and short-lived (expiresAt), same unguessable-token-with-expiry
// shape as models/Invite.ts.
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
