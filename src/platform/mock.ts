import {
  DEFAULT_SETTINGS,
  type AiRequest,
  type Page,
  type PageMeta,
  type PingResult,
  type Platform,
  type Provider,
  type RecentSession,
  type Session,
  type Settings,
  type StreamHandle,
  type VersionInfo,
} from "./types";
import { metaFromRaw } from "../lib/frontmatter";
import { SAMPLE_FILES, SAMPLE_FOLDER } from "./sample";

/**
 * Browser-only backend. Keeps a folder in memory so the reader can be
 * developed, demoed and screenshotted without the Rust side.
 */
const files = new Map<string, { raw: string; modified: string; created: string }>();
const versions = new Map<string, { n: number; at: string; content: string }[]>();
/** One saved session per folder path, like `.reader/session.json` on disk. */
const sessions = new Map<string, Session>();
let recents: RecentSession[] = [];
let settings: Settings = { ...DEFAULT_SETTINGS, folder: SAMPLE_FOLDER };
const keys = new Map<Provider, string>();
const failedOnce = new Set<string>();
const settingsListeners = new Set<(s: Settings) => void>();

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
  files.set(path, { raw, modified: at, created: at });
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

function key(path: string) {
  return path;
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

  async pickFolder() {
    return SAMPLE_FOLDER;
  },

  async pickFile() {
    return `${SAMPLE_FOLDER}/sharp-wave-ripples.md`;
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

  async listPages(): Promise<PageMeta[]> {
    return [...files.entries()].map(([path, f]) => {
      const { meta } = metaFromRaw(path, f.raw, f.modified);
      return { ...meta, created: meta.created ?? f.created };
    });
  },

  async readPage(_folder, path): Promise<Page> {
    const f = files.get(key(path));
    if (!f) throw new Error(`No such page: ${path}`);
    const { meta, body } = metaFromRaw(path, f.raw, f.modified);
    return { ...meta, created: meta.created ?? f.created, body };
  },

  async writePage(_folder, path, content) {
    const prev = files.get(key(path));
    const now = new Date().toISOString();
    files.set(key(path), { raw: content, modified: now, created: prev?.created ?? now });
  },

  async loadSession(folder, file) {
    return sessions.get(`${folder}#${file ?? ""}`) ?? null;
  },

  async saveSession(folder, s, file) {
    sessions.set(`${folder}#${file ?? ""}`, JSON.parse(JSON.stringify(s)));
  },

  async listVersions(_folder, path): Promise<VersionInfo[]> {
    return (versions.get(path) ?? []).map(({ n, at }) => ({ n, at }));
  },

  async readVersion(_folder, path, n) {
    const v = versions.get(path)?.find((x) => x.n === n);
    if (!v) throw new Error(`No version ${n}`);
    return v.content;
  },

  async snapshotVersion(_folder, path) {
    const f = files.get(key(path));
    if (!f) throw new Error(`No such page: ${path}`);
    const list = versions.get(path) ?? [];
    const n = (list.at(-1)?.n ?? 0) + 1;
    list.push({ n, at: new Date().toISOString(), content: f.raw });
    versions.set(path, list);
    return n;
  },

  async restoreVersion(folder, path, n) {
    const content = await this.readVersion(folder, path, n);
    await this.writePage(folder, path, content);
    versions.set(path, (versions.get(path) ?? []).filter((v) => v.n < n));
  },

  async deleteVersion(_folder, path, n) {
    versions.set(path, (versions.get(path) ?? []).filter((v) => v.n !== n));
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
    setTimeout(tick, 350);
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
      return { ok: true, ms: 130, models: provider === "anthropic" ? ["haiku", "sonnet", "opus"] : ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.5"] };
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

  async openPageWindow(_folder, path) {
    window.open(`${location.pathname}?page=${encodeURIComponent(path)}`, "_blank");
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
          if (!MARKDOWN.test(f.name)) continue;
          const now = new Date().toISOString();
          files.set(f.name, { raw: await f.text(), modified: now, created: now });
          paths.push(`${SAMPLE_FOLDER}/${f.name}`);
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
};

// Module-level state cannot survive a hot update; reload instead.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
