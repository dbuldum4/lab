import type { Metadata } from "next";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const metadata: Metadata = {
  title: "Third-party theme notices · lab",
  description: "Licenses and attribution for the color themes available in lab.",
};

export default function ThirdPartyNoticesPage() {
  const notices = readFileSync(join(process.cwd(), "THIRD_PARTY_NOTICES.md"), "utf8");

  return (
    <main className="notices-page">
      <a className="notices-back" href="../">← Back to lab</a>
      <h1>Third-party theme notices</h1>
      <p>Licenses and attribution for the adapted color themes included in lab.</p>
      <pre>{notices}</pre>
    </main>
  );
}
