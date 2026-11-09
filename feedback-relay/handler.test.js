import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { addressKey, nodeHandler, noteLimiter } from "./handler.js";

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

// Each note costs a GitHub call, an Actions run and a Claude triage, so the Node side (what Fly runs)
// counts notes per caller and in all before it reads a byte of the body.
const note = (base, headers = {}) =>
  fetch(base, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ message: "hi" }) });

async function serveLimited(options) {
  const server = createServer(nodeHandler({ GITHUB_REPO: "truefrontier/nested-reader" }, options));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test("behind Fly, notes are counted per Fly-Client-IP, and X-Forwarded-For can't reset the count", async (t) => {
  const { server, base } = await serveLimited({ behindFly: true, limiter: noteLimiter({ perIp: 2, total: 100 }) });
  t.after(() => server.close());
  const caller = { "Fly-Client-IP": "203.0.113.7" };
  assert.equal((await note(base, caller)).status, 500);
  assert.equal((await note(base, caller)).status, 500);
  const refused = await note(base, { ...caller, "X-Forwarded-For": "198.51.100.1" });
  assert.equal(refused.status, 429);
  assert.match(refused.headers.get("retry-after"), /^\d+$/);
  assert.match(await refused.text(), /^Too many notes/);
  assert.equal((await note(base, { "Fly-Client-IP": "203.0.113.8" })).status, 500);
});

test("off Fly, a caller's own Fly-Client-IP or X-Forwarded-For header doesn't make it someone new", async (t) => {
  const { server, base } = await serveLimited({ limiter: noteLimiter({ perIp: 1, total: 100 }) });
  t.after(() => server.close());
  assert.equal((await note(base)).status, 500);
  assert.equal((await note(base, { "Fly-Client-IP": "203.0.113.9" })).status, 429);
  assert.equal((await note(base, { "X-Forwarded-For": "198.51.100.2" })).status, 429);
});

test("every caller together has a ceiling too", async (t) => {
  const { server, base } = await serveLimited({ behindFly: true, limiter: noteLimiter({ perIp: 5, total: 2 }) });
  t.after(() => server.close());
  assert.equal((await note(base, { "Fly-Client-IP": "203.0.113.1" })).status, 500);
  assert.equal((await note(base, { "Fly-Client-IP": "203.0.113.2" })).status, 500);
  assert.equal((await note(base, { "Fly-Client-IP": "203.0.113.3" })).status, 429);
});

test("update checks and health checks aren't counted as notes", async (t) => {
  const { server, base } = await serveLimited({ behindFly: true, limiter: noteLimiter({ perIp: 1, total: 1 }) });
  t.after(() => server.close());
  for (let i = 0; i < 3; i++) {
    assert.equal((await fetch(`${base}/updates/latest.json`, { headers: { "Fly-Client-IP": "203.0.113.4" } })).status, 500);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  }
  // A POST to an update route files nothing (the worker answers 405), so it isn't counted either.
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${base}/updates/latest.json`, { method: "POST", headers: { "Fly-Client-IP": "203.0.113.4" } });
    assert.equal(res.status, 405);
  }
  assert.equal((await note(base, { "Fly-Client-IP": "203.0.113.4" })).status, 500);
});

test("the limiter forgets a caller once the window has passed", () => {
  let now = 0;
  const take = noteLimiter({ perIp: 1, total: 10, windowMs: 60_000, now: () => now });
  assert.equal(take("a"), 0);
  assert.equal(take("a"), 60);
  now = 30_000;
  assert.equal(take("a"), 30);
  assert.equal(take("b"), 0);
  now = 60_000;
  assert.equal(take("a"), 0);
});

test("an IPv6 caller counts by its /64, the block one customer is handed", () => {
  assert.equal(addressKey("2001:db8:1:2::1"), addressKey("2001:0DB8:0001:0002:ffff:0:0:9"));
  assert.notEqual(addressKey("2001:db8:1:2::1"), addressKey("2001:db8:1:3::1"));
  assert.equal(addressKey("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(addressKey("203.0.113.7"), "203.0.113.7");
  assert.equal(addressKey("fe80::1%en0"), addressKey("fe80::2"));
});

test("the limiter says so in the log, once, when everyone together reaches the hourly cap", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const take = noteLimiter({ perIp: 5, total: 2, now: () => 0 });
  take("a");
  assert.equal(warn.mock.callCount(), 0);
  take("b");
  take("c");
  take("d");
  assert.equal(warn.mock.callCount(), 1);
  // It names the cap, never a caller.
  const line = warn.mock.calls[0].arguments.join(" ");
  assert.match(line, /2 notes/);
  assert.doesNotMatch(line, /"[ab]"|: [ab]\b/);
});

// An older app still lets a 5 MB screenshot through, about 7 MB as JSON. The body is read in full rather than
// cut off, so the worker can answer why it's refused, which the app shows, instead of the upload just failing.
test("an older app's 5 MB screenshot gets the 2 MB reason through the Node side, not a hang-up", async (t) => {
  const real = globalThis.fetch;
  globalThis.fetch = (url, init) => (String(url).startsWith("http://127.0.0.1:") ? real(url, init) : Promise.reject(new Error(`no call out: ${url}`)));
  t.after(() => {
    globalThis.fetch = real;
  });
  const server = createServer(nodeHandler({ GITHUB_TOKEN: "t", GITHUB_REPO: "o/r" }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const data = "iVBORw0KGgo" + "A".repeat(Math.ceil((5 * 1024 * 1024 * 4) / 3));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "It broke", attachment: { name: "shot.png", mime: "image/png", data } }),
  });
  assert.equal(res.status, 413);
  assert.equal(await res.text(), "Keep the screenshot under 2 MB.");
});
