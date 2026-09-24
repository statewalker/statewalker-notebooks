// Fixture page: builds a tiny notebook site into a MemFilesApi, composes it with the SAME
// `newNotebookSite` the Node unit tests in `src/site.test.ts` exercise, and hosts the resulting
// `SiteHandler` behind a real ServiceWorker via `HostedSiteBuilder`. This is the whole point of
// the browser test — proving the identical handler works unchanged in both hosts. Everything it
// does is recorded on `window` so the Node-side Playwright test can read it back.
import { newPubSub } from "@statewalker/notebook-events";
import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { HostedSiteBuilder } from "@statewalker/webrun-site-host";
import { newNotebookSite } from "../../src/site.js";

const output = new MemFilesApi();
await writeText(output, "/index.html", "<!doctype html><title>Hosted</title><h1>Hosted</h1>");
await writeText(output, "/chart.html", "<!doctype html><title>Chart</title><h1>Chart</h1>");

const events = newPubSub();
const handler = newNotebookSite({ output, events });

const site = await new HostedSiteBuilder().setSiteKey("nb").setHandler(handler).build();
(window as any).__baseUrl = site.baseUrl;
(window as any).__events = events;
(window as any).__ready = true;
