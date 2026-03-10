import type { Metadata } from "next";
import { DM_Sans } from "next/font/google";
import "./globals.css";

const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-dm-sans",
});

export const metadata: Metadata = {
  title: "VibeTrade",
  description: "AI-powered trading assistant for your Dhan account",
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
