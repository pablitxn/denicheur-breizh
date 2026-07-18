import { defineConfig, devices } from "@playwright/test";

const isCi = Boolean(process.env.CI);
const apiServer = {
  command: "DENICHEUR_DB_PATH=:memory: FILTER_API_PORT=14310 FILTER_API_ALLOWED_ORIGINS=http://127.0.0.1:14173,chrome-extension://oekklajlieiinmjcmhdfeodpdhahhjdi pnpm --filter @denicheur-breizh/api start",
  url: "http://127.0.0.1:14310/health",
  reuseExistingServer: false,
  timeout: 30_000,
  stdout: "pipe" as const,
  stderr: "pipe" as const,
};

const webServer = {
  command: "pnpm --filter @denicheur-breizh/web exec vite preview --host 127.0.0.1 --port 14173",
  url: "http://127.0.0.1:14173",
  reuseExistingServer: !isCi,
  timeout: 30_000,
  stdout: "pipe" as const,
  stderr: "pipe" as const,
};

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: isCi,
  retries: isCi ? 2 : 0,
  timeout: 30_000,
  expect: {
    timeout: 8_000,
  },
  reporter: [["list"], ["html", { open: "never" }]],
  outputDir: "test-results",
  use: {
    baseURL: "http://127.0.0.1:14173",
    channel: "chromium",
    locale: "fr-FR",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [apiServer, webServer],
});
