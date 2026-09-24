import type { Db } from "@statewalker/db-api";
import { type NotebookDbClient, newDbClient } from "./client.js";

export interface LiveDatabasesOptions {
  open(name: string): Promise<Db>;
  onError?(name: string, error: unknown): void;
}

/**
 * Lazily opens `Db`s by name for a live SQL cell running against DuckDB-WASM in the page.
 *
 * `get` caches the in-flight `open()` promise per name, so two callers racing the first use
 * of a database share one `open` rather than opening it twice. A rejected open is NOT cached:
 * OPFS can be unavailable and the wasm bundle can be blocked, and both are transient enough
 * (a private window, a flaky CDN) that the next `get` must retry rather than replaying the
 * same failure forever. The rejection is also rewrapped with the database name, because "OPFS
 * unavailable" alone does not tell an author which cell to fix.
 */
export function newLiveDatabases(options: LiveDatabasesOptions): {
  get(name: string): Promise<NotebookDbClient>;
  closeAll(): Promise<void>;
} {
  const { open, onError } = options;
  const clients = new Map<string, Promise<NotebookDbClient>>();

  return {
    get(name: string): Promise<NotebookDbClient> {
      let pending = clients.get(name);
      if (!pending) {
        pending = open(name)
          .then((db) => newDbClient(db))
          .catch((error: unknown) => {
            // Delete on rejection BEFORE rethrowing: the map must not hold a rejected
            // promise, or every future `get(name)` replays this same failure forever.
            clients.delete(name);
            onError?.(name, error);
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`cannot open database "${name}": ${reason}`, { cause: error });
          });
        clients.set(name, pending);
      }
      return pending;
    },

    async closeAll(): Promise<void> {
      const opened = [...clients.values()];
      clients.clear();
      await Promise.all(opened.map((p) => p.then((client) => client.close())));
    },
  };
}
