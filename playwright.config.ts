import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: "**/browser-smoke.spec.ts",
    },
    {
      name: "webkit-smoke",
      testMatch: "**/browser-smoke.spec.ts",
      grep: /@browser-smoke/,
      use: { ...devices["Desktop Safari"], browserName: "webkit" },
    },
    {
      name: "firefox-smoke",
      testMatch: "**/browser-smoke.spec.ts",
      grep: /@browser-smoke/,
      use: { ...devices["Desktop Firefox"], browserName: "firefox" },
    },
  ],
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVER === "1",
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
