import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The webview can read and write files anywhere and ask for AI answers with the keychain's keys, so
// what may run in it, and where it may send things, is the line between an opened document and the Mac.

/** The webview's Content-Security-Policy from the Tauri config, directive by directive. */
function policy(): Map<string, string[]> {
  const conf = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const csp: unknown = conf.app.security.csp;
  assert.equal(typeof csp, "string", "tauri.conf.json sets no Content-Security-Policy");
  const directives = (csp as string).split(";").map((d) => d.trim().split(/\s+/));
  return new Map(directives.filter((d) => d[0]).map(([name, ...sources]) => [name, sources]));
}

test("scripts run only from the app's own files", () => {
  const p = policy();
  // No 'unsafe-inline' or 'unsafe-eval': markup that slips past the sanitizer stays inert.
  assert.deepEqual(p.get("script-src"), ["'self'"]);
  assert.deepEqual(p.get("object-src"), ["'none'"]);
  assert.deepEqual(p.get("base-uri"), ["'none'"]);
});

test("fetch and XHR reach nothing but the app's own backend", () => {
  const p = policy();
  // Every request that carries a key is made in Rust, so a script in the page can't fetch, post or
  // open a socket anywhere else. Images still load from anywhere (notes show remote images), so a
  // script could still send a little out in an image's URL; closing that means blocking remote images.
  assert.deepEqual(p.get("connect-src"), ["ipc:", "http://ipc.localhost"]);
  // A form in a document can't take the window to another site.
  assert.deepEqual(p.get("form-action"), ["'none'"]);
  assert.deepEqual(p.get("frame-src"), ["'none'"]);
});
