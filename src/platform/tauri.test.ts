import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_SETTINGS, type AiRequest, type StreamEvent } from "./types";

// The bridge runs against a stand-in for what Tauri puts on `window`: every `invoke` is recorded and
// answered from `replies`, so each Platform method can be checked against the Rust command it calls.
type Call = { cmd: string; args: Record<string, unknown> };
const calls: Call[] = [];
const replies: Record<string, unknown> = {};
let nextCallback = 0;
(globalThis as Record<string, unknown>).window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      calls.push({ cmd, args });
      return cmd in replies ? replies[cmd] : null;
    },
    transformCallback: () => ++nextCallback,
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
  },
};
const { tauriPlatform: platform } = await import("./tauri");

function last(cmd: string): Call {
  const found = calls.filter((c) => c.cmd === cmd).at(-1);
  assert.ok(found, `nothing invoked ${cmd}`);
  return found;
}

type Param = { name: string; optional: boolean };

/** What lib.rs registers: each command and the arguments the webview must send, named as Tauri reads them. */
function rustCommands(): Map<string, Param[]> {
  const src = readFileSync(new URL("../../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const registered = /generate_handler!\[([^\]]*)\]/.exec(src)![1].split(",").map((s) => s.trim()).filter(Boolean);
  const commands = new Map<string, Param[]>();
  for (const name of registered) {
    const sig = new RegExp(`fn ${name}(?:<[^>]*>)?\\(([^)]*)\\)`).exec(src);
    assert.ok(sig, `no fn ${name} in lib.rs`);
    // Split on top-level commas only: `State<'_, Streams>` has one of its own.
    const params: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of sig[1]) {
      if (ch === "<") depth++;
      if (ch === ">") depth--;
      if (ch === "," && depth === 0) {
        params.push(cur);
        cur = "";
      } else cur += ch;
    }
    params.push(cur);
    commands.set(
      name,
      params
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => {
          const [pname, ...rest] = p.split(":");
          return { name: pname.trim(), type: rest.join(":").trim() };
        })
        // Tauri fills these in itself; the webview never sends them.
        .filter((p) => !/^(AppHandle|State<|tauri::WebviewWindow|WebviewWindow|Window)/.test(p.type))
        .map((p) => ({ name: p.name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), optional: p.type.startsWith("Option<") })),
    );
  }
  return commands;
}

/** Calls every Platform method that reaches Rust, with made-up arguments. */
async function callEverything() {
  const req: AiRequest = { provider: "ollama", model: "m", messages: [{ role: "user", content: "hi" }] };
  const p = platform;
  await p.pickPath("add");
  await p.pickFolder();
  await p.pathKind("/notes");
  await p.revealInFinder("/notes/a.md");
  await p.setRepresentedPath("/notes");
  await p.getRecents();
  await p.saveRecents([]);
  replies.list_pages = [];
  await p.listPages("/notes");
  replies.read_page = { path: "a.md", raw: "# A\n" };
  await p.readPage("/notes", "a.md");
  await p.writePage("/notes", "a.md", "# A\n");
  await p.writeNewPage("/notes", "b.md", "# B\n");
  await p.deletePage("/notes", "a.md");
  await p.restorePage("/notes", "a.md", "a");
  await p.loadSession("/notes", undefined);
  await p.saveSession("/notes", {} as never, "a.md");
  await p.confirm("Delete?", "It goes to the trash.", "Delete");
  await p.loadMap("/notes");
  await p.saveMap("/notes", {} as never, "");
  await p.resolveSession("/notes", undefined);
  await p.listVersions("/notes", "a.md");
  await p.readVersion("/notes", "a.md", 1);
  await p.snapshotVersion("/notes", "a.md");
  await p.restoreVersion("/notes", "a.md", 1);
  await p.deleteVersion("/notes", "a.md", 1);
  await p.getSettings();
  await p.saveSettings(DEFAULT_SETTINGS);
  await p.setApiKey("openai", "sk");
  await p.hasApiKey("openai");
  p.aiStream(req, () => undefined).cancel();
  await p.aiPing("ollama", undefined, "", "m");
  await p.openSettings();
  await p.openPageWindow("/notes", "a.md");
  await p.openedPaths();
  await p.defaultMarkdownApp();
  await p.setDefaultMarkdownApp();
  await p.sendFeedback("hi", undefined, undefined);
  await p.readDroppedImage("/shot.png");
  await p.checkForUpdate();
  await p.installUpdate(() => undefined);
  await p.relaunch();
}

