import { defineConfig } from "@playwright/test";

// E2E runs against the PRODUCTION build (`npm run build` first), served by
// `next start`. Never `next dev` (project rule). Uses the installed Edge, so
// no browser download is needed. Specs are named *.e2e.ts so Vitest ignores them.
const PORT = 3100;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 30_000,
  fullyParallel: true,
  retries: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: "msedge",
    viewport: { width: 390, height: 844 },
    trace: "off",
  },
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
