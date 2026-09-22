import { defineConfig, devices } from "@playwright/test";

/**
 * E2E harness. No specs in slice 1 — the testDir (./e2e) will be populated
 * in slice 5 (upload -> review -> approve -> emit returns CAE with fakes).
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "html",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
