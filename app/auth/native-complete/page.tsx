// Shown inside the @capacitor/browser in-app sheet after Sign in with
// Apple finishes — see app/api/native-handoff/complete/route.ts. Purely
// informational: the actual sign-in-into-the-app handoff happens once the
// user dismisses this sheet (SFSafariViewController's own Done button) and
// components/AppleSignInButton.tsx's browserFinished listener polls
// app/api/native-handoff/status from the app's own webview.
export default function NativeAuthCompletePage() {
  return (
    <main className="min-h-dvh bg-bg flex flex-col items-center justify-center p-6 text-center">
      <h1 className="font-brand font-bold text-2xl text-text mb-3">You&apos;re signed in</h1>
      <p className="text-muted text-sm max-w-mobile">
        Tap &quot;Done&quot; above to return to the Ch&apos;rps app.
      </p>
    </main>
  );
}
