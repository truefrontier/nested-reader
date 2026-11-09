import { test } from "node:test";
import assert from "node:assert/strict";
import { followScrollTop } from "./useSyncScroll";

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
