import { test } from "node:test";
import assert from "node:assert/strict";
import type { StreamEvent } from "../platform/types";

// The store runs against the browser mock's in-memory folders, and reaches its timers through `window`.
(globalThis as { window?: unknown }).window = globalThis;
// The mock tries localStorage for its settings and copes without it; Node's own only warns.
Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true });
const { store } = await import("./store");
const { platform, DEFAULT_SETTINGS } = await import("../platform");
const { trackStream } = await import("../platform/stream");

const A = "/test/a";
const B = "/test/b";
const page = (title: string, text: string) => `---\ntitle: ${title}\n---\n\n# ${title}\n\n${text}\n`;
await platform.writePage(A, "notes.md", page("Notes", "Folder A's notes."));
await platform.writePage(B, "notes.md", page("Notes", "Folder B's notes."));
await platform.writePage(B, "ripples.md", page("Ripples", "Folder B's own page on ripples."));

/** Every page write, as the folder it went to and the path inside it. */
const writes: string[] = [];
const writePage = platform.writePage;
platform.writePage = function (folder, path, content) {
  writes.push(`${folder}/${path}`);
  return writePage.call(this, folder, path, content);
};

/** The answer streams the store starts, which the test drives by hand. A cancelled one passes nothing on. */
type Backend = { send: (e: StreamEvent) => void; cancelled: boolean };
let streams: Backend[] = [];
platform.aiStream = (_req, onEvent) =>
  trackStream(onEvent, (send) => {
    const s: Backend = { send, cancelled: false };
    streams.push(s);
    return { ended: new Promise<boolean>(() => {}), cancel: () => void (s.cancelled = true) };
  });

store.state.settings = { ...DEFAULT_SETTINGS, models: { ...DEFAULT_SETTINGS.models, anthropic: "test-model" }, context: { ...DEFAULT_SETTINGS.context, map: false } };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean) {
  for (let i = 0; i < 400 && !ok(); i++) await sleep(5);
  assert.ok(ok(), "timed out");
}
const text = async (folder: string, path: string) => (await platform.readPage(folder, path)).body;

async function openA() {
  await store.openFolder(A);
  await store.navigate("notes.md");
  streams = [];
}

test("a refine running when another folder opens is stopped, and writes nothing into it", async () => {
  await openA();
  const refining = store.refine("Make it shorter", "page");
  await until(() => streams.length === 1);
  writes.length = 0;
  await store.openFolder(B);
  // What a backend still sends after the switch, as one that missed the cancel would.
  streams[0].send({ type: "delta", text: "Shorter." });
  streams[0].send({ type: "done" });
  await refining;
  await sleep(50);
  assert.deepEqual(writes, []);
  assert.match(await text(B, "notes.md"), /Folder B's notes/);
  assert.equal(streams[0].cancelled, true);
});

test("a page being written when another folder opens keeps its last text in the old folder, not the new one", async () => {
  await openA();
  void store.createPage({ question: "Ripples", mode: "new-page", placement: "background" });
  await until(() => streams.length === 1);
  // A delta queues the page's write on a timer, and the folder changes before it fires.
  streams[0].send({ type: "delta", text: "Ripples replay the day." });
  writes.length = 0;
  await store.openFolder(B);
  await sleep(700);
  assert.deepEqual(writes, [`${A}/ripples.md`]);
  assert.match(await text(A, "ripples.md"), /Ripples replay the day\./);
  assert.match(await text(B, "ripples.md"), /Folder B's own page on ripples/);
  assert.equal(streams[0].cancelled, true);
});

test("a refine queued behind a stopped one does not start in the new folder", async () => {
  await openA();
  void store.refine("Make it shorter", "page");
  void store.refine("Now make it longer", "page");
  await until(() => streams.length === 1);
  await store.openFolder(B);
  await sleep(50);
  assert.equal(streams.length, 1);
});

test("reopening the same folder leaves its streams running", async () => {
  await openA();
  const refining = store.refine("Make it shorter", "page");
  await until(() => streams.length === 1);
  await store.reload();
  assert.equal(streams[0].cancelled, false);
  streams[0].send({ type: "delta", text: "# Notes\n\nShorter." });
  streams[0].send({ type: "done" });
  await refining;
  assert.match(await text(A, "notes.md"), /Shorter\./);
});

test("an open that a later open replaces stops nothing", async () => {
  await openA();
  const refining = store.refine("Make it shorter", "page");
  await until(() => streams.length === 1);
  // B's open is overtaken by A's before it lands, so the folder never changes.
  await Promise.all([store.openFolder(B), store.openFolder(A)]);
  assert.equal(store.state.folder, A);
  assert.equal(streams[0].cancelled, false);
  streams[0].send({ type: "delta", text: "# Notes\n\nShorter still." });
  streams[0].send({ type: "done" });
  await refining;
  assert.match(await text(A, "notes.md"), /Shorter still\./);
});

test("a file the listing left out opens with the reason it couldn't be read", async () => {
  await openA();
  // The desktop listing leaves out a file it can't read, and read_page says why.
  await platform.writePage(A, "scan.pdf", "");
  const { listPages, readPage } = platform;
  const why = "PDF file 'scan.pdf' contains no extractable text (possibly a scanned document)";
  platform.listPages = async (folder) => (await listPages.call(platform, folder)).filter((p) => p.path !== "scan.pdf");
  platform.readPage = async (folder, path) => (path === "scan.pdf" ? Promise.reject(why) : readPage.call(platform, folder, path));
  try {
    await store.openFolder(A, { file: "scan.pdf" });
    assert.equal(store.state.ui.error, why);
    await store.openFolder(A, { file: "gone.md" });
    assert.equal(store.state.ui.error, "No such page: gone.md");
  } finally {
    platform.listPages = listPages;
    platform.readPage = readPage;
  }
});

test("the reason for a file left out of the listing doesn't land on a session opened since", async () => {
  await openA();
  await platform.writePage(A, "scan.pdf", "");
  const { listPages, readPage } = platform;
  let refuse: ((why: string) => void) | undefined;
  platform.listPages = async (folder) => (await listPages.call(platform, folder)).filter((p) => p.path !== "scan.pdf");
  // The reason is slow to come, as re-reading a big PDF is; another folder opens meanwhile.
  platform.readPage = (folder, path) => (path === "scan.pdf" ? new Promise((_, reject) => (refuse = reject)) : readPage.call(platform, folder, path));
  try {
    store.setUi({ error: undefined });
    const opening = store.openFolder(A, { file: "scan.pdf" });
    await until(() => refuse !== undefined);
    await store.openFolder(B);
    refuse!("PDF file 'scan.pdf' contains no extractable text (possibly a scanned document)");
    await opening;
    assert.equal(store.state.folder, B);
    assert.equal(store.state.ui.error, undefined);
  } finally {
    platform.listPages = listPages;
    platform.readPage = readPage;
  }
});
