export interface ModuleRef {
  pkg: string;
  version?: string;
  subpath?: string;
}

/** One ref that primed, paired with the url the module server resolved it to. */
export interface PrimedModule {
  ref: ModuleRef;
  url: string;
}

export interface PrimeResult {
  /**
   * Refs that primed, in input order, each with its resolved url. Paired rather than a bare
   * `string[]`: a caller priming a manifest needs to know WHICH ref produced a url, and a
   * result that reports failures by ref and successes by url cannot be lined up against its
   * own input.
   */
  primed: PrimedModule[];
  failed: Array<{ ref: ModuleRef; error: string }>;
}

/**
 * Warm the module cache before the site starts serving.
 *
 * Lazy emission of `~deps` proxy files races concurrent browser fetches: a
 * cold first load failed roughly one time in four with a link error naming a
 * proxy that had not finished being written. Priming removes the race rather
 * than relying on it being benign.
 *
 * Priming is serial, and there is no option to make it concurrent — concurrency here
 * re-creates the contention this function exists to avoid. (The doc comment used to say
 * "serial by default", which advertised a knob that has never existed.)
 *
 * Refs are deduplicated: a manifest lists a package once per notebook that imports it, so the
 * same ref arriving several times is the normal case, and priming it twice is a wasted round
 * trip against the cache being warmed.
 */
export async function primeModules(
  server: { prime(ref: ModuleRef): Promise<{ url: string }> },
  refs: readonly ModuleRef[],
): Promise<PrimeResult> {
  const result: PrimeResult = { primed: [], failed: [] };
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = `${ref.pkg}\u0000${ref.version ?? ""}\u0000${ref.subpath ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const { url } = await server.prime(ref);
      result.primed.push({ ref, url });
    } catch (e) {
      // One unresolvable package must not leave the rest of the site cold.
      result.failed.push({ ref, error: String((e as Error)?.message ?? e) });
    }
  }
  return result;
}
