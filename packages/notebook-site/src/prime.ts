export interface ModuleRef {
  pkg: string;
  version?: string;
  subpath?: string;
}

export interface PrimeResult {
  primed: string[];
  failed: Array<{ ref: ModuleRef; error: string }>;
}

/**
 * Warm the module cache before the site starts serving.
 *
 * Lazy emission of `~deps` proxy files races concurrent browser fetches: a
 * cold first load failed roughly one time in four with a link error naming a
 * proxy that had not finished being written. Priming removes the race rather
 * than relying on it being benign. Serial by default for the same reason —
 * concurrent priming re-creates the contention it exists to avoid.
 */
export async function primeModules(
  server: { prime(ref: ModuleRef): Promise<{ url: string }> },
  refs: readonly ModuleRef[],
): Promise<PrimeResult> {
  const result: PrimeResult = { primed: [], failed: [] };
  for (const ref of refs) {
    try {
      const { url } = await server.prime(ref);
      result.primed.push(url);
    } catch (e) {
      // One unresolvable package must not leave the rest of the site cold.
      result.failed.push({ ref, error: String((e as Error)?.message ?? e) });
    }
  }
  return result;
}
