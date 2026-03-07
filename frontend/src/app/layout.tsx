import type { Metadata } from "next";
import "./globals.css";

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
      <body className="bg-gray-950 text-gray-100 min-h-screen antialiased">
        {children}
      </body>
    </html>
  );
}
