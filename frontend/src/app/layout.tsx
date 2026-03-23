import type { Metadata } from "next";
import { DM_Sans } from "next/font/google";
import "./globals.css";

const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-dm-sans",
});

export const metadata: Metadata = {
  title: {
    default: "Vibe Trade — AI Trading Assistant for Indian Stock Markets",
    template: "%s | Vibe Trade",
  },
  description:
    "AI-powered trading agent for NSE stocks. Describe your strategy in plain English — Vibe Trade writes the Playbook, monitors the market, and executes trades through your Dhan broker account. Powered by Claude.",
  keywords: [
    "AI trading assistant",
    "Indian stock market",
    "NSE trading",
    "Claude AI trading",
    "Dhan trading automation",
    "algorithmic trading India",
    "intraday trading",
    "Vibe Trade",
    "automated stock trading",
  ],
  authors: [{ name: "Vibe Trade" }],
  creator: "Vibe Trade",
  metadataBase: new URL("https://vibetrade.ai"),
  openGraph: {
    type: "website",
    locale: "en_IN",
    siteName: "Vibe Trade",
    title: "Vibe Trade — AI Trading Assistant for Indian Stock Markets",
    description:
      "Describe your trading strategy in plain English. The AI agent writes the Playbook, monitors the market, and executes through your broker.",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "Vibe Trade — AI-powered trading assistant for Indian stock markets",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Vibe Trade — AI Trading Assistant for Indian Stock Markets",
    description:
      "Describe your trading strategy in plain English. The AI agent monitors and executes through your broker.",
    images: ["/og-image.png"],
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "32x32" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  manifest: "/manifest.json",
  other: {
    "theme-color": "#4DFF4D",
  },
  appleWebApp: {
    title: "Vibe Trade",
    statusBarStyle: "black-translucent",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${dmSans.variable} font-sans bg-gray-950 text-gray-100 min-h-screen antialiased`} style={{ fontFamily: "var(--font-dm-sans)", fontSize: "14px", fontWeight: 500 }}>
        {children}
      </body>
    </html>
  );
}
