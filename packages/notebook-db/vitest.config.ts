import { configDefaults, defineConfig } from "vitest/config";

// The default `test` script must stay fast and browser-free. `test-browser/` drives a real
// Chromium through Playwright and downloads a real npm dependency graph on a cold cache; it is
// run separately with `pnpm test:browser` / `vitest.browser.config.ts`.
//
// `exclude` REPLACES vitest's default list rather than extending it, so the defaults are spread
// back in explicitly — see the identical note in notebook-build's `vitest.config.ts`.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "test-browser/**"],
  },
});
