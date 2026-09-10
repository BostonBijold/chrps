import { registerPlugin } from "@capacitor/core";

// Bridges to ios/App/App/NfcScanPlugin.swift — an explicit, foreground,
// user-initiated NFC read (the tap-to-trigger Universal Link system this
// used to be distinguished from has since been removed entirely — see
// docs/features/nfc.md's "History: Tap-to-trigger (removed)" and its
// "In-app scan-to-complete binding" section). No-op-safe to call
// on web/PWA: registerPlugin resolves to a stub there that rejects every
// call, and lib/native/nfc-scan.ts additionally guards with
// Capacitor.isNativePlatform() before ever calling it.
interface NfcScanPlugin {
  // Resolves once a tag is detected and read; uid is lowercase hex of the
  // tag's raw identifier bytes. Rejects if the user cancels the system NFC
  // sheet, the read times out, or the device has no NFC hardware.
  scan(): Promise<{ uid: string }>;
}

export const NfcScan = registerPlugin<NfcScanPlugin>("NfcScan");
