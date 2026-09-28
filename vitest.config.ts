import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // PGlite (in-process WASM Postgres) creates a fresh database and runs the
    // full Drizzle migration set per test file. Under parallel load on CI (and
    // on Windows in particular) that setup can exceed Vitest's 10s defaults and
    // fail `beforeAll` with "Hook timed out" — a flake, not a test defect.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
