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
    // The suite has ~170 files; on a loaded machine the 5 s default times out tests that pass alone.
    testTimeout: 20000,
    setupFiles: ["./vitest.setup.ts"],
  },
});
