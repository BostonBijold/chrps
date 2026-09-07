> **Keep this file updated after any code change in this area — do not let it drift from actual implementation.**

# Native Sign in with Apple — In-App Handoff

**Status: BUILT**, but still under active live-device verification — see
["Debug logging left in place"](#debug-logging-left-in-place-on-purpose)
below. This is the fourth iteration of the mechanism; the first three each
failed against a real device in a way the previous one hadn't predicted
(see "Why not simpler" below), so treat this doc's own claims as current
as of the last commit that touched it, not as settled history.

## Why this exists

Sign in with Google works inside the native iOS app (Capacitor) with a
one-line fix — allowlisting `accounts.google.com` in `capacitor.config.ts`'s
`server.allowNavigation` keeps the whole OAuth round-trip inside the app's
own WKWebView and its one cookie jar (see `docs/project-structure.md`).
Apple's own sign-in page refuses to run inside a plain WKWebView at all —
iOS hands navigation to `appleid.apple.com` off to the system browser
regardless of `allowNavigation`, which used to strand the user in
standalone Safari with no way back into the app.

Web (non-native) is unaffected by any of this — it's the same browser tab
throughout, so `AppleSignInButton.tsx` just does a plain top-level redirect
there, same as the Google button.

## Why not simpler (the three approaches that didn't work)

1. **`@capacitor/browser`'s `SFSafariViewController` sheet**, with this
   component's own JS polling for completion and calling `Browser.close()`
   itself. Live device testing across three rounds of fixes showed the
   app's own WKWebView **stops running JS entirely** while that sheet
   covers it — no poll tick, no timeout, ever fired until the user
   manually dismissed the sheet. Any JS-driven detection of "the sheet
   finished" is fundamentally unreliable here, no matter how the polling
   itself is tuned.
2. **A server action, called from the app's own WKWebView**, to set the
   state/nonce cookies before opening the sheet. Confirmed live via an
   `InvalidCheck: state value could not be parsed` failure — the sheet's
   browsing context and the app's own WKWebView don't share a cookie jar
   (`SFSafariViewController` originally, later confirmed true of
   `ASWebAuthenticationSession` too, see the Swift plugin below), so
   cookies set from one side aren't visible on the other.
3. **A follow-up route to write the sign-in handoff record**, called after
   Apple's own OAuth callback finished. A live Vercel trace showed the
   callback's own request getting cut off (`Status: 0`) the moment a user
   tapped the sheet's "Done" button mid-request — so a second, later
   request to write that record simply never landed reliably. The fix
   (below) writes the record inline, synchronously, as part of the same
   request that processes Apple's callback.

## Cross-site cookie fix (`SameSite=None`)

Independent of the in-app-browser handoff above, Apple's own OAuth provider
uses `response_mode: "form_post"` — it **POSTs** its callback rather than
redirecting with a GET, which the browser treats as a cross-site request.
Auth.js's default `state`/`nonce` cookies are `SameSite=Lax`, and `Lax`
cookies are withheld on cross-site POSTs — so the callback could never read
back the state it had just set before redirecting to Apple
(`InvalidCheck: state value could not be parsed`). `lib/auth.config.ts`
sets `state`/`nonce`/`callbackUrl` to `SameSite=None` (production only —
`None` requires `Secure`, which plain `http://localhost` can't set;
Google's redirect-based flow is unaffected either way, since `None` is a
superset of `Lax` for GETs). `callbackUrl` needed the same treatment for
the same reason — without it, Auth.js silently falls back to its own
default redirect target instead of the one actually requested (no error,
just the wrong destination), since that cookie is what carries `redirectTo`
across Apple's cross-site POST too.

This is a separate fix from the in-app-browser handoff described below —
both were needed, diagnosed independently, and both remain in place.

## Architecture

### Components/files

| File | Role |
|---|---|
| `components/AppleSignInButton.tsx` | Entry point. Branches on `Capacitor.isNativePlatform()` — web does a plain redirect, native starts the handoff below. |
| `ios/App/App/AppleSignInSessionPlugin.swift` | Capacitor plugin wrapping `ASWebAuthenticationSession`, Apple's own "open a web page for auth, then hand control back to the app" API. |
| `lib/native/apple-signin-session-bridge.ts` | Thin `registerPlugin` bridge to the Swift plugin (`AppleSignInSession.start()`), no-op-safe on web. |
| `lib/native/apple-signin-session.ts` | `startAppleSignInSession(url)` — always-safe wrapper, resolves to a typed `{status}` result instead of a raw throw. |
| `app/api/native-apple-signin/route.ts` | Plain `GET` redirect endpoint the session navigates to first — starts the actual Apple OAuth flow and, when a handoff is in play, stamps a cookie for the jwt callback to read. |
| `app/auth/native-complete/page.tsx` | Real `https://` landing page Apple's callback redirects to; does the `chrps://` scheme hop client-side. |
| `lib/auth.ts` | `NATIVE_HANDOFF_COOKIE` constant, the `jwt` callback's inline `NativeSignInHandoff` write, and the `Credentials` provider that consumes a handoff to actually sign the app's own WKWebView in. |
| `models/NativeSignInHandoff.ts` | The bridging record itself — single-use, short-lived (TTL-indexed). |
| `app/api/native-handoff/status/route.ts` | Checked (up to 3 short retries, not a long-running poll) by the button after the session resolves; this IS the request that establishes the real session. |
| `middleware.ts` | Excludes `api/native-apple-signin` and `api/native-handoff` from the auth gate — see "Why these routes are public" below. |

### Flow, start to finish

1. `AppleSignInButton.tsx` (native only) generates a `handoffId`
   (`crypto.randomUUID()`) and calls `startAppleSignInSession(url)` with
   `url = /api/native-apple-signin?callbackUrl=<destination>&handoffId=<id>`.
2. `lib/native/apple-signin-session.ts` → the Swift plugin opens an
   `ASWebAuthenticationSession` pointed at that URL, with
   `prefersEphemeralWebBrowserSession = true` (a fresh cookie jar every
   attempt — without this, a stale `callbackUrl`/state cookie from a
   previous sign-in attempt can get read back and produce an
   `InvalidCallbackUrl`, confirmed live).
3. The session loads `app/api/native-apple-signin/route.ts`, which calls
   Auth.js's `signIn("apple", { redirectTo, redirect: false })` itself
   (rather than delegating to a server action) so that the state/nonce
   cookie-set and Apple's eventual callback both happen inside the *same*
   browsing context the session owns, start to finish. It also stamps
   `handoffId` onto the `native_handoff_id` cookie (`NATIVE_HANDOFF_COOKIE`)
   for the jwt callback to read back later, and sets `redirectTo` to the
   real `app/auth/native-complete` page — **not** `chrps://` directly,
   because Auth.js validates its own `callbackUrl` cookie against a
   same-origin `http(s)` check before `lib/auth.config.ts`'s `redirect()`
   callback ever runs, and a custom scheme fails that check outright
   (confirmed live: `InvalidCallbackUrl`, thrown before any custom
   redirect-callback log line printed).
4. User authenticates with Apple. Apple's callback lands back inside the
   session, and `lib/auth.ts`'s `jwt` callback — while processing that
   same callback request, before NextAuth computes any response — reads
   `native_handoff_id` off the cookie and, if present, `NativeSignInHandoff.create()`s
   a row (`{ handoffId, userId, expiresAt: now + 5min }`), then deletes the
   cookie. This inline write is the fix for failure mode #3 above.
5. NextAuth redirects to `app/auth/native-complete`, which renders inside
   the *session's* browsing context (not the app's own WKWebView, so its
   JS is guaranteed to actually run — unlike the app's own WKWebView,
   which testing showed stops running JS behind a covering sheet). On
   load, it does `window.location.replace("chrps://native-auth-complete")`.
