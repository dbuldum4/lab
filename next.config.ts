import type { NextConfig } from "next";

const isGitHubPages = process.env.LAB_GITHUB_PAGES_BUILD === "true";

const nextConfig: NextConfig = {
  agentRules: false,
  output: "export",
  basePath: isGitHubPages ? "/lab" : "",
  trailingSlash: true,
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
};

export default nextConfig;
