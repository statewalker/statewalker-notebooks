import { describe, expect, it, vi } from "vitest";
import type { ModuleRef } from "./prime.js";
import { primeModules } from "./prime.js";

describe("primeModules", () => {
  it("primes every ref before returning", async () => {
    const prime = vi.fn(async () => ({ url: "/_m/x", target: "browser" as const }));
    const result = await primeModules({ prime } as never, [{ pkg: "d3" }, { pkg: "katex" }]);
    expect(prime).toHaveBeenCalledTimes(2);
    expect(result.primed).toHaveLength(2);
    expect(result.failed).toEqual([]);
  });

  // (1) priming is the mitigation, so a failure to prime must be visible
  it("reports a ref that could not be primed without aborting the rest", async () => {
    const prime = vi.fn(async (ref: { pkg: string }) => {
      if (ref.pkg === "missing") throw new Error("404 from registry");
      return { url: `/_m/${ref.pkg}`, target: "browser" as const };
    });
    const result = await primeModules({ prime } as never, [
      { pkg: "d3" },
      { pkg: "missing" },
      { pkg: "katex" },
    ]);
    expect(result.primed).toHaveLength(2);
    expect(result.failed).toEqual([{ ref: { pkg: "missing" }, error: "404 from registry" }]);
  });

  // A manifest lists a package once per notebook that imports it, so the same ref arriving
  // several times is the normal case, not a pathological one. Priming it twice is a wasted
  // round trip against the very cache this function exists to warm.
  it("primes a repeated ref only once", async () => {
    const prime = vi.fn(async (ref: ModuleRef) => ({ url: `/_m/${ref.pkg}` }));
    const result = await primeModules({ prime } as never, [
      { pkg: "d3", version: "7" },
      { pkg: "d3", version: "7" },
      { pkg: "d3", version: "6" },
      { pkg: "d3", version: "7", subpath: "array" },
    ]);
    expect(prime).toHaveBeenCalledTimes(3);
    expect(result.primed).toHaveLength(3);
  });

  // `primed: string[]` threw away which ref produced which url, so a caller that primes a
  // manifest cannot tell what it got — and a failure is reported against a ref while a success
  // is reported against a url, which are not comparable.
  it("reports which ref produced which url", async () => {
    const prime = vi.fn(async (ref: ModuleRef) => ({ url: `/_m/${ref.pkg}@${ref.version}` }));
    const result = await primeModules({ prime } as never, [
      { pkg: "d3", version: "7" },
      { pkg: "katex", version: "0.16" },
    ]);
    expect(result.primed).toEqual([
      { ref: { pkg: "d3", version: "7" }, url: "/_m/d3@7" },
      { ref: { pkg: "katex", version: "0.16" }, url: "/_m/katex@0.16" },
    ]);
  });

  it("returns immediately for an empty ref list", async () => {
    const prime = vi.fn();
    const result = await primeModules({ prime } as never, []);
    expect(prime).not.toHaveBeenCalled();
    expect(result).toEqual({ primed: [], failed: [] });
  });

  // Serial, full stop — there is no option that makes it concurrent, and the doc comment no
  // longer implies one.
  it("primes serially so a cold cache is not hammered concurrently", async () => {
    const order: string[] = [];
    const prime = async (ref: { pkg: string }) => {
      order.push(`start:${ref.pkg}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end:${ref.pkg}`);
      return { url: "/_m/x", target: "browser" as const };
    };
    await primeModules({ prime } as never, [{ pkg: "a" }, { pkg: "b" }]);
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });
});
