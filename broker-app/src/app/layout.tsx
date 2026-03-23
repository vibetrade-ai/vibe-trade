import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/Sidebar";

export const metadata: Metadata = {
  title: "VibeTrade Broker",
  description: "Intent-driven trading interface",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Newsreader:ital,wght@0,400;0,500;1,400;1,500&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body style={{ display: "flex", height: "100vh", overflow: "hidden", margin: 0 }}>
        <Sidebar />
        <main style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          height: "100vh",
          overflowY: "auto",
          minWidth: 0,
        }}>
          {children}
        </main>
      </body>
    </html>
  );
}
