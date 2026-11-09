import { test } from "node:test";
import assert from "node:assert/strict";
import { followScrollTop, linkScroll } from "./useSyncScroll";

/** A pane `page` px tall seen through a `view` px window, scrolled to `top`. */
const pane = (page: number, view: number, top = 0) => ({ scrollHeight: page, clientHeight: view, scrollTop: top });

test("two panes of the same height scroll together pixel for pixel", () => {
  assert.equal(followScrollTop(pane(3000, 800, 1234), pane(3000, 800)), 1234);
});

test("the other pane goes to the same fraction of its own range", () => {
  // Half of 2200 is 1100; half of 1600 is 800. The main pane renders taller than the split.
  assert.equal(followScrollTop(pane(3000, 800, 1100), pane(2400, 800)), 800);
  assert.equal(followScrollTop(pane(2400, 800, 800), pane(3000, 800)), 1100);
});

test("top and bottom map to top and bottom", () => {
  assert.equal(followScrollTop(pane(3000, 800, 2200), pane(1800, 600)), 1200);
  assert.equal(followScrollTop(pane(3000, 800, 0), pane(1800, 600, 500)), 0);
});

test("the target is a whole pixel", () => {
  // 100 / 2200 of 1000 is 45.45…
  assert.equal(followScrollTop(pane(3000, 800, 100), pane(1800, 800)), 45);
});

test("nothing to follow when either pane fits its window", () => {
  assert.equal(followScrollTop(pane(800, 800, 0), pane(3000, 800, 500)), null);
  assert.equal(followScrollTop(pane(3000, 800, 500), pane(600, 800)), null);
});

// Writing a scrollTop the pane already has (or nearly has) would come back as its own scroll event.
test("no move when the other pane is already within a pixel", () => {
  assert.equal(followScrollTop(pane(3000, 800, 1100), pane(2400, 800, 800)), null);
  assert.equal(followScrollTop(pane(3000, 800, 1100), pane(2400, 800, 800.5)), null);
  assert.equal(followScrollTop(pane(3000, 800, 1100), pane(2400, 800, 799)), 800);
});

// linkScroll against stand-in panes that keep a browser's order of events. A scrollTop written now
// fires its scroll event at the next frame, after this frame's requestAnimationFrame callbacks; Chrome
// does this when the write happens inside the other pane's scroll handler.
class FakePane extends EventTarget {
  #top = 0;
  moved = false;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  constructor(scrollHeight: number, clientHeight: number) {
    super();
    this.scrollHeight = scrollHeight;
    this.clientHeight = clientHeight;
  }
  get scrollTop() {
    return this.#top;
  }
  set scrollTop(top: number) {
    const clamped = Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight));
    if (clamped === this.#top) return;
    this.#top = clamped;
    this.moved = true;
  }
}

let callbacks: FrameRequestCallback[] = [];
globalThis.requestAnimationFrame = (cb) => callbacks.push(cb);

/** One frame: the panes that moved since the last one get their scroll event, then the frame callbacks run. */
function frame(...panes: FakePane[]) {
  const moved = panes.filter((p) => p.moved);
  for (const p of moved) p.moved = false;
  for (const p of moved) p.dispatchEvent(new Event("scroll"));
  const due = callbacks;
  callbacks = [];
  for (const cb of due) cb(0);
}

/** The reader scrolls `pane` to `top`, then a few frames pass. */
function scrollBy(reader: FakePane, top: number, ...panes: FakePane[]) {
  reader.scrollTop = top;
  for (let i = 0; i < 4; i++) frame(...panes);
}

// The page in a narrow split runs more than twice as long as in the main pane (measured in Chrome:
// 875 and 1571 px tall in a 352 px window). Rounding the main pane's place back into the split's is
// then off by more than a pixel, so the split's own scroll must never come back to it.
test("scrolling one pane leaves it where the reader put it", () => {
  const main = new FakePane(875, 352);
  const split = new FakePane(1571, 352);
  const unlink = linkScroll(main, split);
  try {
    const landed: number[] = [];
    for (let top = 201; top <= 212; top++) {
      scrollBy(split, top, main, split);
      landed.push(split.scrollTop);
    }
    assert.deepEqual(landed, [201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212]);
    assert.equal(main.scrollTop, Math.round((212 / 1219) * 523));
  } finally {
    unlink();
  }
});

test("each pane follows the other, both ways", () => {
  const main = new FakePane(3000, 800);
  const split = new FakePane(2400, 800);
  const unlink = linkScroll(main, split);
  try {
    scrollBy(main, 1100, main, split);
    assert.equal(split.scrollTop, 800);
    scrollBy(split, 400, main, split);
    assert.equal(main.scrollTop, 550);
    scrollBy(main, 2200, main, split);
    assert.equal(split.scrollTop, 1600);
  } finally {
    unlink();
  }
});

test("the split lines up with the main pane when they are linked, and stops following once unlinked", () => {
  const main = new FakePane(3000, 800);
  main.scrollTop = 1100;
  main.moved = false;
  const split = new FakePane(2400, 800);
  const unlink = linkScroll(main, split);
  assert.equal(split.scrollTop, 800);
  frame(main, split);
  unlink();
  scrollBy(main, 0, main, split);
  assert.equal(split.scrollTop, 800);
});
