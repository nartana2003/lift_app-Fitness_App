// Shared Vitest setup. Runs for every test file, node or jsdom.
import "fake-indexeddb/auto";
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

// React Testing Library is only loaded in DOM environments (files that opt in
// with `// @vitest-environment jsdom`), so node-only tests stay lightweight.
if (typeof window !== "undefined") {
  const { cleanup } = await import("@testing-library/react");
  afterEach(() => cleanup());
}
