import type { Metadata, Viewport } from "next";
import { GeistSans, GeistMono } from "geist/font";
import "./globals.css";

export const metadata: Metadata = {
  title: "lab",
  description: "A local-only, local-first Markdown notepad.",
  applicationName: "lab",
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#000000",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
