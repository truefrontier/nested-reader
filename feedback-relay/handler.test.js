import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { nodeHandler } from "./handler.js";

// No GITHUB_TOKEN: a request that reaches the worker is answered locally and nothing leaves the machine.
async function serve() {
  const server = createServer(nodeHandler({ GITHUB_REPO: "truefrontier/nested-reader" }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test("a note still passes through to the worker", async (t) => {
  const { server, base } = await serve();
  t.after(() => server.close());
  const res = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "hi" }) });
  assert.equal(res.status, 500);
  assert.equal(await res.text(), "The relay has no GITHUB_TOKEN set");
});

test("a client that hangs up mid-upload does not take the relay down", async (t) => {
  const { server, base } = await serve();
  t.after(() => server.close());
  const { port } = server.address();
  await new Promise((resolve) => {
    const sock = connect(port, "127.0.0.1", () => {
      sock.write("POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{\"message\":");
      setTimeout(() => {
        sock.destroy();
        resolve();
      }, 50);
    });
  });
  // An unhandled rejection would have ended this process (and its test) by now.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test("a body larger than any note with a screenshot is cut off, and the relay keeps serving", async (t) => {
  const { server, base } = await serve();
  t.after(() => server.close());
  // Read in full, this would reach the worker and come back as an answer; cut off, the upload fails.
  await assert.rejects(fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: "x".repeat(9 * 1024 * 1024) }));
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});
