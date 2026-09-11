import { diffArrays, diffWordsWithSpace } from "diff";
import { lexBlocks, type Block } from "./markdown";

/**
 * One changed span between two versions of a page.
 * `block` indexes into the NEW page's blocks for review, and into the OLD
 * page's blocks when comparing against an older version.
 */
export type Change = {
  id: string;
  /** Block index in `newBlocks` (or -1 when the whole block was removed). */
  block: number;
  /** Block index in `oldBlocks` (or -1 when the block is new). */
  oldBlock: number;
  /** Offsets in the new block's plain text. */
  start: number;
  end: number;
  /** Offsets in the old block's plain text. */
  oldStart: number;
  oldEnd: number;
  before: string;
  after: string;
};

export type PageDiff = {
  oldBlocks: Block[];
  newBlocks: Block[];
  changes: Change[];
};

type Pair = { o: number; n: number };

/** Align blocks of two bodies by their text; unequal runs pair up by position. */
function alignBlocks(oldBlocks: Block[], newBlocks: Block[]): Pair[] {
  const oi = oldBlocks.map((_, i) => i).filter((i) => oldBlocks[i].type !== "space");
  const ni = newBlocks.map((_, i) => i).filter((i) => newBlocks[i].type !== "space");
  const parts = diffArrays(
    oi.map((i) => oldBlocks[i].text),
    ni.map((i) => newBlocks[i].text),
  );
  const pairs: Pair[] = [];
  let o = 0;
  let n = 0;
  let pendingOld: number[] = [];
  let pendingNew: number[] = [];
  const flush = () => {
    const len = Math.max(pendingOld.length, pendingNew.length);
    for (let k = 0; k < len; k++) {
      pairs.push({ o: pendingOld[k] ?? -1, n: pendingNew[k] ?? -1 });
    }
    pendingOld = [];
    pendingNew = [];
  };
  for (const part of parts) {
    const count = part.value.length;
    if (part.removed) {
      for (let k = 0; k < count; k++) pendingOld.push(oi[o++]);
    } else if (part.added) {
      for (let k = 0; k < count; k++) pendingNew.push(ni[n++]);
    } else {
      flush();
      for (let k = 0; k < count; k++) {
        o++;
        n++;
      }
    }
  }
  flush();
  return pairs;
}

const GAP_RE = /^[\s.,;:'"()\-–—]*$/;

function spansOf(pair: Pair, oldText: string, newText: string, idPrefix: string): Change[] {
  const parts = diffWordsWithSpace(oldText, newText);
  const out: Change[] = [];
  let oPos = 0;
  let nPos = 0;
  let cur: Change | null = null;
  let gapSince: { o: number; n: number } | null = null;
  const close = () => {
    if (cur) out.push(cur);
    cur = null;
    gapSince = null;
  };
  for (const part of parts) {
    const v = part.value;
    if (part.removed || part.added) {
      if (cur && gapSince) {
        // Reopen: absorb the small unchanged gap into the change.
        const gapOld = oldText.slice(gapSince.o, oPos);
        const gapNew = newText.slice(gapSince.n, nPos);
        cur.before += gapOld;
        cur.after += gapNew;
        gapSince = null;
      }
      if (!cur) {
        cur = {
          id: `${idPrefix}-${out.length}`,
          block: pair.n,
          oldBlock: pair.o,
          start: nPos,
          end: nPos,
          oldStart: oPos,
          oldEnd: oPos,
          before: "",
          after: "",
        };
      }
      if (part.removed) {
        cur.before += v;
        oPos += v.length;
        cur.oldEnd = oPos;
      } else {
        cur.after += v;
        nPos += v.length;
        cur.end = nPos;
      }
    } else {
      if (cur) {
        if (GAP_RE.test(v) && v.length <= 3) {
          gapSince = { o: oPos, n: nPos };
        } else {
          close();
        }
      }
      oPos += v.length;
      nPos += v.length;
      if (cur && gapSince) {
        // Provisionally extend the ends in case the change continues.
        cur.end = nPos;
        cur.oldEnd = oPos;
      }
    }
  }
  if (cur && gapSince) {
    // Trailing gap was not followed by a change: trim it back.
    const c: Change = cur;
    c.end = c.start + c.after.length;
    c.oldEnd = c.oldStart + c.before.length;
  }
  close();
  return out;
}

export function diffBodies(oldBody: string, newBody: string): PageDiff {
  const oldBlocks = lexBlocks(oldBody);
  const newBlocks = lexBlocks(newBody);
  const changes: Change[] = [];
  const pairs = alignBlocks(oldBlocks, newBlocks);
  let k = 0;
  for (const pair of pairs) {
    const oldText = pair.o >= 0 ? oldBlocks[pair.o].text : "";
    const newText = pair.n >= 0 ? newBlocks[pair.n].text : "";
    if (oldText === newText) continue;
    if (pair.o < 0 || pair.n < 0 || !oldText || !newText) {
      changes.push({
        id: `c${k++}`,
        block: pair.n,
        oldBlock: pair.o,
        start: 0,
        end: newText.length,
        oldStart: 0,
        oldEnd: oldText.length,
        before: oldText,
        after: newText,
      });
      continue;
    }
    for (const c of spansOf(pair, oldText, newText, `c${k}`)) changes.push(c);
    k++;
  }
  return { oldBlocks, newBlocks, changes };
}

/**
 * Produce the body with one change reverted. Tries a precise text swap inside
 * the block's markdown source and falls back to restoring the whole block.
 */
export function revertChange(diff: PageDiff, change: Change): string {
  const blocks = diff.newBlocks.map((b) => b.raw);
  if (change.block < 0) {
    // The block was removed entirely: put the old block back before the next surviving block.
    const oldRaw = diff.oldBlocks[change.oldBlock]?.raw ?? "";
    const insertAt = nextSurvivingIndex(diff, change.oldBlock);
    blocks.splice(insertAt, 0, oldRaw.endsWith("\n") ? oldRaw : oldRaw + "\n\n");
    return blocks.join("");
  }
  const raw = blocks[change.block];
  let replaced: string | null = null;
  if (change.after && raw.includes(change.after)) {
    replaced = raw.replace(change.after, change.before);
  }
  if (replaced === null) {
    replaced = change.oldBlock >= 0 ? diff.oldBlocks[change.oldBlock].raw : "";
    if (replaced && !replaced.endsWith("\n") && raw.endsWith("\n")) replaced += "\n";
  }
  blocks[change.block] = replaced;
  return blocks.join("");
}

function nextSurvivingIndex(diff: PageDiff, oldBlock: number): number {
  for (let i = oldBlock + 1; i < diff.oldBlocks.length; i++) {
    const text = diff.oldBlocks[i].text;
    if (!text) continue;
    const j = diff.newBlocks.findIndex((b) => b.text === text);
    if (j >= 0) return j;
  }
  return diff.newBlocks.length;
}
