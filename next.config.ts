import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The AI routes read their system prompts from prompts/*.md at runtime.
  outputFileTracingIncludes: {
    "/api/**": ["./prompts/**/*.md"],
  },
};

export default nextConfig;
