import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.bostonbijold.chrps',
  appName: "Ch'rps",
  webDir: 'public',
  server: {
    url: 'https://www.chrps.app',
    cleartext: false,
    allowNavigation: ['accounts.google.com', 'appleid.apple.com']
  },
  ios: {
    backgroundColor: '#ffffff'
  },
  plugins: {
    SplashScreen: {
      backgroundColor: '#ffffff',
      showSpinner: false
    },
    StatusBar: {
      // Capacitor's naming is inverted from what it sounds like: style
      // 'dark' maps to iOS's .lightContent (white time/battery text, meant
      // for a dark status bar background), and 'light' maps to
      // .darkContent (black text, meant for a light background). This
      // app's header is white (#ffffff), so 'dark' was rendering white
      // status bar text on white — invisible. 'light' is correct here.
      style: 'light'
    }
  }
};

export default config;
