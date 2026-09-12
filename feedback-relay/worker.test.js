import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { detail, issueBody, titleFor } from "./worker.js";

test("title is the first non-empty line, clipped", () => {
  assert.equal(titleFor("\n\n  The tree   loses my place\nmore"), "The tree loses my place");
  const long = "x".repeat(100);
  assert.equal(titleFor(long).length, 72);
  assert.ok(titleFor(long).endsWith("…"));
});

test("body quotes the note and carries the contact and app lines", () => {
  const body = issueBody("line one\nline two", "me@example.com", { version: "0.1.0", os: "macos", arch: "aarch64" });
  assert.match(body, /^Sent from the app/);
  assert.match(body, /> line one\n> line two/);
  assert.match(body, /\*\*Contact:\*\* me@example.com/);
  assert.match(body, /\*\*App:\*\* Nested 0\.1\.0, macos aarch64/);
  assert.match(issueBody("hi", "", {}), /\*\*Contact:\*\* none given/);
  assert.doesNotMatch(issueBody("hi", "", {}), /\*\*App:\*\*/);
});

test("app detail keeps only short strings", () => {
  assert.deepEqual(detail({ version: "1", os: 5, arch: "x".repeat(41), extra: "no" }), { version: "1" });
  assert.deepEqual(detail(null), {});
});

const env = { GITHUB_TOKEN: "t", GITHUB_REPO: "o/r" };
const post = (body) => new Request("https://relay.test/", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

test("refuses bad requests before touching GitHub", async () => {
  assert.equal((await worker.fetch(new Request("https://relay.test/"), env)).status, 405);
  assert.equal((await worker.fetch(post({ message: "  " }), env)).status, 400);
  assert.equal((await worker.fetch(post({ message: "hi", email: "nope" }), env)).status, 400);
  assert.equal((await worker.fetch(post({ message: "x".repeat(5001) }), env)).status, 413);
  assert.equal((await worker.fetch(post({ message: "hi" }), { GITHUB_REPO: "o/r" })).status, 500);
});

test("files the issue and answers with its number", async () => {
  const real = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ number: 7, html_url: "https://github.com/o/r/issues/7" }), { status: 201 });
  };
  try {
    const res = await worker.fetch(post({ message: "Filter box\nloses focus", email: "me@example.com", app: { version: "0.1.0" } }), env);
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { number: 7, url: "https://github.com/o/r/issues/7" });
    assert.equal(sent.url, "https://api.github.com/repos/o/r/issues");
    assert.equal(sent.init.headers.Authorization, "Bearer t");
    assert.equal(sent.body.title, "Filter box");
    assert.deepEqual(sent.body.labels, ["feedback"]);
    assert.match(sent.body.body, /me@example\.com/);
  } finally {
    globalThis.fetch = real;
  }
});

test("a GitHub refusal comes back as 502", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response("nope", { status: 401 });
  try {
    assert.equal((await worker.fetch(post({ message: "hi" }), env)).status, 502);
  } finally {
    globalThis.fetch = real;
  }
});