test("every command the bridge invokes is registered in lib.rs and gets the arguments its signature names", async () => {
  calls.length = 0;
  await callEverything();
  const rust = rustCommands();
  const invoked = new Set<string>();
  for (const { cmd, args } of calls) {
    if (cmd.startsWith("plugin:")) continue;
    invoked.add(cmd);
    const params = rust.get(cmd);
    assert.ok(params, `${cmd} is invoked but lib.rs doesn't register it`);
    const sent = Object.keys(args).filter((k) => args[k] !== undefined);
    for (const k of sent) assert.ok(params.some((p) => p.name === k), `${cmd} is sent "${k}", which lib.rs's ${cmd} doesn't take`);
    for (const p of params) if (!p.optional) assert.ok(sent.includes(p.name), `${cmd} needs "${p.name}" and the bridge doesn't send it`);
  }
  // open_folder is only reached from the path menu (showPathMenu), which needs a native menu.
  const unused = [...rust.keys()].filter((c) => !invoked.has(c));
  assert.deepEqual(unused, ["open_folder"]);
});

test("a page read through the bridge takes its title from the front matter and keeps the body apart", async () => {
  replies.read_page = { path: "notes/replay.md", raw: "---\ntitle: Replay into cortex\nsource: why.md\n---\n\n# Replay\n\nRipples.\n", modified: "2026-11-01T10:00:00Z", created: "2026-10-01T10:00:00Z" };
  const page = await platform.readPage("/notes", "notes/replay.md");
  assert.equal(page.title, "Replay into cortex");
  assert.equal(page.source, "why.md");
  assert.equal(page.modified, "2026-11-01T10:00:00Z");
  assert.equal(page.created, "2026-10-01T10:00:00Z");
  assert.ok(!page.body.includes("title:"), page.body);
  assert.ok(page.body.includes("Ripples."));

  replies.list_pages = [{ path: "untitled.md", raw: "# Heading only\n" }];
  const [meta] = await platform.listPages("/notes");
  assert.equal(meta.title, "Heading only");
});

test("settings read before any were saved are the defaults, and saved ones are merged a level deep", async () => {
  replies.get_settings = null;
  assert.deepEqual(await platform.getSettings(), DEFAULT_SETTINGS);
  replies.get_settings = { provider: "ollama", models: { ollama: "gemma4:12b" } };
  const merged = await platform.getSettings();
  assert.equal(merged.provider, "ollama");
  assert.equal(merged.models.ollama, "gemma4:12b");
  // A model slot the saved file never had keeps its default.
  for (const [slot, model] of Object.entries(DEFAULT_SETTINGS.models)) {
    if (slot !== "ollama") assert.equal(merged.models[slot as keyof typeof merged.models], model);
  }
  replies.get_recents = null;
  assert.deepEqual(await platform.getRecents(), []);
});

test("an answer stream hands Rust a channel, passes its events on, and cancels by the same id", async () => {
  calls.length = 0;
  let finish!: (sent: boolean) => void;
  replies.ai_stream = new Promise<boolean>((resolve) => (finish = resolve));
  const got: StreamEvent[] = [];
  const req: AiRequest = { provider: "ollama", model: "m", messages: [{ role: "user", content: "hi" }] };
  const handle = platform.aiStream(req, (e) => got.push(e));
  const started = last("ai_stream");
  assert.deepEqual(started.args.req, req);
  const channel = started.args.channel as { onmessage: (e: StreamEvent) => void };
  channel.onmessage({ type: "delta", text: "Rip" });
  channel.onmessage({ type: "done", truncated: false });
  channel.onmessage({ type: "delta", text: "late" });
  finish(true);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(got, [{ type: "delta", text: "Rip" }, { type: "done", truncated: false }]);

  handle.cancel();
  assert.deepEqual(last("ai_cancel").args, { id: started.args.id });
});

test("feedback sends a trimmed email or null, and no attachment as null", async () => {
  await platform.sendFeedback("It crashed.", "  me@example.com ", undefined);
  assert.deepEqual(last("send_feedback").args, { message: "It crashed.", email: "me@example.com", attachment: null });
  await platform.sendFeedback("It crashed.", "   ", undefined);
  assert.equal(last("send_feedback").args.email, null);
});

test("optional arguments go as null, which Rust reads as none", async () => {
  await platform.resolveSession("/notes", undefined);
  assert.deepEqual(last("resolve_session").args, { folder: "/notes", file: null, ids: null, bookmark: null });
  await platform.openPageWindow("/notes", "a.md");
  assert.deepEqual(last("open_page_window").args, { folder: "/notes", path: "a.md", version: null });
  await platform.pickPath(undefined);
  assert.deepEqual(last("pick_path").args, { purpose: "open" });
});
