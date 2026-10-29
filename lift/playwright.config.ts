import { defineConfig } from "@playwright/test";

// E2E runs against the PRODUCTION build (`npm run build` first), served by
// `next start`. Never `next dev` (project rule). Uses the installed Edge, so
// no browser download is needed. Specs are named *.e2e.ts so Vitest ignores them.
// Parallel testers each use their own port (E2E_PORT); the default is 3100.
const PORT = Number(process.env.E2E_PORT ?? 3100);

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
    // lift/.env may hold real keys. NEXT_PUBLIC_* values are inlined at build
    // time, so the build runs with them blank too: with Supabase blank the app
    // is in local-only mode (no /login redirect), and with the AI key blank the
    // AI routes answer 503 "unavailable" (the path the specs assert) and tests
    // never spend API credit.
    command: `npx next build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    env: {
      NEXT_DIST_DIR: `.next-e2e-${PORT}`,
      NEXT_PUBLIC_SUPABASE_URL: "",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      ANTHROPIC_API_KEY: "",
    },
    timeout: 900_000,
  },
});
