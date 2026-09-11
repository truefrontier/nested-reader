/**
 * Wrap character ranges of an element's text content in spans without
 * touching the surrounding markup. Offsets are measured over
 * `el.textContent`, so they survive re-rendering the same HTML.
 */
export type Wrap = {
  start: number;
  end: number;
  className: string;
  attrs?: Record<string, string>;
};

type Seg = { node: Text; start: number; end: number };

function textNodes(el: Element): Seg[] {
  const out: Seg[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let n: Node | null = walker.nextNode();
  while (n) {
    const t = n as Text;
    const len = t.data.length;
    out.push({ node: t, start: pos, end: pos + len });
    pos += len;
    n = walker.nextNode();
  }
  return out;
}

export function applyWraps(el: Element, wraps: Wrap[]): void {
  for (const w of wraps) {
    if (w.end <= w.start) continue;
    const segs = textNodes(el);
    for (const seg of segs) {
      const s = Math.max(w.start, seg.start);
      const e = Math.min(w.end, seg.end);
      if (e <= s) continue;
      let node = seg.node;
      if (s > seg.start) node = node.splitText(s - seg.start);
      if (e < seg.end) node.splitText(e - s);
      const span = document.createElement("span");
      span.className = w.className;
      if (w.attrs) for (const [k, v] of Object.entries(w.attrs)) span.setAttribute(k, v);
      node.parentNode?.insertBefore(span, node);
      span.appendChild(node);
    }
  }
}

/** Offsets of a DOM range relative to `el.textContent`, or null if outside. */
export function rangeOffsets(el: Element, range: Range): { start: number; end: number } | null {
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return null;
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  const end = start + range.toString().length;
  return { start, end };
}
