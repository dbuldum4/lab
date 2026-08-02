import type { NextConfig } from "next";

const isGitHubPages = process.env.GITHUB_ACTIONS === "true";

const nextConfig: NextConfig = {
  output: "export",
  basePath: isGitHubPages ? "/lab" : "",
  trailingSlash: true,
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
};

export default nextConfig;
