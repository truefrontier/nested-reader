import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { detail, issueBody, titleFor, validAttachment } from "./worker.js";

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

test("body embeds the screenshot when one was uploaded", () => {
  const body = issueBody("hi", "", {}, "https://raw.githubusercontent.com/o/r/feedback-attachments/shot.png");
  assert.match(body, /!\[Screenshot\]\(https:\/\/raw\.githubusercontent\.com\/o\/r\/feedback-attachments\/shot\.png\)/);
  assert.doesNotMatch(issueBody("hi", "", {}), /!\[Screenshot\]/);
});

test("an attachment must be a small, supported image", () => {
  const small = "A".repeat(100);
  assert.deepEqual(validAttachment({ name: "shot.png", mime: "image/png", data: small }), { mime: "image/png", ext: "png", name: "shot.png", data: small });
  assert.equal(validAttachment({ mime: "image/png", data: small }).name, "screenshot.png");
  assert.equal(validAttachment(null), null);
  assert.equal(validAttachment({ mime: "text/plain", data: small }), null);
  assert.equal(validAttachment({ mime: "image/png", data: "" }), null);
  assert.equal(validAttachment({ mime: "image/png", data: "A".repeat(10_000_000) }), null);
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

test("refuses a note with a malformed attachment", async () => {
  assert.equal((await worker.fetch(post({ message: "hi", attachment: { mime: "text/plain", data: "AA==" } }), env)).status, 400);
});

test("uploads a screenshot to its own branch and embeds it in the issue", async () => {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const call = { url, init, body: init?.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (url.endsWith("/git/ref/heads/feedback-attachments")) return new Response("not found", { status: 404 });
    if (url === "https://api.github.com/repos/o/r") return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
    if (url.endsWith("/git/ref/heads/main")) return new Response(JSON.stringify({ object: { sha: "base-sha" } }), { status: 200 });
    if (url.endsWith("/git/refs")) return new Response(JSON.stringify({ ref: "refs/heads/feedback-attachments" }), { status: 201 });
    if (url.includes("/contents/")) return new Response(JSON.stringify({ content: { path: call.body.path } }), { status: 201 });
    if (url.endsWith("/issues")) return new Response(JSON.stringify({ number: 9, html_url: "https://github.com/o/r/issues/9" }), { status: 201 });
    throw new Error(`unexpected call to ${url}`);
  };
  try {
    const res = await worker.fetch(post({ message: "It broke", attachment: { name: "shot.png", mime: "image/png", data: "aGVsbG8=" } }), env);
    assert.equal(res.status, 201);
    const refCreate = calls.find((c) => c.url.endsWith("/git/refs"));
    assert.deepEqual(refCreate.body, { ref: "refs/heads/feedback-attachments", sha: "base-sha" });
    const upload = calls.find((c) => c.url.includes("/contents/"));
    assert.equal(upload.init.method, "PUT");
    assert.equal(upload.body.branch, "feedback-attachments");
    assert.equal(upload.body.content, "aGVsbG8=");
    const issueCall = calls.find((c) => c.url.endsWith("/issues"));
    assert.match(issueCall.body.body, /!\[Screenshot\]\(https:\/\/raw\.githubusercontent\.com\/o\/r\/feedback-attachments\//);
  } finally {
    globalThis.fetch = real;
  }
});

test("still files the note when the screenshot upload fails", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes("/git/") || url === "https://api.github.com/repos/o/r") return new Response("nope", { status: 500 });
    if (url.endsWith("/issues")) return new Response(JSON.stringify({ number: 1, html_url: "https://github.com/o/r/issues/1" }), { status: 201 });
    throw new Error(`unexpected call to ${url}`);
  };
  try {
    const res = await worker.fetch(post({ message: "hi", attachment: { mime: "image/png", data: "aGVsbG8=" } }), env);
    assert.equal(res.status, 201);
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
