// Proves the central claim of `@statewalker/notebook-site`'s design: the SAME `SiteHandler`
// that `src/site.test.ts` exercises under Node also runs, unchanged, BEHIND a real
// ServiceWorker — hosted in the page, not in worker scope. Be precise about that, because the
// stronger claim this comment used to make ("runs in a real ServiceWorker") is false:
// `@statewalker/webrun-http-browser` splits the two halves. `SwHttpDispatcher` is what lives in
// the worker, and all it does is intercept `fetch` and relay the request over a `MessagePort`.
// `SwHttpAdapter` — a PAGE-side object — holds the registered handlers and is what invokes the
// `SiteHandler`. Two proofs: a thrown error's stack points into the page bundle, and inserting
// a `document.title` reference into `newNotebookSite` leaves all these tests green.
//
// So what this file demonstrates is the real, valuable thing — the handler survives the
// ServiceWorker request path, the URL rewriting, the MessagePort round-trip and a real
// `EventSource` — and not worker-scope execution. `tsconfig.json`'s DOM-free `lib` is a
// COMPILE-TIME guard on the shipped package; it is not runtime proof that the handler never
// touches the DOM, and this project's own rule is that compile checks are not runtime checks.
// Nothing here executes `src/` in worker scope, and nothing should be read as if it did.
//
// Drives a real Chromium tab (via Playwright) against a real SW registered by
// `@statewalker/webrun-site-host`'s `HostedSiteBuilder`, using `@statewalker/webrun-http-browser`'s
// own published `sw-worker.js` — nothing here is faked. Reuses the fixture-server pattern from
// `packages/notebook-events/test-browser/` rather than inventing a second one; one page for the
// whole suite, exactly as that package does (registering the same site key twice from two
// different page instances is untested territory this file has no reason to explore).
//
// A browser test that passes when the thing under test is broken is worse than no test at all,
// because it's the one everyone trusts. Two defenses against that:
//
//   1. `pageerror` alone is a weak assertion — a completely dead page can leave it empty for a
//      long time while failing only via `console.error` (learned the hard way in the sibling
//      `notebook-events` package: a dead page stayed silent on `pageerror` for 60s). So this
//      file listens on BOTH `pageerror` and `console` (for `error`-level messages) and asserts,
//      after every test, that neither channel produced anything new.
//   2. Every one of the three tests below was proven to go red against a deliberately broken
//      handler before being trusted; see task-3-report.md for the transcripts.
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFixtureServer } from "./server.js";

let browser: Browser;
let page: Page;
let stop: () => Promise<void>;
const consoleErrors: string[] = [];
const pageErrors: string[] = [];

beforeAll(async () => {
  ({ stop } = await startFixtureServer(8792));
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  await page.goto("http://localhost:8792/", { waitUntil: "load" });
  await page.waitForFunction(() => (window as any).__ready === true, undefined, {
    timeout: 15_000,
  });
  const controlledOnFirstLoad = await page.evaluate(() => !!navigator.serviceWorker.controller);
  if (!controlledOnFirstLoad) {
    // A ServiceWorker usually does not control the page that registered it on first load.
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => (window as any).__ready === true, undefined, {
      timeout: 15_000,
    });
  }
  console.log(`[site-browser] controlled on first load: ${controlledOnFirstLoad}`);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await stop?.();
});

beforeEach(() => {
  // One page serves the whole suite, so these arrays accumulate across tests. Without this
  // reset a single failing test fails every test after it, which turns one real defect into a
  // wall of red that hides which request actually broke. Observed for real: reverting the
  // path-decoding fix failed test 1 on its own assertion and then failed tests 2 and 3 purely
  // on the leaked errors. Resetting here rather than in `afterEach` keeps the guard honest for
  // errors raised during `beforeAll`.
  consoleErrors.length = 0;
  pageErrors.length = 0;
});

afterEach(() => {
  // The weak-channel guard: a broken handler that fails silently on a test's own assertions
  // still has to get through this without leaving a trace on either error channel. It now
  // covers only THIS test's requests, which is what makes a failure locatable.
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

describe("the site handler under a real ServiceWorker", () => {
  it("serves a notebook page through the ServiceWorker", async () => {
    const baseUrl = await page.evaluate(() => (window as any).__baseUrl);
    const body = await page.evaluate(async (u) => (await fetch(`${u}chart.html`)).text(), baseUrl);
    expect(body).toContain("Chart");
  });

  // The browser is what percent-encodes these, so this is the only place the whole chain —
  // encode in the page, decode in the composition — is exercised end to end.
  it("serves pages whose names carry a space and a non-ASCII character", async () => {
    const baseUrl = await page.evaluate(() => (window as any).__baseUrl);
    const bodies = await page.evaluate(
      async (u) =>
        Promise.all([
          fetch(`${u}My Notebook.html`).then((r) => r.text()),
          fetch(`${u}Notes/Été.html`).then((r) => r.text()),
        ]),
      baseUrl,
    );
    expect(bodies[0]).toContain("Spaced");
    expect(bodies[1]).toContain("Accented");
  });

  it("serves the directory index through the ServiceWorker", async () => {
    const baseUrl = await page.evaluate(() => (window as any).__baseUrl);
    const body = await page.evaluate(async (u) => (await fetch(u)).text(), baseUrl);
    expect(body).toContain("Hosted");
  });

  it("delivers a rebuild notification to a page loaded from the site", async () => {
    const received = await page.evaluate(async () => {
      const w = window as any;
      const seen: unknown[] = [];
      const es = new EventSource(`${w.__baseUrl}_events/build`);
      await new Promise((r) => (es.onopen = r));
      w.__events.publish("build", { changed: ["/chart.html"] }, "rebuilt");
      await new Promise<void>((r) => {
        es.addEventListener("rebuilt", (e) => {
          seen.push(JSON.parse((e as MessageEvent).data));
          r();
        });
      });
      es.close();
      return seen;
    });
    expect(received).toEqual([{ changed: ["/chart.html"] }]);
  }, 30_000);
});
