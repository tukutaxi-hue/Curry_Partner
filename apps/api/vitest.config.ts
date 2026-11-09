import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/env.ts"],
    fileParallelism: false,
    hookTimeout: 40000,
    testTimeout: 40000,
  },
});
