import { test } from "node:test";
import assert from "node:assert/strict";
import type { StreamEvent } from "./types";
import { trackStream } from "./stream";

/** A backend whose events and end the test drives by hand. */
function backend() {
  let send!: (e: StreamEvent) => void;
  let end!: (sent: boolean) => void;
  let fail!: (err: unknown) => void;
  let cancelled = 0;
  const open = (s: (e: StreamEvent) => void) => {
    send = s;
    const ended = new Promise<boolean>((res, rej) => {
      end = res;
      fail = rej;
    });
    return { ended, cancel: () => void cancelled++ };
  };
  return { open, send: (e: StreamEvent) => send(e), end: (sent: boolean) => end(sent), fail: (e: unknown) => fail(e), cancelled: () => cancelled };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("events pass through until done, and nothing after it", async () => {
  const b = backend();
  const got: StreamEvent[] = [];
  trackStream((e) => got.push(e), b.open);
  b.send({ type: "delta", text: "a" });
  b.send({ type: "tool", name: "read_page", detail: "Reading a.md" } as StreamEvent);
  b.send({ type: "done" });
  b.send({ type: "delta", text: "late" });
  b.end(true);
  await tick();
  assert.deepEqual(got.map((e) => e.type), ["delta", "tool", "done"]);
});

test("a stream that ends without done or error is settled with an error", async () => {
  const b = backend();
  const got: StreamEvent[] = [];
  trackStream((e) => got.push(e), b.open);
  b.send({ type: "delta", text: "a" });
  b.end(false);
  await tick();
  assert.deepEqual(got.at(-1), { type: "error", message: "The stream stopped without finishing. Try again." });
});

test("a backend that says it sent its last event is left for that event to arrive", async () => {
  const b = backend();
  const got: StreamEvent[] = [];
  trackStream((e) => got.push(e), b.open);
  b.end(true);
  await tick();
  assert.deepEqual(got, []);
  b.send({ type: "done" });
  assert.deepEqual(got, [{ type: "done" }]);
});

test("a backend failure becomes one error event", async () => {
  const b = backend();
  const got: StreamEvent[] = [];
  trackStream((e) => got.push(e), b.open);
  b.fail("offline");
  await tick();
  assert.deepEqual(got, [{ type: "error", message: "offline" }]);
});

test("cancel stops the backend and silences everything after it", async () => {
  const b = backend();
  const got: StreamEvent[] = [];
  const handle = trackStream((e) => got.push(e), b.open);
  handle.cancel();
  b.send({ type: "delta", text: "late" });
  b.end(false);
  await tick();
  assert.equal(b.cancelled(), 1);
  assert.deepEqual(got, []);
});
