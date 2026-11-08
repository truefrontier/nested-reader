import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import type { AiRequest, StreamEvent } from "../platform/types";

// `scripts/test-hooks.mjs` is enough for `src/lib`. The store also imports a directory
// (`../platform`), JSON (`package.json`) and `?raw` text (the mock's sample pages), as Vite allows.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if ((err as { code?: string }).code !== "ERR_UNSUPPORTED_DIR_IMPORT") throw err;
      return next(`${specifier}/index.ts`, context);
    }
  },
  load(url, context, next) {
    if (url.endsWith(".json")) {
      const json = JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as Record<string, unknown>;
      const named = Object.keys(json).map((k, i) => `const v${i} = json[${JSON.stringify(k)}]; export { v${i} as ${JSON.stringify(k)} };`);
      return { format: "module", source: [`const json = ${JSON.stringify(json)};`, "export default json;", ...named].join("\n"), shortCircuit: true };
    }
    if (url.endsWith("?raw")) return { format: "module", source: `export default ${JSON.stringify(readFileSync(fileURLToPath(url), "utf8"))};`, shortCircuit: true };
    return next(url, context);
  },
});

// The store runs against the browser mock's in-memory folders, and reaches its timers through `window`.
(globalThis as { window?: unknown }).window = globalThis;
// The mock tries localStorage for its settings and copes without it; Node's own only warns.
Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true });
const { store } = await import("./store");
const { platform, DEFAULT_SETTINGS } = await import("../platform");
const { trackStream } = await import("../platform/stream");
const { lexBlocks } = await import("../lib/markdown");
const { MAX_REFINE_RETRIES } = await import("../lib/refineGuard");

const F = "/test/refine";
const page = (title: string, text: string) => `---\ntitle: ${title}\n---\n\n# ${title}\n\n${text}\n`;
// One page per test, so nothing a test leaves running can touch another test's page.
for (const name of ["edited", "selection", "cap", "cancel", "snapshot"]) await platform.writePage(F, `${name}.md`, page(name, `The ${name} page as it was.`));
await platform.writePage(F, "selection.md", page("selection", "First paragraph.\n\nSecond paragraph to refine."));

/** Every page write's text, by page. The test's own edits go through `edit`, so they are not counted. */
const writes = new Map<string, string[]>();
const writePage = platform.writePage;
platform.writePage = function (folder, path, content) {
  writes.set(path, [...(writes.get(path) ?? []), content]);
  return writePage.call(this, folder, path, content);
};
/** A change to the page made outside the refine: by hand in another editor, or by anything else. */
const edit = (name: string, text: string) => writePage.call(platform, F, `${name}.md`, page(name, text));
const text = async (name: string) => (await platform.readPage(F, `${name}.md`)).body;
const written = (name: string) => (writes.get(`${name}.md`) ?? []).join("\n");

/** The answer streams the store starts, which the test drives by hand. A cancelled one passes nothing on. */
type Backend = { req: AiRequest; send: (e: StreamEvent) => void; cancelled: boolean };
let streams: Backend[] = [];
platform.aiStream = (req, onEvent) =>
  trackStream(onEvent, (send) => {
    const s: Backend = { req, send, cancelled: false };
    streams.push(s);
    return { ended: new Promise<boolean>(() => {}), cancel: () => void (s.cancelled = true) };
  });
const answer = (s: Backend, text: string) => {
  s.send({ type: "delta", text });
  s.send({ type: "done" });
};
const sent = (s: Backend) => s.req.messages.map((m) => m.content).join("\n");

store.state.settings = { ...DEFAULT_SETTINGS, models: { ...DEFAULT_SETTINGS.models, anthropic: "test-model" }, context: { ...DEFAULT_SETTINGS.context, map: false } };
await store.openFolder(F);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean) {
  for (let i = 0; i < 400 && !ok(); i++) await sleep(5);
  assert.ok(ok(), "timed out");
}
const errors = () => Object.values(store.state.ui.refines).flatMap((r) => (r.error ? [r.error] : []));

/** Starts a whole-page refine on one page; `settled` turns true once the refine has let go of the page. */
async function refinePage(name: string) {
  await store.navigate(`${name}.md`);
  streams = [];
  const run = { settled: false, done: Promise.resolve() };
  run.done = store.refine("Make it shorter", "page").then(() => void (run.settled = true));
  await until(() => streams.length === 1);
  return run;
}

test("a page edited while its refine runs is refined again on the new text, and the old answer is never written", async () => {
  const run = await refinePage("edited");
  await edit("edited", "Edited by hand while the model ran.");
  answer(streams[0], "# edited\n\nAn answer for the old text.");
  await until(() => streams.length === 2);
  assert.match(sent(streams[1]), /Edited by hand while the model ran\./);
  // The second try still holds the page's turn, and its card, until it lands.
  await sleep(20);
  assert.equal(run.settled, false);
  answer(streams[1], "# edited\n\nAn answer for the edited text.");
  await run.done;
  assert.match(await text("edited"), /An answer for the edited text\./);
  assert.doesNotMatch(written("edited"), /An answer for the old text/);
  assert.deepEqual(errors(), []);
});

test("a selection refine on a page edited elsewhere is run again, and keeps the edit", async () => {
  await store.navigate("selection.md");
  const body = store.state.bodies["selection.md"];
  const block = lexBlocks(body).findIndex((b) => b.text.includes("Second paragraph"));
  const selected = "Second paragraph to refine";
  store.setUi({ selection: { pane: "main", block, start: 0, end: selected.length, text: selected, paragraph: selected + ".", caretX: 0 } });
  streams = [];
  let settled = false;
  const done = store.refine("Shorter", "selection").then(() => void (settled = true));
  await until(() => streams.length === 1);
  await edit("selection", "First paragraph, edited by hand.\n\nSecond paragraph to refine.");
  answer(streams[0], "Old try");
  await until(() => streams.length === 2);
  await sleep(20);
  assert.equal(settled, false);
  answer(streams[1], "New try");
  await done;
  assert.match(await text("selection"), /First paragraph, edited by hand\.\n\nNew try\./);
  assert.doesNotMatch(written("selection"), /Old try/);
  assert.deepEqual(errors(), []);
});

test("a page that keeps changing is left as it is after the last try, and the refine says why", async () => {
  const run = await refinePage("cap");
  for (let i = 0; i <= MAX_REFINE_RETRIES; i++) {
    await until(() => streams.length === i + 1);
    await edit("cap", `Edit ${i}.`);
    answer(streams[i], `# cap\n\nAnswer ${i}.`);
  }
  await run.done;
  assert.equal(streams.length, MAX_REFINE_RETRIES + 1);
  assert.match(await text("cap"), new RegExp(`Edit ${MAX_REFINE_RETRIES}\\.`));
  assert.equal(written("cap"), "");
  assert.equal(errors().length, 1);
  assert.match(errors()[0], /kept changing/);
});
