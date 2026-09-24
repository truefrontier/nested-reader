import { version as APP_VERSION } from "../../package.json";
import {
  ATTACHMENT_MAX_BYTES,
  DEFAULT_SETTINGS,
  type AiRequest,
  type Page,
  type PageMeta,
  type PingResult,
  type Platform,
  type Provider,
  type RecentSession,
  type ResolvedSession,
  type Session,
  type Settings,
  type StreamEvent,
  type StreamHandle,
  type VersionInfo,
} from "./types";
import { metaFromRaw } from "../lib/frontmatter";
import { EXTRA_FILES, EXTRA_FOLDER, SAMPLE_FILES, SAMPLE_FOLDER } from "./sample";

/**
 * Browser-only backend. Keeps two folders in memory (keyed `<folder>/<page>`) so the reader can be
 * developed, demoed and screenshotted without the Rust side.
 */
const files = new Map<string, { raw: string; modified: string; created: string }>();
const versions = new Map<string, { n: number; at: string; content: string }[]>();
/** One saved session per folder path, like `.reader/session.json` on disk. */
const sessions = new Map<string, Session>();
const maps = new Map<string, Record<string, { about: string; for: string }>>();
let recents: RecentSession[] = [];
let settings: Settings = { ...DEFAULT_SETTINGS, folder: SAMPLE_FOLDER };
/** The browser has no Finder; a pretend default app lets the Settings row and the Home offer be tried. */
let markdownApp = "TextEdit";
const keys = new Map<Provider, string>();
const failedOnce = new Set<string>();
const settingsListeners = new Set<(s: Settings) => void>();
/** Screenshots dropped on the window, held by the fake path handed back through `onDragDrop` until `readDroppedImage` claims them. */
const droppedImages = new Map<string, File>();
const DROPPED_IMAGE_PREFIX = "__attachment__/";

async function base64OfFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

const t0 = Date.now();
const stamps: Record<string, number> = {
  "why-the-brain-replays-the-day.md": t0 - 2 * 86_400_000 - 3 * 3_600_000,
  "replay-into-cortex.md": t0 - 90 * 60_000,
  "does-replay-run-the-other-way.md": t0 - 79 * 60_000,
  "slow-oscillations.md": t0 - 76 * 60_000,
  "sharp-wave-ripples.md": t0 - 40_000,
  "same-order.md": t0 - 5_000,
};
for (const [path, raw] of Object.entries(SAMPLE_FILES)) {
  const at = new Date(stamps[path] ?? t0).toISOString();
  files.set(`${SAMPLE_FOLDER}/${path}`, { raw, modified: at, created: at });
}
for (const [path, raw] of Object.entries(EXTRA_FILES)) {
  const at = new Date(t0 - 86_400_000).toISOString();
  files.set(`${EXTRA_FOLDER}/${path}`, { raw, modified: at, created: at });
}
/** `?longtree` pads the sample folder so the sidebar scrolls, to try a row at the foot of the list. */
if (typeof location !== "undefined" && new URL(location.href).searchParams.has("longtree")) {
  for (let i = 1; i <= 24; i++) {
    const n = String(i).padStart(2, "0");
    const path = `more/note-${n}.md`;
    const title = `Note ${n}`;
    const at = new Date(t0 - i * 45_000).toISOString();
    files.set(`${SAMPLE_FOLDER}/${path}`, { raw: `---\ntitle: ${title}\n---\n\n# ${title}\n\n`, modified: at, created: at });
  }
}

try {
  const stored = localStorage.getItem("ml:settings");
  if (stored) settings = { ...settings, ...JSON.parse(stored) };
  const storedRecents = localStorage.getItem("ml:recents");
  if (storedRecents) recents = JSON.parse(storedRecents);
} catch {
  /* private mode or no storage: keep defaults */
}

const MARKDOWN = /\.(md|markdown)$/i;

function key(folder: string, path: string) {
  return `${folder}/${path}`;
}

