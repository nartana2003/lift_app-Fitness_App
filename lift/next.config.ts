import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // E2E builds into its own folder (see playwright.config.ts) so it never overwrites .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // The AI routes read their system prompts from prompts/*.md at runtime.
  outputFileTracingIncludes: {
    "/api/**": ["./prompts/**/*.md"],
  },
};

export default nextConfig;
