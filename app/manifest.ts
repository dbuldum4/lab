import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  const basePath = process.env.LAB_GITHUB_PAGES_BUILD === "true" ? "/lab" : "";
  return {
    name: "lab",
    short_name: "lab",
    description: "A local-only, local-first Markdown notepad.",
    start_url: `${basePath || ""}/`,
    scope: `${basePath || ""}/`,
    display: "standalone",
    background_color: "#000000",
    theme_color: "#000000",
    icons: [
      {
        src: `${basePath}/lab-icon.svg`,
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  };
}
