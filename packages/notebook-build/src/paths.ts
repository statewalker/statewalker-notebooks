import { normalizePath } from "@statewalker/webrun-files";

/**
 * Resolves `relative` against the directory `base`, and returns the result ONLY when it
 * stays strictly inside `base`.
 *
 * `normalizePath` (webrun-files) drops `.` and empty segments but leaves `..` in place, and
 * a real backend then hands it to the OS: `NodeFilesApi.resolvePath` is
 * `rootDir + normalizePath(path)`, so `/nb/deep/../../../secret.txt` reads and writes three
 * levels above the root it was supposed to be confined to. `MemFilesApi` hides this because
 * it keys its store on the literal path string, so every escape test has to run against a
 * real filesystem.
 *
 * `..` is therefore resolved here, and containment is enforced DURING the walk rather than
 * on the final string: `a/../../b` never gets to look like `/base/b`. A `relative` that
 * resolves to `base` itself (`.`, `a/..`) is refused too — it names a directory, not a file.
 *
 * Returns `undefined` on escape; callers throw with the context they have (which notebook,
 * which attachment), because the message is the only thing that tells an author what to fix.
 */
export function resolveWithin(base: string, relative: string): string | undefined {
  const baseDir = normalizePath(base);
  const segments = baseDir === "/" ? [] : baseDir.slice(1).split("/");
  const depth = segments.length;
  for (const segment of relative.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length <= depth) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length <= depth) return undefined;
  return `/${segments.join("/")}`;
}
