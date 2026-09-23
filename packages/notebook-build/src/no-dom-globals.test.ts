import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const GLOBAL_DOM_NAMES = ["document", "window", "localStorage", "navigator", "globalThis"];

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
 *
 * `globalThis` is itself in the flagged list, not just `document`/`window`/etc: without it,
 * `globalThis.document` passes as if it were `dom.document`, because the character before
 * `document` is still `.`. That is the exact evasion a code review found against the first
 * version of this guard — and it typechecks, since `lib` now includes `DOM`. Flagging
 * `globalThis` catches that specific, unremarkable shape (a careless `globalThis.foo` creeping
 * back in) cheaply. It does NOT catch a deliberately obfuscated alias chain — e.g.
 * `const g: any = globalThis; g.document.title` — that is a much higher bar (this is a
 * regex-based lint, not a data-flow analysis) and is out of scope: the guard's job is to stop
 * an accidental regression, not a hostile one.
 */

/**
 * Blanks comments and the *literal text* of string/template literals, in a single pass, so
 * prose that merely mentions one of these words (e.g. "the whole document") doesn't trip the
 * scan below, and neither does browser vocabulary a module deliberately builds as a *string* to
 * hand to a browser later (e.g. a page-rendering stage emitting `` `document.getElementById(...)`
 * `` as text it never executes itself). A `${...}` interpolation inside a template literal is
 * left in place and still scanned, because that part really is code that runs here, in Node, at
 * string-build time — `` `${document.title}` `` must still be caught.
 *
 * This has to be one combined scanner, not comment-stripping followed by a separate
 * literal-stripping pass: a naive two-pass composition breaks on a string containing `//`, e.g.
 * `specifier.includes("://")` (this package has exactly this, in resolve.ts). The line-comment
 * half of a naive `stripComments` doesn't know it's inside a string, so it treats the `//` in
 * `"://"` as a real comment start and truncates the line — including the string's closing quote.
 * That leaves a dangling, unmatched `"` in the "comment-stripped" text; a literal-stripping pass
 * run afterwards treats everything from that dangling quote onward as string content, up to the
 * next unrelated `"` in the file — silently blanking real code in between, including any
 * `document`/`window`/etc it contains. Scanning comments and literals together avoids this: a
 * `//` is only ever treated as a comment when the scanner isn't already inside a string.
 *
 * Still a lint-style guard, not a full parser: it does not understand regex literals containing
 * quote-like characters, which no source in this package currently has.
 */
function stripNonCode(source: string): string {
  const out: string[] = [];
  let i = 0;
  const n = source.length;

  const blank = (ch: string) => out.push(ch === "\n" ? "\n" : " ");

  function consumeLineComment(): void {
    while (i < n && source[i] !== "\n") {
      blank(source[i] as string);
      i++;
    }
  }

  function consumeBlockComment(): void {
    blank(" ");
    blank(" ");
    i += 2; // "/*"
    while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
      blank(source[i] as string);
      i++;
    }
    if (i < n) {
      blank(" ");
      blank(" ");
      i += 2; // "*/"
    }
  }

  function consumeQuoted(quote: string): void {
    blank(" ");
    i++; // opening quote
    while (i < n && source[i] !== quote) {
      if (source[i] === "\\" && i + 1 < n) {
        blank(" ");
        blank(source[i + 1] as string);
        i += 2;
      } else {
        blank(source[i] as string);
        i++;
      }
    }
    if (i < n) {
      blank(" ");
      i++; // closing quote
    }
  }

  // Inside a template literal's `${...}` interpolation: this is live code (it runs in Node
  // while the page string is being built), so it is emitted as-is, not blanked — but it can
  // itself contain nested comments, strings, or templates, which still need the same treatment.
  function consumeInterpolation(): void {
    let depth = 1;
    while (i < n && depth > 0) {
      const c = source[i] as string;
      if (c === "/" && source[i + 1] === "/") consumeLineComment();
      else if (c === "/" && source[i + 1] === "*") consumeBlockComment();
      else if (c === "`") consumeTemplate();
      else if (c === '"' || c === "'") consumeQuoted(c);
      else if (c === "{") {
        depth++;
        out.push(c);
        i++;
      } else if (c === "}") {
        depth--;
        if (depth === 0) blank(" ");
        else out.push(c);
        i++;
      } else {
        out.push(c);
        i++;
      }
    }
  }

  function consumeTemplate(): void {
    blank(" ");
    i++; // opening backtick
    while (i < n && source[i] !== "`") {
      if (source[i] === "\\" && i + 1 < n) {
        blank(" ");
        blank(source[i + 1] as string);
        i += 2;
      } else if (source[i] === "$" && source[i + 1] === "{") {
        blank(" ");
        blank(" ");
        i += 2; // "${"
        consumeInterpolation();
      } else {
        blank(source[i] as string);
        i++;
      }
    }
    if (i < n) {
      blank(" ");
      i++; // closing backtick
    }
  }

  while (i < n) {
    const c = source[i] as string;
    if (c === "/" && source[i + 1] === "/") consumeLineComment();
    else if (c === "/" && source[i + 1] === "*") consumeBlockComment();
    else if (c === '"' || c === "'") consumeQuoted(c);
    else if (c === "`") consumeTemplate();
    else {
      out.push(c);
      i++;
    }
  }
  return out.join("");
}

function findGlobalDomReferences(source: string): string[] {
  const hits: string[] = [];
  const code = stripNonCode(source);
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
