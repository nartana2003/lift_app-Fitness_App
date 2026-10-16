import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname) } },
  // tsconfig has jsx: "preserve" for Next.js; tests need JSX compiled.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    // Default stays node. Component tests opt in per file with a
    // `// @vitest-environment jsdom` docblock.
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
  },
});
