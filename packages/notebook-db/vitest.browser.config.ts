import { defineConfig } from "vitest/config";

// Runs test-browser/*.browser.test.ts under Node (Playwright drives a real Chromium tab from
// there — this is not vitest's own browser mode). Separate from vitest.config.ts so the default
// `pnpm test` never launches a browser; see the header comment there.
//
// `hookTimeout` is generous because the `beforeAll` builds a real module server that downloads
// and transforms `@duckdb/duckdb-wasm`'s whole dependency graph on a cold cache.
export default defineConfig({
  test: {
    include: ["test-browser/**/*.browser.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
