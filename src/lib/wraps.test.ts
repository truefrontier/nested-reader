import { test } from "node:test";
import assert from "node:assert/strict";
import { applyWraps, rangeOffsets } from "./wraps";

// Node has no DOM, and nothing else under test needs one, so this is the smallest stand-in that does
// what the DOM spec says for the calls wraps.ts makes: splitText leaves the head in place and puts the
// tail right after it, insertBefore moves a node out of its old parent, and a range boundary in an
// element counts the text of the children before its offset.

class Txt {
  parentNode: El | null = null;
  data: string;
  constructor(data: string) {
    this.data = data;
  }
  get textContent() {
    return this.data;
  }
  get parentElement() {
    return this.parentNode;
  }
  splitText(offset: number): Txt {
    const tail = new Txt(this.data.slice(offset));
    this.data = this.data.slice(0, offset);
    const parent = this.parentNode!;
    parent.insertBefore(tail, parent.childNodes[parent.childNodes.indexOf(this) + 1] ?? null);
    return tail;
  }
}

class El {
  parentNode: El | null = null;
  childNodes: (El | Txt)[] = [];
  className = "";
  attrs: [string, string][] = [];
  ownerDocument = fakeDocument;
  tagName: string;
  constructor(tagName: string) {
    this.tagName = tagName;
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  get parentElement() {
    return this.parentNode;
  }
  insertBefore<T extends El | Txt>(node: T, ref: El | Txt | null): T {
    if (node.parentNode) node.parentNode.childNodes.splice(node.parentNode.childNodes.indexOf(node), 1);
    const at = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    this.childNodes.splice(at, 0, node);
    node.parentNode = this;
    return node;
  }
  appendChild<T extends El | Txt>(node: T): T {
    return this.insertBefore(node, null);
  }
  setAttribute(name: string, value: string) {
    this.attrs.push([name, value]);
  }
  contains(node: El | Txt): boolean {
    for (let n: El | Txt | null = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
}

function textsIn(node: El | Txt): Txt[] {
  return node instanceof Txt ? [node] : node.childNodes.flatMap(textsIn);
}

const fakeDocument = {
  createElement: (tag: string) => new El(tag.toUpperCase()),
  // applyWraps reads every text node before it changes any, so a list taken up front walks the same.
  createTreeWalker: (root: El) => {
    const nodes = textsIn(root);
    return { nextNode: () => nodes.shift() ?? null };
  },
};
Object.assign(globalThis, { document: fakeDocument, NodeFilter: { SHOW_TEXT: 4 } });

/** Where a range boundary falls in the whole tree's text. */
function position(node: El | Txt, offset: number): number {
  const before = (list: (El | Txt)[]) => list.reduce((n, c) => n + c.textContent.length, 0);
  let p = node instanceof Txt ? offset : before(node.childNodes.slice(0, offset));
  for (let n: El | Txt = node; n.parentNode; n = n.parentNode) p += before(n.parentNode.childNodes.slice(0, n.parentNode.childNodes.indexOf(n)));
  return p;
}

class FakeRange {
  startContainer: El | Txt;
  startOffset: number;
  endContainer: El | Txt;
  endOffset: number;
  constructor(startContainer: El | Txt, startOffset: number, endContainer: El | Txt, endOffset: number) {
    this.startContainer = startContainer;
    this.startOffset = startOffset;
    this.endContainer = endContainer;
    this.endOffset = endOffset;
  }
  cloneRange() {
    return new FakeRange(this.startContainer, this.startOffset, this.endContainer, this.endOffset);
  }
  selectNodeContents(el: El) {
    Object.assign(this, { startContainer: el, startOffset: 0, endContainer: el, endOffset: el.childNodes.length });
  }
  setEnd(node: El | Txt, offset: number) {
    Object.assign(this, { endContainer: node, endOffset: offset });
  }
  toString() {
    let root = this.startContainer;
    while (root.parentNode) root = root.parentNode;
    return root.textContent.slice(position(this.startContainer, this.startOffset), position(this.endContainer, this.endOffset));
  }
}

function h(tag: string, ...children: (El | Txt | string)[]): El {
  const el = new El(tag.toUpperCase());
  for (const c of children) el.appendChild(typeof c === "string" ? new Txt(c) : c);
  return el;
}

function html(node: El | Txt): string {
  if (node instanceof Txt) return node.data;
  const tag = node.tagName.toLowerCase();
  const cls = node.className ? ` class="${node.className}"` : "";
  const attrs = node.attrs.map(([k, v]) => ` ${k}="${v}"`).join("");
  return `<${tag}${cls}${attrs}>${node.childNodes.map(html).join("")}</${tag}>`;
}

const asElement = (el: El) => el as unknown as Element;

test("a wrap across inline markup becomes one span per text piece, and the text reads the same", () => {
  const p = h("p", "Hello ", h("b", "big"), " world");
  applyWraps(asElement(p), [{ start: 4, end: 11, className: "hl" }]);
  assert.equal(html(p), '<p>Hell<span class="hl">o </span><b><span class="hl">big</span></b><span class="hl"> w</span>orld</p>');
  assert.equal(p.textContent, "Hello big world");
});

test("wraps carry their attributes, and later wraps still count from the original text", () => {
  const p = h("p", "Ripples carry the sequence.");
  applyWraps(asElement(p), [
    { start: 0, end: 7, className: "ask", attrs: { "data-ask": "0" } },
    { start: 14, end: 26, className: "change" },
  ]);
  assert.equal(html(p), '<p><span class="ask" data-ask="0">Ripples</span> carry <span class="change">the sequence</span>.</p>');
});

test("an empty or backwards wrap changes nothing", () => {
  const p = h("p", "Ripples.");
  applyWraps(asElement(p), [
    { start: 3, end: 3, className: "hl" },
    { start: 5, end: 2, className: "hl" },
  ]);
  assert.equal(html(p), "<p>Ripples.</p>");
});

test("the whitespace between table cells and list items is counted but never wrapped", () => {
  const table = h("table", h("tr", "\n", h("td", "A"), "\n", h("td", "B"), "\n"));
  applyWraps(asElement(table), [{ start: 0, end: 5, className: "hl" }]);
  assert.equal(html(table), '<table><tr>\n<td><span class="hl">A</span></td>\n<td><span class="hl">B</span></td>\n</tr></table>');
  const list = h("ul", "\n", h("li", "one"), "\n");
  applyWraps(asElement(list), [{ start: 1, end: 3, className: "hl" }]);
  assert.equal(html(list), '<ul>\n<li><span class="hl">on</span>e</li>\n</ul>');
});

test("a selection's offsets are counted over the block's text, across markup", () => {
  const hello = new Txt("Hello ");
  const world = new Txt(" world");
  const p = h("p", hello, h("b", "big"), world);
  h("article", h("h1", "Title"), p);
  const range = new FakeRange(hello, 4, world, 2);
  assert.deepEqual(rangeOffsets(asElement(p), range as unknown as Range), { start: 4, end: 11 });
  // The same span, wrapped, gives the same offsets back: what the reader stores is what it re-applies.
  applyWraps(asElement(p), [{ start: 4, end: 11, className: "hl" }]);
  assert.equal(p.textContent.slice(4, 11), "o big w");
});

test("a selection that starts or ends outside the block has no offsets in it", () => {
  const inside = new Txt("Inside");
  const outside = new Txt("Outside");
  const p = h("p", inside);
  h("article", p, h("p", outside));
  assert.equal(rangeOffsets(asElement(p), new FakeRange(inside, 0, outside, 3) as unknown as Range), null);
  assert.equal(rangeOffsets(asElement(p), new FakeRange(outside, 0, inside, 3) as unknown as Range), null);
});
