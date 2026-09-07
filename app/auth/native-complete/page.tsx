// Shown inside the @capacitor/browser in-app sheet right after Apple's
// OAuth callback redirects here — see app/api/native-apple-signin/route.ts
// and lib/auth.ts's jwt callback, which writes the NativeSignInHandoff row
// inline during that callback (before this page ever loads), not via any
// request this page or its close triggers. Purely transitional:
// components/AppleSignInButton.tsx is polling app/api/native-handoff/status
// from the app's own webview while this renders, and closes this sheet
// itself the moment that succeeds. The sheet's own "Done" button still
// works as a manual fallback if the app hasn't auto-closed it yet.
export default function NativeAuthCompletePage() {
  return (
    <main className="min-h-dvh bg-bg flex flex-col items-center justify-center p-6 text-center">
      <div
        className="w-8 h-8 rounded-full border-2 border-border border-t-olive animate-spin mb-4"
        aria-hidden="true"
      />
      <h1 className="font-brand font-bold text-2xl text-text mb-3">You&apos;re signed in</h1>
      <p className="text-muted text-sm max-w-mobile">Returning to the app&hellip;</p>
    </main>
  );
}
