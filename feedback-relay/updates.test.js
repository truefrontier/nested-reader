import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";
import { assetName, forgetLatest, publicOrigin, rewriteManifest } from "./updates.js";

const env = { GITHUB_TOKEN: "t", GITHUB_REPO: "o/r" };
const get = (path, headers = {}) => new Request(`http://relay.test${path}`, { headers });

const release = {
  tag_name: "v0.2.0",
  assets: [
    { id: 11, name: "latest.json" },
    { id: 12, name: "Nested.app.tar.gz" },
    { id: 13, name: "Nested.app.tar.gz.sig" },
    { id: 14, name: "Nested_0.2.0_universal.dmg" },
  ],
};
const manifest = {
  version: "0.2.0",
  notes: "Fixes the tree.",
  platforms: {
    "darwin-aarch64": { signature: "sig", url: "https://github.com/o/r/releases/download/v0.2.0/Nested.app.tar.gz" },
    "darwin-x86_64": { signature: "sig", url: "https://github.com/o/r/releases/download/v0.2.0/Nested.app.tar.gz" },
  },
};

/** Stubs GitHub: the latest release, the manifest asset's bytes, and a 302 for any other asset. */
function stubGitHub(calls, { latest = release } = {}) {
  return async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/releases/latest")) return latest ? Response.json(latest) : new Response("no", { status: 404 });
    const asset = url.match(/\/releases\/assets\/(\d+)$/)?.[1];
    if (asset === "11") return Response.json(manifest);
    if (asset === "99") return new Response("no", { status: 404 });
    return new Response(null, { status: 302, headers: { location: `https://objects.githubusercontent.com/signed/${asset}` } });
  };
}

async function withGitHub(fn, opts) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = stubGitHub(calls, opts);
  forgetLatest();
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = real;
    forgetLatest();
  }
}

test("the manifest comes back with downloads pointed at the relay", () =>
  withGitHub(async (calls) => {
    const res = await worker.fetch(get("/updates/latest.json?version=0.1.0&target=darwin&arch=aarch64", { "x-forwarded-proto": "https" }), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.version, "0.2.0");
    assert.equal(body.notes, "Fixes the tree.");
    assert.equal(body.platforms["darwin-aarch64"].url, "https://relay.test/updates/download/12/Nested.app.tar.gz");
    assert.equal(body.platforms["darwin-aarch64"].signature, "sig");
    assert.equal(body.platforms["darwin-x86_64"].url, "https://relay.test/updates/download/12/Nested.app.tar.gz");
    assert.equal(calls[0].init.headers.Authorization, "Bearer t");
    assert.equal(calls[1].init.headers.Accept, "application/octet-stream");
  }));

test("the release lookup is remembered for a minute", () =>
  withGitHub(async (calls) => {
    await worker.fetch(get("/updates/latest.json"), env);
    await worker.fetch(get("/updates/dmg"), env);
    assert.equal(calls.filter((c) => c.url.endsWith("/releases/latest")).length, 1);
  }));

test("no release yet means 204 for the app and 404 for the dmg link", () =>
  withGitHub(
    async () => {
      assert.equal((await worker.fetch(get("/updates/latest.json"), env)).status, 204);
      assert.equal((await worker.fetch(get("/updates/dmg"), env)).status, 404);
    },
    { latest: null },
  ));

test("a download redirects to GitHub's signed link without streaming through the relay", () =>
  withGitHub(async (calls) => {
    const res = await worker.fetch(get("/updates/download/12/Nested.app.tar.gz"), env);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "https://objects.githubusercontent.com/signed/12");
    assert.equal(calls[0].init.redirect, "manual");
    assert.equal((await worker.fetch(get("/updates/download/99/gone.dmg"), env)).status, 404);
  }));

test("the dmg link goes to the newest release's disk image", () =>
  withGitHub(async () => {
    const res = await worker.fetch(get("/updates/dmg"), env);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "http://relay.test/updates/download/14/Nested_0.2.0_universal.dmg");
  }));

test("update routes refuse POST and unknown paths, and need the token", async () => {
  assert.equal((await worker.fetch(new Request("http://relay.test/updates/latest.json", { method: "POST" }), env)).status, 405);
  assert.equal((await worker.fetch(get("/updates/nope"), env)).status, 404);
  assert.equal((await worker.fetch(get("/updates/latest.json"), { GITHUB_REPO: "o/r" })).status, 500);
});

test("helpers: asset names, origins and manifest rewriting", () => {
  assert.equal(assetName("https://github.com/o/r/releases/download/v1/Nested%20App.app.tar.gz"), "Nested App.app.tar.gz");
  assert.equal(assetName("not a url"), "");
  assert.equal(publicOrigin(get("/x", { "x-forwarded-proto": "https, http" }), new URL("http://relay.test/x")), "https://relay.test");
  assert.equal(publicOrigin(get("/x"), new URL("http://relay.test/x")), "http://relay.test");
  const out = rewriteManifest({ version: "1", platforms: { "linux-x86_64": { url: "https://x/none.AppImage", signature: "s" } } }, release.assets, "https://r");
  assert.equal(out.platforms["linux-x86_64"].url, "https://x/none.AppImage");
  assert.deepEqual(rewriteManifest({ version: "1" }, [], "https://r"), { version: "1", platforms: {} });
});
