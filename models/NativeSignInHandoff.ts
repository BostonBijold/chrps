import { Schema, model, models } from "mongoose";

// Bridges a Sign in with Apple flow completed inside the @capacitor/browser
// in-app sheet (SFSafariViewController) back into the native app's own
// WKWebView — those two turned out not to share a cookie jar (confirmed
// live via InvalidCheck, then again by the app staying signed out after
// the sheet closed), so the session established in the sheet can't just
// be picked up by the app on its own. handoffId is generated client-side
// by components/AppleSignInButton.tsx before the sheet opens; app/api/
// native-handoff/complete writes this row once sign-in finishes inside
// the sheet (with a real session to read); app/api/native-handoff/status
// is polled by the app's own webview after the sheet closes and, on a
// match, signs that same user in for real via lib/auth.ts's Credentials
// provider — a request now correctly originating from the app's own
// WKWebView. Single-use (consumed) and short-lived (expiresAt), same
// unguessable-token-with-expiry shape as models/Invite.ts.
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
