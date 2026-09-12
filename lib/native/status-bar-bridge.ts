import { Capacitor } from "@capacitor/core";
import { StatusBar, Style } from "@capacitor/status-bar";

// capacitor.config.ts's StatusBar.style sets the app-wide default (dark/
// black text, correct for this app's white page backgrounds). A couple of
// screens paint a full-bleed blue backdrop that extends under the status
// bar itself — TaskFormScreen's outer layer and TaskListSessionView's
// summary/receipt screen (see both files' own "blue backdrop" comments) —
// and need white text there instead, or the time/battery/signal read
// invisible against the white default the same way they used to read
// invisible against the old all-white-app 'dark' (i.e. lightContent/white
// text) config. lib/client/use-status-bar-style.ts calls this from those
// screens; every other screen never touches it and keeps the config default.
export async function setStatusBarStyle(background: "white" | "blue") {
  if (!Capacitor.isNativePlatform()) return;

  try {
    await StatusBar.setStyle({ style: background === "blue" ? Style.Dark : Style.Light });
  } catch (err) {
    console.error("[status-bar] setStyle failed", err);
  }
}
