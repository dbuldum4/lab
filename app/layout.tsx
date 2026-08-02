import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { GeistSans, GeistMono } from "geist/font";
import "./globals.css";

// A nonce is generated per request by proxy.ts, so this page must render per request.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "lab",
  description: "A local-only, local-first Markdown notepad.",
  applicationName: "lab",
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#000000",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body data-csp-nonce={nonce}>{children}</body>
    </html>
  );
}