6. iOS's `ASWebAuthenticationSession` intercepts that navigation *before*
   actually navigating there (because its scheme matches the session's
   `callbackURLScheme: "chrps"`), auto-dismisses the sheet, and resolves
   the plugin's `start()` call back in `apple-signin-session-bridge.ts`.
7. `AppleSignInButton.tsx`'s `startAppleSignInSession()` call resolves.
   The app's own WKWebView is now guaranteed foregrounded and running
   again (native code did the dismissal, independent of whether the
   WKWebView's JS was alive at all). The button calls
   `GET /api/native-handoff/status?handoffId=<id>` — up to 3 attempts,
   500ms apart, covering only this fetch's own round trip, not the
   underlying handoff write (already done by step 4, synchronously).
8. That route calls `signIn("credentials", { handoffId, redirect: false })`.
   The `Credentials` provider's `authorize()` (`lib/auth.ts`) does an
   atomic `findOneAndUpdate({ handoffId, consumed: false, expiresAt: {$gt: now}}, {$set: {consumed: true}})`
   — single-use, same shape as `models/Invite.ts`'s
   token-with-expiry convention — resolves the `User`, and signs this
   request (now correctly originating from the app's own WKWebView) in
   for real.
9. On `{ done: true }`, the button does `window.location.href = destination`.

### Why these routes are public (`middleware.ts`)

`api/native-apple-signin` needs to be reachable before any session exists
(it's what starts the sign-in). `api/native-handoff/status` **is the
request that establishes the session** — there's nothing to gate it on
yet, and its own `signIn("credentials", ...)` call is itself protected by
`NativeSignInHandoff`'s single-use + short expiry, so there's no
meaningful abuse window even without a session cookie already present.

### Data model

```ts
// models/NativeSignInHandoff.ts
{
  handoffId: string,   // unique, generated client-side by AppleSignInButton.tsx
  userId: string,
  consumed: boolean,   // default false
  createdAt: Date,
  expiresAt: Date,     // now + 5 minutes at creation; TTL-indexed, Mongo auto-deletes past this
}
```

No soft-delete/audit convention here (unlike `Invite`) — a stale handoff
has no audit value, so the TTL index just removes it once expired.

## Debug logging left in place (on purpose)

`lib/auth.ts`'s `jwt`/`session` callbacks and the native handoff routes
carry `console.log` lines at nearly every step (`[auth] jwt callback —`,
`[native-handoff/status] handoffId:`, etc.) that a finished, stable feature
normally wouldn't keep. They're intentional here: three prior redesigns of
this exact flow were each diagnosed from a live Vercel/Xcode trace, not
from local reproduction, so the logging stays until this fourth version
has enough real-device mileage to trust removing it. Don't strip these
without deliberately re-confirming the flow on a physical device first.

## Open questions / deferred

- No test coverage — this flow only ever gets validated live, on a real
  iOS device (Capacitor + `ASWebAuthenticationSession` don't meaningfully
  simulate in a browser or the iOS Simulator's own web views).
- No equivalent handoff exists for Google sign-in — not needed today,
  since the WKWebView `allowNavigation` allowlist keeps that flow entirely
  inside the app's own cookie jar with no split-context problem to solve.
  If that ever changes, this doc's mechanism is the template to reuse.
- The 3-attempt/500ms retry loop in `AppleSignInButton.tsx` on
  `native-handoff/status` is an arbitrary choice, not derived from any
  measured latency — revisit if real-device testing shows it's too tight
  or needlessly loose.

## Depends on

[`project-structure.md`](../project-structure.md) for the plain Google
OAuth-in-WebView approach this flow deliberately diverges from, and for
where `lib/`/`lib/native/` files are catalogued generally.
