import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pure-unit tests only. Anything needing D1, R2, or a live Worker
    // belongs in scripts/verify-*.mjs, per the existing convention.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
