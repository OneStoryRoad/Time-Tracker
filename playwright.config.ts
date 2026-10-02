import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  timeout: 45000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:8000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      executablePath: "/usr/bin/chromium",
      args: ["--no-sandbox"],
    },
    timezoneId: "UTC",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { viewport: { width: 1440, height: 1000 } },
    },
    {
      name: "iphone-sized-chromium",
      use: { ...devices["iPhone 13"], browserName: "chromium" },
    },
  ],
});
