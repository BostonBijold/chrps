import Capacitor
import AuthenticationServices

// Purpose-built replacement for @capacitor/browser's SFSafariViewController
// sheet (components/AppleSignInButton.tsx originally used Browser.open())
// for the native Sign in with Apple flow specifically. That approach
// required this app's own JS to poll for completion and close the sheet
// itself — but live device testing across three rounds of fixes showed
// the app's WKWebView stops running JS entirely while the sheet covers
// it (no poll ticks, no timeout firing, until the user manually dismissed
// the sheet), which makes any JS-driven detection fundamentally
// unreliable, no matter how the polling itself is tuned.
//
// ASWebAuthenticationSession is Apple's own API for exactly this "web
// auth needs to hand control back to the app" problem: iOS itself (not
// this app's WKWebView) watches the session's navigations for one whose
// URL scheme matches callbackURLScheme, and the moment it sees one,
// intercepts it BEFORE actually navigating there, dismisses the sheet,
// and invokes the completion handler below — entirely inside native code,
// independent of whether this app's own JS is running at all.
//
// app/api/native-apple-signin/route.ts's redirectTo can't be
// chrps://native-auth-complete directly — Auth.js validates its own
// callbackUrl cookie against a same-origin http(s) check, rejecting a
// custom scheme outright regardless of any app-level redirect callback.
// Instead it points at the real app/auth/native-complete page, which does
// the actual chrps:// hop client-side, once Apple's own callback and
// lib/auth.ts's jwt callback (which writes the NativeSignInHandoff row
// inline, during that same request) have both finished — this session
// intercepts THAT navigation. Once start() resolves back in
// components/AppleSignInButton.tsx, the app's own WKWebView is guaranteed
// foregrounded and running again, so a single (not polled) check against
// app/api/native-handoff/status can be trusted to actually execute.
@objc(AppleSignInSessionPlugin)
public class AppleSignInSessionPlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "AppleSignInSessionPlugin"
    public let jsName = "AppleSignInSession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
    ]

    // Retained for the lifetime of the session — ASWebAuthenticationSession
    // doesn't keep itself alive, an unretained local would get deallocated
    // (and the session silently cancelled) as soon as start() returns.
    private var session: ASWebAuthenticationSession?

    @objc func start(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString) else {
            call.reject("Missing or invalid url")
            return
        }
        let scheme = call.getString("callbackURLScheme") ?? "chrps"

        // ASWebAuthenticationSession must be created and started on the
        // main thread (it drives UI presentation).
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            let newSession = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { callbackURL, error in
                if let error = error {
                    let nsError = error as NSError
                    if nsError.domain == ASWebAuthenticationSessionErrorDomain,
                       nsError.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                        call.reject("User cancelled")
                    } else {
                        print("[AppleSignInSession] failed: domain=\(nsError.domain) code=\(nsError.code) desc=\(error.localizedDescription)")
                        call.reject(error.localizedDescription)
                    }
                    return
                }
                call.resolve(["url": callbackURL?.absoluteString ?? ""])
            }
            // Without this, ASWebAuthenticationSession shares its cookie
            // jar with Safari and with this app's own PAST sessions —
            // confirmed live: an "InvalidCallbackUrl" error citing a
            // chrps:// value from a since-fixed earlier build, even after
            // the server stopped ever sending that value, because a stale
            // callbackUrl cookie from that older test was still sitting
            // in the shared store and got read back. Ephemeral gives every
            // sign-in attempt a clean jar — cookies set-then-read WITHIN
            // this one session (state/nonce/callbackUrl/native_handoff_id)
            // still work exactly the same, only cross-session/cross-app
            // persistence is what's gone.
            newSession.prefersEphemeralWebBrowserSession = true
            newSession.presentationContextProvider = self
            self.session = newSession
            newSession.start()
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        guard let window = self.bridge?.viewController?.view.window else {
            print("[AppleSignInSession] presentationAnchor: no bridge/viewController/window available, falling back to a bare ASPresentationAnchor()")
            return ASPresentationAnchor()
        }
        return window
    }
}
