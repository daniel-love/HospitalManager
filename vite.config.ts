import { fileURLToPath, URL } from "node:url";
import preact from "@preact/preset-vite";
import { defineConfig } from "vitest/config";

const dir = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [preact()],
  resolve: {
    alias: {
      "@sim": dir("./src/sim"),
      "@data": dir("./src/data"),
      "@render": dir("./src/render"),
      "@ui": dir("./src/ui"),
      "@game": dir("./src/game"),
      "@save": dir("./src/save"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Multi-day headless simulations take a second or two each, and longer
    // when every test file runs in parallel.
    testTimeout: 20_000,
  },
});
