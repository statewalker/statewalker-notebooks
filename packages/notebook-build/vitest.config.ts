import { defineConfig } from "vitest/config";

// The default `test` script must stay fast and browser-free. `test-browser/` drives a real
// Chromium through Playwright and downloads a real npm dependency graph on a cold cache; it is
// run separately with `pnpm test:browser` / `vitest.browser.config.ts`.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "test-browser/**"],
  },
});