function fakeAnswer(req: AiRequest): string {
  const last = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const q = /(?:Question|New page):\s*(.+)/.exec(last)?.[1]?.trim() ?? "";
  if (req.system?.includes("wiki-style page") || req.system?.includes("adding a new page")) {
    const title = q.replace(/\?+$/, "") || "A closer look";
    return `# ${title}\n\nBecause the ripple is the only window in which the hippocampal sequence is broadcast to cortex. Cut it short and the cortex receives a fragment, not enough to strengthen the distributed trace that later recall depends on.\n\nThe effect is specific: disrupting ripples that occur outside the post-learning window does nothing, and jittering the pulse by a few hundred milliseconds so it misses the ripple also does nothing.\n\nWhat survives is the general shape of the day rather than its particulars. Each replay strengthens the cortical version a little, and after enough nights the memory no longer needs the hippocampus at all.\n`;
  }
  if (req.system?.includes("Rewrite") || req.system?.includes("editing a markdown page")) {
    const m = /Text to rewrite:\n([\s\S]*)$/.exec(last);
    const text = (m?.[1] ?? last).trim();
    const rules: [RegExp, string][] = [
      [/impairs memory for the route learned that day/, "erases the day's route from memory (Girardeau et al., 2009)"],
      [/compressed roughly twenty-fold/, "sped up about twenty times"],
      [/It is the container in which replay happens/, "It is where replay happens"],
      [/roughly twenty-fold/, "about twenty times faster"],
      [/quiet wakefulness/, "quiet rest"],
    ];
    let out = text;
    let hits = 0;
    for (const [re, rep] of rules) {
      if (re.test(out)) {
        out = out.replace(re, rep);
        hits++;
        if (hits >= 2) break;
      }
    }
    // Prefix the first body word, skipping a leading heading line.
    if (hits === 0) out = out.replace(/^((?:#[^\n]*\n+)?)(\S+)/, "$1In plain terms, $2");
    return out;
  }
  return "Selective disruption means firing a short electrical pulse the moment a ripple is detected, aborting it. Animals stay asleep, sleep architecture is unchanged, yet next-day recall of the route drops to near the level of rats that never slept.";
}

export const mockPlatform: Platform = {
  isTauri: false,

  /** The browser has no Open panel, so ⌘O opens the sample folder and ⌘⇧O adds the second one. */
  async pickPath(purpose) {
    return purpose === "add" ? [EXTRA_FOLDER] : [SAMPLE_FOLDER];
  },

  async pickFolder() {
    return SAMPLE_FOLDER;
  },

  async pathKind(path) {
    return MARKDOWN.test(path) ? "file" : "folder";
  },

  async revealInFinder() {
    throw new Error("Reveal in Finder works in the desktop app.");
  },

  async getRecents() {
    return recents;
  },

  async saveRecents(list) {
    recents = list;
    try {
      localStorage.setItem("ml:recents", JSON.stringify(list));
    } catch {
      /* ignore */
    }
  },

  async listPages(folder): Promise<PageMeta[]> {
    const prefix = `${folder}/`;
    return [...files.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, f]) => {
        const path = k.slice(prefix.length);
        const { meta } = metaFromRaw(path, f.raw, f.modified);
        return { ...meta, created: meta.created ?? f.created };
      });
  },

  async readPage(folder, path): Promise<Page> {
    const f = files.get(key(folder, path));
    if (!f) throw new Error(`No such page: ${path}`);
    const { meta, body } = metaFromRaw(path, f.raw, f.modified);
    return { ...meta, created: meta.created ?? f.created, body };
  },

  async writePage(folder, path, content) {
    const prev = files.get(key(folder, path));
    const now = new Date().toISOString();
    files.set(key(folder, path), { raw: content, modified: now, created: prev?.created ?? now });
  },

  /** The in-memory backend has no trash to park a page in, so it simply forgets it. */
  async deletePage(folder, path) {
    if (!files.delete(key(folder, path))) throw new Error(`No such page: ${path}`);
    versions.delete(key(folder, path));
  },

  async loadSession(folder, file) {
    return sessions.get(`${folder}#${file ?? ""}`) ?? null;
  },

  async confirm(message, detail) {
    return window.confirm(detail ? `${message}\n\n${detail}` : message);
  },

  async loadMap(folder) {
    return maps.get(folder) ?? null;
  },

  async saveMap(folder, cache) {
    maps.set(folder, cache);
  },

  async saveSession(folder, s, file) {
    const ids: Record<string, string> = {};
    const prefix = `${folder}/`;
    for (const k of files.keys()) {
      if (!k.startsWith(prefix) || !MARKDOWN.test(k)) continue;
      ids[k.slice(prefix.length)] = `mock:${k}`;
    }
    sessions.set(`${folder}#${file ?? ""}`, JSON.parse(JSON.stringify({ ...s, ids })));
  },

  async resolveSession(folder, file): Promise<ResolvedSession> {
    return {
      folder,
      file,
      remaps: [],
      folderId: `mock:${folder}`,
      fileId: file ? `mock:${folder}/${file}` : undefined,
    };
  },

  async listVersions(folder, path): Promise<VersionInfo[]> {
    return (versions.get(key(folder, path)) ?? []).map(({ n, at }) => ({ n, at }));
  },

  async readVersion(folder, path, n) {
    const v = versions.get(key(folder, path))?.find((x) => x.n === n);
    if (!v) throw new Error(`No version ${n}`);
    return v.content;
  },

  async snapshotVersion(folder, path) {
    const f = files.get(key(folder, path));
    if (!f) throw new Error(`No such page: ${path}`);
    const list = versions.get(key(folder, path)) ?? [];
    const n = (list.at(-1)?.n ?? 0) + 1;
    list.push({ n, at: new Date().toISOString(), content: f.raw });
    versions.set(key(folder, path), list);
    return n;
  },

  async restoreVersion(folder, path, n) {
    const content = await this.readVersion(folder, path, n);
    await this.writePage(folder, path, content);
    versions.set(key(folder, path), (versions.get(key(folder, path)) ?? []).filter((v) => v.n < n));
  },

  async deleteVersion(folder, path, n) {
    versions.set(key(folder, path), (versions.get(key(folder, path)) ?? []).filter((v) => v.n !== n));
  },

  async getSettings() {
    return settings;
  },

  async saveSettings(s) {
    settings = { ...s };
    try {
      localStorage.setItem("ml:settings", JSON.stringify(settings));
    } catch {
      /* ignore */
    }
    for (const l of settingsListeners) l(settings);
  },

  async setApiKey(provider, k) {
    if (k) keys.set(provider, k);
    else keys.delete(provider);
  },

  async hasApiKey(provider) {
    return keys.has(provider);
  },

  aiStream(req, onEvent): StreamHandle {
    // Dev hooks: "__fail__" in the request fails the first attempt (so retries can succeed); "__fail_always__" always fails.
    const last = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const always = last.includes("__fail_always__");
    if (always || (last.includes("__fail__") && !failedOnce.has(last))) {
      failedOnce.add(last);
      const t = setTimeout(() => onEvent({ type: "error", message: "Simulated provider error: 429 rate limited" }), 400);
      return { cancel: () => clearTimeout(t) };
    }
    const text = fakeAnswer(req);
    const words = text.split(/(?<=\s)/);
    let i = 0;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      if (i >= words.length) {
        onEvent({ type: "done" });
        return;
      }
      onEvent({ type: "delta", text: words[i++] });
      setTimeout(tick, 22 + Math.random() * 40);
    };
    // With tools on, the model looks at the folder first: two tool events, then the answer.
    const tools: StreamEvent[] = req.folder
      ? [
          { type: "tool", name: "search_pages", detail: "Searching for “ripple”" },
          { type: "tool", name: "read_page", detail: "Reading sharp-wave-ripples.md" },
        ]
      : [];
    let at = 350;
    for (const t of tools) {
      setTimeout(() => !cancelled && onEvent(t), at);
      at += 700;
    }
    setTimeout(tick, at);
    return {
      cancel() {
        cancelled = true;
      },
    };
  },

  async aiPing(provider, auth): Promise<PingResult> {
    await new Promise((r) => setTimeout(r, 400));
    if (provider === "builtin") return { ok: false, error: "Built-in plan is not available in this build" };
    if (provider === "ollama") return { ok: true, ms: 9, models: ["gemma3:4b", "qwen3.5:4b", "gemma4:12b", "gpt-oss:20b-cloud"] };
    if (auth === "subscription") {
      return { ok: true, ms: 130, models: provider === "anthropic" ? ["haiku", "sonnet", "opus", "fable"] : ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.5"] };
    }
    if (!keys.has(provider)) return { ok: false, error: "No API key" };
    const lists: Record<string, string[]> = {
      openai: ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.5-2026-06-01", "gpt-4o-mini-tts", "o3", "text-embedding-3-small"],
      anthropic: ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
      custom: ["llama-3.3-70b", "mixtral-8x7b"],
    };
    return { ok: true, ms: 410, models: lists[provider] ?? [] };
  },

  async openSettings() {
    window.dispatchEvent(new CustomEvent("ml:open-settings"));
  },

  async openPageWindow(_folder, path, version) {
    const v = version === undefined ? "" : `&version=${version}`;
    window.open(`${location.pathname}?page=${encodeURIComponent(path)}${v}`, "_blank");
  },

  onCommand(handler) {
    const fn = (e: Event) => handler((e as CustomEvent<string>).detail);
    window.addEventListener("ml:command", fn);
    return () => window.removeEventListener("ml:command", fn);
  },

  onSettingsChanged(handler) {
    settingsListeners.add(handler);
    return () => settingsListeners.delete(handler);
  },

  async openedPaths() {
    return [];
  },

  onOpened() {
    return () => undefined;
  },

  async defaultMarkdownApp() {
    return { app: markdownApp, isNested: markdownApp === "Nested", available: true };
  },

  async setDefaultMarkdownApp() {
    markdownApp = "Nested";
    return { app: markdownApp, isNested: true, available: true };
  },

  /** No relay in the browser: the note is logged. A note starting with "fail:" is refused, to try the error state. */
  async sendFeedback(message, email, attachment) {
    await new Promise((r) => setTimeout(r, 500));
    if (/^fail:/i.test(message.trim())) throw new Error("The feedback server refused the note (502).");
    console.info("[feedback]", { message, email, attachment: attachment && { name: attachment.name, mime: attachment.mime, bytes: attachment.data.length } });
  },

  /** No release server in the browser. `?update` in the URL pretends one is out; `?update=fail` makes the install fail part way. */
  async checkForUpdate() {
    await new Promise((r) => setTimeout(r, 600));
    const sim = new URL(location.href).searchParams.get("update");
    return {
      current: APP_VERSION,
      supported: true,
      update: sim === null ? undefined : { version: "0.9.0", notes: "A pretend release, to try the update bar." },
    };
  },

  async installUpdate(onProgress) {
    const sim = new URL(location.href).searchParams.get("update");
    const total = 24_000_000;
    for (let i = 1; i <= 10; i++) {
      await new Promise((r) => setTimeout(r, 180));
      if (sim === "fail" && i === 4) throw new Error("Couldn't download the update: the connection dropped.");
      onProgress({ type: "progress", downloaded: Math.round((total * i) / 10), total });
    }
    await new Promise((r) => setTimeout(r, 400));
    onProgress({ type: "installed" });
  },

  /** The browser build cannot swap itself; a reload stands in for the relaunch, after the beat the real install takes. */
  async relaunch() {
    await new Promise((r) => setTimeout(r, 900));
    const url = new URL(location.href);
    url.searchParams.delete("update");
    location.assign(url.toString());
  },

  /** A dropped .md file is read into the in-memory folder; browsers give no path for folders. */
  onDragDrop(handler) {
    const over = (e: DragEvent) => {
      e.preventDefault();
      handler({ type: "over", paths: [] });
    };
    const leave = (e: DragEvent) => {
      if (!e.relatedTarget) handler({ type: "leave", paths: [] });
    };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      void (async () => {
        const paths: string[] = [];
        for (const f of Array.from(e.dataTransfer?.files ?? [])) {
          if (MARKDOWN.test(f.name)) {
            const now = new Date().toISOString();
            files.set(f.name, { raw: await f.text(), modified: now, created: now });
            paths.push(`${SAMPLE_FOLDER}/${f.name}`);
          } else if (f.type.startsWith("image/")) {
            // Kept by a fake path, like the paths a native drop hands the real backend, so `readDroppedImage`
            // can stand in for it without the browser exposing a real filesystem path.
            const path = `${DROPPED_IMAGE_PREFIX}${Date.now()}-${f.name}`;
            droppedImages.set(path, f);
            paths.push(path);
          }
        }
        handler({ type: "drop", paths });
      })();
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  },

  async readDroppedImage(path) {
    const file = droppedImages.get(path);
    droppedImages.delete(path);
    if (!file) throw new Error("Couldn't read that file.");
    if (!file.type.startsWith("image/")) throw new Error("Drop a screenshot (PNG, JPEG, GIF or WebP).");
    if (file.size > ATTACHMENT_MAX_BYTES) throw new Error("Keep the screenshot under 5 MB.");
    return { name: file.name, mime: file.type, data: await base64OfFile(file) };
  },
};

// Module-level state cannot survive a hot update; reload instead.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
