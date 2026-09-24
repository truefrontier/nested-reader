/**
 * Masks `data:` URIs (inline `(data:...)`, reference-style `<data:...>`, or quoted `"data:..."`)
 * before a page goes to the model, and restores them afterward. A refine is asked to echo a page
 * back with small changes; a `data:` payload is opaque to the model, so asking it to reproduce one
 * verbatim just gets a hallucinated replacement. The mask keeps the model from ever seeing the
 * payload while keeping the surrounding text — including any other long run, a table or an inline
 * SVG — exactly as written, since those can be meaningful content a rewrite should still see.
 */

const DATA_URI_RE = /data:[^\s)"'>\]]+/g;

const OPEN = "";
const CLOSE = "";
/** Matches only well-formed sentinels; a torn one (missing its close) is caught separately. */
const SENTINEL_RE = /[0-9a-f]{8}:\d+/g;

export type DataUriMask = { nonce: string; map: Map<string, string> };

/** A fresh mask for one prompt: its own nonce, so a stray sentinel from elsewhere can never look valid. */
export function createDataUriMask(): DataUriMask {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return { nonce, map: new Map() };
}

/** Replaces every `data:` URI in `text` with a sentinel, recording the payload it stands for. */
export function maskDataUris(mask: DataUriMask, text: string): string {
  return text.replace(DATA_URI_RE, (uri) => {
    const token = `${OPEN}${mask.nonce}:${mask.map.size}${CLOSE}`;
    mask.map.set(token, uri);
    return token;
  });
}

export type UnmaskResult = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Restores the sentinels in `text` to the payloads they stand for. Fails closed: a sentinel this
 * mask never made, or one seen twice, means the rewrite cannot be trusted, so nothing is restored
 * and the caller is told why rather than risking a corrupted image landing on the page. A sentinel
 * that simply never comes back is fine — the instruction may have dropped that part on purpose.
 */
export function unmaskDataUris(mask: DataUriMask, text: string): UnmaskResult {
  const found = text.match(SENTINEL_RE) ?? [];
  const seen = new Set<string>();
  for (const token of found) {
    if (!mask.map.has(token)) return { ok: false, reason: "came back with an image reference this rewrite never had" };
    if (seen.has(token)) return { ok: false, reason: "repeated an image reference" };
    seen.add(token);
  }
  let out = text;
  for (const token of seen) out = out.split(token).join(mask.map.get(token)!);
  if (out.includes(OPEN) || out.includes(CLOSE)) return { ok: false, reason: "came back with a broken image reference" };
  return { ok: true, text: out };
}
