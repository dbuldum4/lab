import type { Metadata, Viewport } from "next";
import { GeistSans, GeistMono } from "geist/font";
import "katex/dist/katex.min.css";
import { THEMES, THEME_STORAGE_KEY } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "lab",
  description: "A local-only, local-first Markdown notepad.",
  applicationName: "lab",
};

export const viewport: Viewport = {
  colorScheme: "dark light",
  themeColor: "#000000",
};

const themeBootScript = `try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});var a=${JSON.stringify(THEMES.map((theme) => theme.id))};document.documentElement.dataset.theme=a.includes(t)?t:"dark"}catch(e){document.documentElement.dataset.theme="dark"}`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const scriptSources = ["'self'", "'unsafe-inline'"];
  if (process.env.NODE_ENV === "development") {
    // React's development client uses eval to reconstruct server-component
    // callstacks. Keep this exception out of production/static exports.
    scriptSources.push("'unsafe-eval'");
  }

  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      data-theme="dark"
      suppressHydrationWarning
    >
      <head>
        <meta
          httpEquiv="Content-Security-Policy"
          content={`default-src 'self'; script-src ${scriptSources.join(" ")}; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'`}
        />
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
