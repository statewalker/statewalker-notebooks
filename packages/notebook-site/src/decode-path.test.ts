import { describe, expect, it } from "vitest";
import { decodeSitePath } from "./decode-path.js";

// `site.test.ts` drives this through the composed handler, which is the test that matters. But
// a `Request` cannot express every input this function must survive: the URL parser resolves
// `%2e%2e` away before a handler ever sees it, so the dot-segment rejection below is
// unreachable from there and would otherwise be an unguarded line. These are that guard.
describe("decodeSitePath", () => {
  it("decodes a space and a non-ASCII character", () => {
    expect(decodeSitePath("/My%20Notebook.html")).toBe("/My Notebook.html");
    expect(decodeSitePath("/Notes/%C3%89t%C3%A9.html")).toBe("/Notes/Été.html");
  });

  it("decodes %25 back to a literal percent sign", () => {
    expect(decodeSitePath("/100%25%20done.csv")).toBe("/100% done.csv");
  });

  it("leaves an undecodable escape alone instead of throwing", () => {
    expect(decodeSitePath("/broken%zz.html")).toBe("/broken%zz.html");
  });

  it("leaves an already-plain path untouched, separators included", () => {
    expect(decodeSitePath("/")).toBe("/");
    expect(decodeSitePath("/a/b/c.html")).toBe("/a/b/c.html");
    expect(decodeSitePath("/dir/")).toBe("/dir/");
  });

  it("rejects a segment that decodes to a dot-segment", () => {
    expect(decodeSitePath("/a/%2e%2e/b")).toBeNull();
    expect(decodeSitePath("/a/../b")).toBeNull();
    expect(decodeSitePath("/a/%2E%2E/b")).toBeNull();
    expect(decodeSitePath("/a/%2e/b")).toBeNull();
  });

  // The whole reason decoding is per-segment: `%2f` is not a separator to the URL parser, so
  // decoding it into one would invent a path the request never asked for.
  it("rejects a segment that decodes to something containing a separator", () => {
    expect(decodeSitePath("/..%2f..%2fetc/passwd")).toBeNull();
    expect(decodeSitePath("/a%2Fb.html")).toBeNull();
    expect(decodeSitePath("/a%5Cb.html")).toBeNull();
  });

  it("rejects a segment carrying a NUL", () => {
    expect(decodeSitePath("/evil%00.html")).toBeNull();
  });
});
