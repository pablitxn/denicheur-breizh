import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: ["collector.e2e.spec.ts", "collector-detail.e2e.spec.ts"],
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { outputFolder: "playwright-report/collector", open: "never" }]],
  outputDir: "test-results/collector",
  use: { baseURL: "http://127.0.0.1:14175", locale: "en-US", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "collector-chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm --filter @denicheur-breizh/collector-api exec node --import tsx src/test-server.ts",
      env: { COLLECTOR_TEST_MODE: "1" },
      url: "http://127.0.0.1:14315/health",
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe", stderr: "pipe",
    },
    {
      command: "pnpm --filter @denicheur-breizh/collector-web exec vite --host 127.0.0.1 --port 14175 --strictPort",
      env: { COLLECTOR_API_UPSTREAM: "http://127.0.0.1:14315" },
      url: "http://127.0.0.1:14175",
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe", stderr: "pipe",
    },
  ],
});
