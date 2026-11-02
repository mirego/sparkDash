import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  testMatch: "**/*.e2e.ts",
  timeout: 30_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://127.0.0.1:5599",
    video: process.env.E2E_VIDEO === "1" ? "on" : "off",
    browserName: "chromium",
    launchOptions: {
      executablePath: process.env.E2E_CHROMIUM_PATH || undefined,
      headless: process.env.HEADED === "1" ? false : true,
    },
    viewport: { width: 1440, height: 900 },
  },
  outputDir: "test-results",
  reporter: [["list"]],
});
