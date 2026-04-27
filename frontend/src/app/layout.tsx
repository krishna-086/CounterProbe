/**
 * Root layout for the FairLens app.
 *
 * Single-flow app, so we use a top navbar instead of a sidebar — the CVE
 * cards and comparison table need the full page width to breathe.
 *
 * Geist Sans is the UI font; Geist Mono is available via `font-mono` for
 * tabular data, predictions, and code blocks.
 */

import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { ConnectionBanner } from "@/components/ConnectionBanner";
import { Topbar } from "@/components/Topbar";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "CounterProbe — Adversarial Fairness Testing",
  description:
    "Red-team your ML models for hidden bias with counterfactual probing.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-background font-sans text-foreground">
        <ConnectionBanner />
        <Topbar />
        <main className="bg-background text-foreground">{children}</main>
      </body>
    </html>
  );
}
