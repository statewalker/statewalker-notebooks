import { type Notebook, transpile } from "@observablehq/notebook-kit";

export type PinMap = ReadonlyMap<string, string>;

export type ModuleRef = { pkg: string; version?: string; subpath?: string };

/** Narrow structural type: we need only `resolve`, which keeps this testable. */
export interface ModuleResolver {
  resolve(ref: ModuleRef): Promise<{ url: string; target: string }>;
}
export interface ResolveDeps {
  moduleServer: ModuleResolver;
}

export class ResolveError extends Error {
  constructor(
    readonly notebookPath: string,
    readonly specifier: string,
    readonly cause: unknown,
  ) {
    super(
      `${notebookPath}: cannot resolve import "${specifier}": ${String((cause as Error)?.message ?? cause)}`,
    );
    this.name = "ResolveError";
  }
}

const CODE_MODES = new Set(["js", "ts", "ojs"]);

/**
 * Every import specifier in the notebook, deduplicated, in first-seen order.
 * Collected by transpiling with a recording resolver — notebook-kit already
 * knows how to find every static, namespace and dynamic import, so we reuse
 * its walker instead of writing a second one that can drift from it.
 */
export function collectSpecifiers(nb: Notebook): string[] {
  const seen = new Set<string>();
  for (const cell of nb.cells) {
    if (!CODE_MODES.has(cell.mode)) continue;
    try {
      transpile(cell.value, cell.mode, {
        resolveImport: (s: string) => {
          seen.add(s);
          return s;
        },
      });
    } catch {
      // A cell that does not parse has no resolvable imports. A later stage
      // is where the syntax error becomes a visible error on the page.
    }
  }
  return [...seen];
}

/** `npm:@scope/pkg@1.2.3/sub` -> {pkg, version, subpath}. */
export function toModuleRef(specifier: string): ModuleRef {
  const bare = specifier.startsWith("npm:") ? specifier.slice(4) : specifier;
  const m = /^((?:@[^/]+\/)?[^/@]+)(?:@([^/]+))?(?:\/(.*))?$/.exec(bare);
  if (!m) throw new Error(`unparseable specifier: ${specifier}`);
  return {
    pkg: m[1] as string,
    ...(m[2] === undefined ? {} : { version: m[2] }),
    ...(m[3] === undefined ? {} : { subpath: m[3] }),
  };
}

export async function resolveNotebook(
  nb: Notebook,
  { moduleServer }: ResolveDeps,
  notebookPath: string,
): Promise<PinMap> {
  const pins = new Map<string, string>();
  for (const specifier of collectSpecifiers(nb)) {
    try {
      const { url } = await moduleServer.resolve(toModuleRef(specifier));
      pins.set(specifier, url);
    } catch (cause) {
      throw new ResolveError(notebookPath, specifier, cause);
    }
  }
  return pins;
}
