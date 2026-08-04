import type { Metadata, Viewport } from "next";
import { GeistSans, GeistMono } from "geist/font";
import "katex/dist/katex.min.css";
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
  const scriptSources = ["'self'", "'unsafe-inline'"];
  if (process.env.NODE_ENV === "development") {
    // React's development client uses eval to reconstruct server-component
    // callstacks. Keep this exception out of production/static exports.
    scriptSources.push("'unsafe-eval'");
  }

  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <head>
        <meta
          httpEquiv="Content-Security-Policy"
          content={`default-src 'self'; script-src ${scriptSources.join(" ")}; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'`}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
