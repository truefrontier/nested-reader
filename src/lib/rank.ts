/**
 * Relevance scoring for picking which pages go into a prompt.
 *
 * BM25, because a session is a small pile of short prose notes and nothing here justifies an
 * index or an embedding model: term frequency saturates, rarer words count for more, and the
 * whole thing is a few lines of arithmetic over text the store already has in hand.
 *
 * `search_pages` in `src-tauri/src/tools.rs` scores the same way for the same reason. The two
 * have to agree on what a word is, so both lowercase, split on anything that is not a letter or
 * a digit, drop the stop words below and keep what is left of two characters or more.
 */

/** Words too common to say anything about which page is wanted. */
const STOP = new Set([
  "a", "about", "after", "all", "also", "am", "an", "and", "any", "are", "as", "at", "be",
  "because", "been", "before", "being", "between", "both", "but", "by", "can", "did", "do", "does",
  "doing", "down", "during", "each", "few", "for", "from", "further", "had", "has", "have", "having",
  "he", "her", "here", "hers", "him", "his", "how", "i", "if", "in", "into", "is", "it", "its",
  "just", "me", "more", "most", "my", "no", "nor", "not", "now", "of", "off", "on", "once", "only",
  "or", "other", "our", "ours", "out", "over", "own", "same", "she", "should", "so", "some", "such",
  "than", "that", "the", "their", "theirs", "them", "then", "there", "these", "they", "this",
  "those", "through", "to", "too", "under", "until", "up", "very", "was", "we", "were", "what",
  "when", "where", "which", "while", "who", "whom", "why", "will", "with", "would", "you", "your",
  "yours",
]);

/** Saturation point for term frequency: past this, saying it again barely counts. */
const K1 = 1.2;
/**
 * How hard to penalise a long page. Lower than the usual 0.75 because these are notes, where
 * length usually means the page is thorough rather than padded, and a stub should not win on brevity.
 */
const B = 0.3;
/** A query word in the title says more than the same word in the body, in proportion to how rare it is. */
const TITLE_WEIGHT = 1.0;

/**
 * Folds a plural onto its singular, so asking about "ripple" finds the page about ripples.
 * Only plurals: -s and -ies are the endings that keep notes from matching, and stripping more
 * (-ing, -ed) starts changing words that meant different things. Mirrored in `tools.rs`.
 */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith("sses")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.endsWith("ss")) return w;
  if (w.length > 3 && w.endsWith("s")) return w.slice(0, -1);
  return w;
}

/** The words of a piece of text, as both this file and `tools.rs` count them. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2 && !STOP.has(w))
    .map(stem);
}

/** The distinct words of a query, in the order they were typed. */
export function queryTerms(query: string): string[] {
  return [...new Set(words(query))];
}

type Scored<T> = { item: T; score: number; at: number };

/**
 * Sorts `items` by how well they answer `terms`, best first, dropping anything that shares no
 * word with the query at all. An empty `terms` leaves the order alone: with nothing to rank on,
 * whatever order the caller had is better than an arbitrary reshuffle.
 */
export function rankByRelevance<T>(
  terms: string[],
  items: T[],
  textOf: (item: T) => string,
  titleOf: (item: T) => string,
): T[] {
  if (!terms.length || items.length < 2) return items;

  const docs = items.map((item) => words(textOf(item)));
  const titles = items.map((item) => new Set(words(titleOf(item))));
  const total = docs.length;
  const avgLen = docs.reduce((n, d) => n + d.length, 0) / total || 1;

  // How many pages each query word appears on at all, which is what makes a word rare or common.
  const seenOn = new Map<string, number>();
  const counts = docs.map((d) => {
    const tf = new Map<string, number>();
    for (const w of d) tf.set(w, (tf.get(w) ?? 0) + 1);
    for (const t of terms) if (tf.has(t)) seenOn.set(t, (seenOn.get(t) ?? 0) + 1);
    return tf;
  });
  // A title-only match still counts as the word appearing on that page.
  for (const t of terms) {
    for (let i = 0; i < total; i++) {
      if (!counts[i].has(t) && titles[i].has(t)) seenOn.set(t, (seenOn.get(t) ?? 0) + 1);
    }
  }

  const scored: Scored<T>[] = items.map((item, at) => {
    let score = 0;
    for (const t of terms) {
      const n = seenOn.get(t) ?? 0;
      if (!n) continue;
      // Lucene's non-negative idf: a word on every page is worth little, never less than nothing.
      const idf = Math.log(1 + (total - n + 0.5) / (n + 0.5));
      const tf = counts[at].get(t) ?? 0;
      if (tf) {
        const norm = 1 - B + (B * docs[at].length) / avgLen;
        score += (idf * (tf * (K1 + 1))) / (tf + K1 * norm);
      }
      if (titles[at].has(t)) score += TITLE_WEIGHT * idf;
    }
    return { item, score, at };
  });

  return scored
    .filter((s) => s.score > 0)
    // Ties keep the order the caller had, so ranking never shuffles equally good pages about.
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .map((s) => s.item);
}
