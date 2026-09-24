import type { Db, DbEntry } from "@statewalker/db-api";

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

export function newDbClient(db: Db): NotebookDbClient {
  return {
    sql(strings, ...params) {
      // Interpolations become bound parameters. Never concatenated: a cell
      // querying user-supplied data would otherwise be an injection.
      const text = strings.join("?");
      return db.query(text, params);
    },
    query(sql, params) {
      return db.query(sql, params);
    },
    close() {
      return db.close();
    },
  };
}
