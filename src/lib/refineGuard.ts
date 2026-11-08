/**
 * Stale-result guard for refines. A refine reads a page, spends seconds in the model, then writes
 * its answer back; if the page changed in between (an edit, another refine, a change on disk) the
 * answer was written for text that no longer exists. The guard hashes the page as it was sent,
 * hashes it again right before the write, and re-runs the refine on the current text if they differ.
 */

/** How many times a refine is re-run on a page that changed under it before it gives up. */
export const MAX_REFINE_RETRIES = 3;

/** SHA-256 (hex) of the page text. Line endings are folded to LF so CRLF and LF copies of one page match. */
export async function hashPage(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text.replace(/\r\n/g, "\n"));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export type GuardedRefine<T> = {
  /** The page as it is now, for the first attempt and for each re-run. */
  read: () => Promise<string>;
  /** The page as it is at apply time, given the text the attempt was run on. */
  latest: (sent: string) => Promise<string>;
  /** One run of the refine against `body`; resolves with whatever `apply` needs. */
  generate: (body: string) => Promise<T>;
  /** Writes the result. Called only when the page still hashes the same as the text that was sent. */
  apply: (body: string, result: T) => Promise<void>;
  /** The page changed under an attempt; `current` is what it became. */
  onStale?: (current: string) => void;
  /** True once the refine is cancelled: no further attempt starts and nothing is written. */
  stopped?: () => boolean;
  maxRetries?: number;
};

/**
 * Runs `generate` and `apply` with the stale check between them. A changed page discards the result
 * and starts over on the current text, up to `maxRetries` times; past that it throws and writes nothing.
 */
export async function guardedRefine<T>(o: GuardedRefine<T>): Promise<void> {
  const max = o.maxRetries ?? MAX_REFINE_RETRIES;
  let body = await o.read();
  for (let retries = 0; ; retries++) {
    if (o.stopped?.()) return;
    const sent = await hashPage(body);
    const result = await o.generate(body);
    const current = await o.latest(body);
    if (o.stopped?.()) return;
    if ((await hashPage(current)) === sent) return o.apply(body, result);
    o.onStale?.(current);
    if (retries >= max) {
      throw new Error(`The page kept changing while it was being refined, so the result was discarded after ${max + 1} tries. The page is unchanged — try again once it settles.`);
    }
    body = await o.read();
  }
}
