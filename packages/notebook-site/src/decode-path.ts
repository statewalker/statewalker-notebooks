import type {
  FileInfo,
  FileStats,
  FilesApi,
  ListOptions,
  ReadOptions,
} from "@statewalker/webrun-files";

/**
 * Percent-decode a URL pathname into the path a `FilesApi` stores.
 *
 * A `SiteHandler` is handed a `Request`, and a URL pathname is percent-encoded by definition:
 * `new URL("http://h/My Notebook.html").pathname` is already `/My%20Notebook.html`. Neither
 * `SiteBuilder` nor `newServeFiles` decodes — they pass `url.pathname` straight to
 * `filesApi.stats` — so without this step every page or attachment whose name carries a space
 * or a non-ASCII character 404s, while the identical build served as a static export by an
 * ordinary HTTP server works. Decoding here is what keeps the two modes agreeing.
 *
 * Decoding is per SEGMENT, never over the whole path, and that is the security-relevant part.
 * `%2f` is not a path separator to the URL parser, so a whole-path `decodeURIComponent` would
 * turn `/..%2f..%2fetc/passwd` into `/../../etc/passwd` and re-create at the files boundary
 * exactly the traversal the URL layer had already refused. A segment that decodes to something
 * containing a separator, or to a dot-segment, is therefore not decoded into one — the whole
 * path is rejected.
 *
 * Returns `null` when the path must not be looked up at all.
 */
export function decodeSitePath(pathname: string): string | null {
  const out: string[] = [];
  for (const segment of pathname.split("/")) {
    if (segment === "") {
      out.push(segment);
      continue;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // Not a valid escape sequence (`/broken%zz.html`). A filename may legitimately contain a
      // `%`, and a hand-written link does not have to encode it, so the raw segment is used
      // rather than failing the request outright. It still goes through the checks below.
      decoded = segment;
    }
    if (decoded === "." || decoded === "..") return null;
    if (decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) return null;
    out.push(decoded);
  }
  return out.join("/");
}

/**
 * Wrap a `FilesApi` so every path it receives is decoded by {@link decodeSitePath} first.
 *
 * The decode belongs at this boundary rather than in the handler because a URL cannot carry
 * the decoded form: `new URL(...)` re-encodes any pathname it is given, so there is no request
 * object that could express `/My Notebook.html`. The files layer is the first place the path
 * stops being a URL and becomes a name.
 *
 * Arguably `@statewalker/webrun-site-builder` should do this for every consumer; it is
 * released separately, so the composition carries it for now.
 *
 * A rejected path behaves exactly like a path that is not there — `stats` reports nothing, so
 * `newServeFiles` answers 404 — because that is what it is from the site's point of view.
 * Mutating methods throw instead: nothing in this package writes through the served mount, and
 * a silent no-op write would be a far worse failure than a loud one.
 */
export function withDecodedPaths(files: FilesApi): FilesApi {
  const decode = (path: string): string => {
    const decoded = decodeSitePath(path);
    if (decoded === null) throw new RejectedPathError(path);
    return decoded;
  };
  return {
    async stats(path: string): Promise<FileStats | undefined> {
      const decoded = decodeSitePath(path);
      return decoded === null ? undefined : files.stats(decoded);
    },
    async exists(path: string): Promise<boolean> {
      const decoded = decodeSitePath(path);
      return decoded === null ? false : files.exists(decoded);
    },
    read(path: string, options?: ReadOptions): AsyncIterable<Uint8Array> {
      const decoded = decodeSitePath(path);
      // `read` is not async, so it cannot report "nothing there" by returning undefined; the
      // documented answer for a path that is not there is an empty iterable.
      if (decoded === null) return emptyChunks();
      return files.read(decoded, options);
    },
    list(path: string, options?: ListOptions): AsyncIterable<FileInfo> {
      const decoded = decodeSitePath(path);
      if (decoded === null) return emptyEntries();
      return files.list(decoded, options);
    },
    write: (path, content) => files.write(decode(path), content),
    mkdir: (path) => files.mkdir(decode(path)),
    remove: (path) => files.remove(decode(path)),
    move: (source, target) => files.move(decode(source), decode(target)),
    copy: (source, target) => files.copy(decode(source), decode(target)),
  };
}

class RejectedPathError extends Error {
  constructor(path: string) {
    super(`refusing a path that does not decode to a safe name: ${path}`);
    this.name = "RejectedPathError";
  }
}

async function* emptyChunks(): AsyncIterable<Uint8Array> {}
async function* emptyEntries(): AsyncIterable<FileInfo> {}
