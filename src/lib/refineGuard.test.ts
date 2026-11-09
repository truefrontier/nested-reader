import { test } from "node:test";
import assert from "node:assert/strict";
import { guardedRefine, hashPage, MAX_REFINE_RETRIES } from "./refineGuard";

/** A page that `edits` rewrites during each generate call, standing in for edits made mid-stream. */
function harness(edits: string[]) {
  let page = "v0";
  let calls = 0;
  const written: string[] = [];
  const sentTo: string[] = [];
  const run = () =>
    guardedRefine<string>({
      read: async () => page,
      latest: async () => page,
      generate: async (body) => {
        sentTo.push(body);
        const out = "refined(" + body + ")";
        if (calls < edits.length) page = edits[calls];
        calls++;
        return out;
      },
      apply: async (_body, result, unchanged) => {
        if (!(await unchanged())) return false;
        written.push(result);
        page = result;
        return true;
      },
    });
  return { run, written, sentTo, page: () => page };
}

test("hashPage ignores line endings but not content", async () => {
  assert.equal(await hashPage("a\r\nb"), await hashPage("a\nb"));
  assert.notEqual(await hashPage("a\nb"), await hashPage("a\nc"));
});

test("an unchanged page applies the result", async () => {
  const h = harness([]);
  await h.run();
  assert.deepEqual(h.sentTo, ["v0"]);
  assert.deepEqual(h.written, ["refined(v0)"]);
});

test("a changed page discards the result and re-refines the current text", async () => {
  const h = harness(["v0 edited"]);
  await h.run();
  assert.deepEqual(h.sentTo, ["v0", "v0 edited"]);
  assert.deepEqual(h.written, ["refined(v0 edited)"]);
});

test("a page that keeps changing stops at the retry cap and is left untouched", async () => {
  const edits = Array.from({ length: MAX_REFINE_RETRIES + 5 }, (_, i) => "edit " + i);
  const h = harness(edits);
  await assert.rejects(h.run(), /kept changing/);
  assert.equal(h.sentTo.length, MAX_REFINE_RETRIES + 1);
  assert.deepEqual(h.written, []);
  assert.equal(h.page(), "edit " + MAX_REFINE_RETRIES);
});

test("a refine stopped while the model runs starts no other try and writes nothing", async () => {
  let page = "v0";
  let stopped = false;
  const sentTo: string[] = [];
  const written: string[] = [];
  await guardedRefine<string>({
    read: async () => page,
    latest: async () => page,
    generate: async (body) => {
      sentTo.push(body);
      page = "edited";
      stopped = true;
      return "refined(" + body + ")";
    },
    apply: async (_body, result, unchanged) => {
      if (!(await unchanged())) return false;
      written.push(result);
      return true;
    },
    stopped: () => stopped,
  });
  assert.deepEqual(sentTo, ["v0"]);
  assert.deepEqual(written, []);
});
