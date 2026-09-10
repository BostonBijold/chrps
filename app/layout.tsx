import type { Metadata, Viewport } from "next";
import { Playfair_Display, IBM_Plex_Mono, Inter, Fredoka } from "next/font/google";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import NativeBootstrap from "@/components/NativeBootstrap";
import NetworkStatusProvider from "@/components/NetworkStatusProvider";
import "./globals.css";

const playfair = Playfair_Display({
  subsets: ["latin"],
  variable: "--font-playfair",
  display: "swap",
});

const ibmMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-ibm-mono",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const fredoka = Fredoka({
  subsets: ["latin"],
  weight: ["500", "600"],
  variable: "--font-fredoka",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Ch'rps",
  description: "Shift checks, done right, every time.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Ch'rps",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${playfair.variable} ${ibmMono.variable} ${inter.variable} ${fredoka.variable}`}
    >
      <body className="h-full bg-bg text-text font-body">
        <NetworkStatusProvider>
          {children}
        </NetworkStatusProvider>
        <ServiceWorkerRegister />
        <NativeBootstrap />
      </body>
    </html>
  );
}
