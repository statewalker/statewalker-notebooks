import type { Db, DbEntry } from "@statewalker/db-api";
import { normalizeRows } from "./rows.js";

export interface NotebookDbClient {
  /**
   * Tagged-template query. This is the shape notebook-kit's `of(source, name)`
   * duck-types on, which is what makes this object usable as a SQL cell's
   * database without notebook-kit knowing anything about db-api.
   */
  sql(strings: TemplateStringsArray, ...params: unknown[]): Promise<DbEntry[]>;
  query<T = DbEntry>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

/**
 * Wraps a db-api `Db` as a notebook-kit database source.
 *
 * Both query paths run their rows through `normalizeRows`, which turns a BIGINT column's
 * `bigint` into a `number` (see `rows.ts` for why number, and why an out-of-range value is an
 * error rather than a rounding). Doing it HERE, rather than only in the precompute
 * serialization, is what keeps the live page and the precomputed cache file showing the same
 * value for the same query.
 */
export function newDbClient(db: Db): NotebookDbClient {
  return {
    async sql(strings, ...params) {
      // Interpolations become bound parameters. Never concatenated: a cell
      // querying user-supplied data would otherwise be an injection.
      const text = strings.join("?");
      return normalizeRows(await db.query(text, params));
    },
    async query(sql, params) {
      return normalizeRows(await db.query(sql, params));
    },
    close() {
      return db.close();
    },
  };
}
