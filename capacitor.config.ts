import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.bostonbijold.chrps',
  appName: "Ch'rps",
  webDir: 'public',
  server: {
    url: 'https://chrps.vercel.app',
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
      style: 'dark'
    }
  }
};

export default config;
