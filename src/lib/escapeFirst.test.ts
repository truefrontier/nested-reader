import { test } from "node:test";
import assert from "node:assert/strict";
import { onEscapeFirst } from "./escapeFirst";

type Listener = (e: Event) => void;

/**
 * A window for a key pressed with focus somewhere in the page. As in a browser, the window's capture
 * listeners run first, and its ordinary (bubble) listeners run only if none of them stopped the key.
 */
function fakeWindow() {
  const phases = { capture: [] as Listener[], bubble: [] as Listener[] };
  const phase = (capture?: boolean | AddEventListenerOptions) => (capture === true || (typeof capture === "object" && capture.capture) ? phases.capture : phases.bubble);
  return {
    addEventListener(_type: string, fn: Listener, capture?: boolean | AddEventListenerOptions) {
      phase(capture).push(fn);
    },
    removeEventListener(_type: string, fn: Listener, capture?: boolean | EventListenerOptions) {
      const list = phase(capture);
      if (list.includes(fn)) list.splice(list.indexOf(fn), 1);
    },
    press(key: string) {
      let stopped = false;
      const e = {
        key,
        defaultPrevented: false,
        preventDefault() {
          e.defaultPrevented = true;
        },
        stopPropagation() {
          stopped = true;
        },
      };
      for (const fn of [...phases.capture]) fn(e as unknown as Event);
      if (!stopped) for (const fn of [...phases.bubble]) fn(e as unknown as Event);
      return e;
    },
  };
}

/** App.tsx's window listener: Esc runs store.escape(), which can close the find bar or cancel a refine. */
function appEscape(win: ReturnType<typeof fakeWindow>) {
  const calls = { escape: 0 };
  win.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape") calls.escape++;
  });
  return calls;
}

test("Esc on an open menu closes it, and store.escape isn't called", () => {
  const win = fakeWindow();
  const store = appEscape(win);
  let closed = 0;
  onEscapeFirst(win, () => closed++);
  const e = win.press("Escape");
  assert.equal(closed, 1);
  assert.equal(store.escape, 0);
  assert.equal(e.defaultPrevented, true);
});

test("other keys pass through to the window, and Esc does once the menu stops listening", () => {
  const win = fakeWindow();
  const store = appEscape(win);
  let closed = 0;
  const stop = onEscapeFirst(win, () => closed++);
  assert.equal(win.press("ArrowDown").defaultPrevented, false);
  stop();
  win.press("Escape");
  assert.equal(closed, 0);
  assert.equal(store.escape, 1);
});
