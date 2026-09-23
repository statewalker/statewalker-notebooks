import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const GLOBAL_DOM_NAMES = ["document", "window", "localStorage", "navigator"];

/**
 * Recursively collect every `.ts` file under `dir`, skipping tests: this guard is about what
 * the *implementation* reads, not what the test doubles set up.
 */
function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

/**
 * A bare use of one of `GLOBAL_DOM_NAMES` — not a `.property` access on some other object (e.g.
 * `dom.document`), and not a `name:` property/type-member declaration (e.g. `document: Document`
 * in the `DomEnv` interface) — is a read of the browser's global instead of the injected
 * `DomEnv`. That silently works under vitest's default (browser-like) environment and dies
 * under a real Node build, or vice versa; no unit test in this suite would notice on its own,
 * because vitest runs in only one environment at a time. See the `DomEnv` doc comment in
 * `serialize.ts`.
 */

// Strip block and line comments first, so prose that merely mentions one of these words (e.g.
// "the whole document") doesn't trip the scan below. Good enough for a lint-style guard, not a
// full parser: it doesn't account for these sequences appearing inside string/template
// literals, which none of this package's sources currently do.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function findGlobalDomReferences(source: string): string[] {
  const hits: string[] = [];
  const code = stripComments(source);
  const pattern = new RegExp(`\\b(${GLOBAL_DOM_NAMES.join("|")})\\b`, "g");
  let match: RegExpExecArray | null = pattern.exec(code);
  while (match !== null) {
    const before = code.slice(0, match.index);
    const after = code.slice(match.index + match[0].length).trimStart();
    const precededByDot = before.trimEnd().endsWith(".");
    const isDeclaredProperty = after.startsWith(":");
    if (!precededByDot && !isDeclaredProperty) hits.push(match[0]);
    match = pattern.exec(code);
  }
  return hits;
}

describe("no DOM globals", () => {
  it("never reads document/window/localStorage/navigator as a global", () => {
    for (const file of sourceFiles(SRC_DIR)) {
      const hits = findGlobalDomReferences(readFileSync(file, "utf8"));
      expect(hits, `${file} reads a DOM global directly: ${hits.join(", ")}`).toEqual([]);
    }
  });
});
