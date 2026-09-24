import { configDefaults, defineConfig } from "vitest/config";

// The default `test` script must stay fast and browser-free. `test-browser/` drives a real
// Chromium through Playwright and downloads a real npm dependency graph on a cold cache; it is
// run separately with `pnpm test:browser` / `vitest.browser.config.ts`.
//
// `exclude` REPLACES vitest's default list rather than extending it, so the defaults are spread
// back in explicitly. Writing just `["test-browser/**"]` silently re-enables node_modules and
// dist, which is fine until the day something there ships a `.test.js`.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "test-browser/**"],
  },
});
