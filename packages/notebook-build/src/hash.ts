/** Hex SHA-256 over raw bytes. The one hash function this package uses, for every input. */
export async function contentHash(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hex SHA-256 over a UTF-8 string. */
export function textHash(text: string): Promise<string> {
  return contentHash(new TextEncoder().encode(text));
}
