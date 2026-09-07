import UIKit
import Capacitor

class MainViewController: CAPBridgeViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        self.webView?.scrollView.bounces = false
    }

    // Explicit registration for plugins compiled directly into the app
    // target, not shipped via SPM/npm like the stock Capacitor plugins.
    // Belt-and-suspenders alongside their CAPBridgedPlugin conformance
    // (which should auto-discover them, but this guarantees registration
    // regardless). ApiKeyBridgePlugin used to be registered here too — see
    // docs/features/nfc.md's "Shortcuts-driven silent triggers" note on why
    // the API-key/Shortcuts mechanism it backed was removed entirely.
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(LiveActivityPlugin())
        bridge?.registerPluginInstance(NfcScanPlugin())
        bridge?.registerPluginInstance(AppleSignInSessionPlugin())
    }
}
