import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  DEFAULT_SETTINGS,
  type AiRequest,
  type Auth,
  type DefaultApp,
  type Page,
  type PageMeta,
  type PathKind,
  type PingResult,
  type Platform,
  type Provider,
  type RecentSession,
  type ResolvedSession,
  type Session,
  type Settings,
  type StreamEvent,
  type StreamHandle,
  type UpdateCheck,
  type UpdateProgress,
  type VersionInfo,
} from "./types";

type RawPage = { path: string; raw: string; modified?: string; created?: string };

import { metaFromRaw } from "../lib/frontmatter";

function toMeta(p: RawPage): PageMeta {
  const { meta } = metaFromRaw(p.path, p.raw, p.modified);
  return { ...meta, created: meta.created ?? p.created };
}

export const tauriPlatform: Platform = {
  isTauri: true,

  pickPath: (purpose) => invoke<string | null>("pick_path", { purpose: purpose ?? "open" }),
  pickFolder: () => invoke<string | null>("pick_folder"),
  pathKind: (path) => invoke<PathKind>("path_kind", { path }),
  revealInFinder: (path) => invoke("reveal_in_finder", { path }),

  async getRecents() {
    return (await invoke<RecentSession[] | null>("get_recents")) ?? [];
  },
  saveRecents: (recents) => invoke("save_recents", { recents }),

  async listPages(folder) {
    const pages = await invoke<RawPage[]>("list_pages", { folder });
    return pages.map(toMeta);
  },

  async readPage(folder, path): Promise<Page> {
    const p = await invoke<RawPage>("read_page", { folder, path });
    const { meta, body } = metaFromRaw(p.path, p.raw, p.modified);
    return { ...meta, created: meta.created ?? p.created, body };
  },

  writePage: (folder, path, content) => invoke("write_page", { folder, path, content }),
  deletePage: (folder, path) => invoke("delete_page", { folder, path }),

  loadSession: (folder, file) => invoke<Session | null>("load_session", { folder, file }),
  saveSession: (folder, session, file) => invoke("save_session", { folder, session, file }),
  resolveSession: (folder, file, ids, bookmark) =>
    invoke<ResolvedSession>("resolve_session", { folder, file: file ?? null, ids: ids ?? null, bookmark: bookmark ?? null }),

  listVersions: (folder, path) => invoke<VersionInfo[]>("list_versions", { folder, path }),
  readVersion: (folder, path, n) => invoke<string>("read_version", { folder, path, n }),
  snapshotVersion: (folder, path) => invoke<number>("snapshot_version", { folder, path }),
  restoreVersion: (folder, path, n) => invoke("restore_version", { folder, path, n }),
  deleteVersion: (folder, path, n) => invoke("delete_version", { folder, path, n }),

  async getSettings() {
    const stored = await invoke<Partial<Settings> | null>("get_settings");
    return {
      ...DEFAULT_SETTINGS,
      ...(stored ?? {}),
      auth: { ...DEFAULT_SETTINGS.auth, ...(stored?.auth ?? {}) },
      models: { ...DEFAULT_SETTINGS.models, ...(stored?.models ?? {}) },
      context: { ...DEFAULT_SETTINGS.context, ...(stored?.context ?? {}) },
      readingWidth: { ...DEFAULT_SETTINGS.readingWidth, ...(stored?.readingWidth ?? {}) },
    };
  },
  saveSettings: (settings) => invoke("save_settings", { settings }),

  setApiKey: (provider, key) => invoke("set_api_key", { provider, key }),
  hasApiKey: (provider) => invoke<boolean>("has_api_key", { provider }),

  aiStream(req: AiRequest, onEvent): StreamHandle {
    const channel = new Channel<StreamEvent>();
    let finished = false;
    channel.onmessage = (e) => {
      if (finished) return;
      if (e.type !== "delta") finished = true;
      onEvent(e);
    };
    const id = crypto.randomUUID();
    invoke("ai_stream", { id, req, channel }).catch((err: unknown) => {
      if (!finished) {
        finished = true;
        onEvent({ type: "error", message: String(err) });
      }
    });
    return {
      cancel() {
        finished = true;
        invoke("ai_cancel", { id }).catch(() => undefined);
      },
    };
  },

  aiPing: (provider: Provider, auth: Auth | undefined, baseUrl: string, model: string) =>
    invoke<PingResult>("ai_ping", { provider, auth, baseUrl, model }),

  openSettings: () => invoke("open_settings"),
  openPageWindow: (folder, path, version) => invoke("open_page_window", { folder, path, version: version ?? null }),

  onCommand(handler) {
    const un = listen<string>("command", (e) => handler(e.payload));
    return () => {
      un.then((f) => f());
    };
  },

  onSettingsChanged(handler) {
    const un = listen<Settings>("settings-changed", (e) => handler(e.payload));
    return () => {
      un.then((f) => f());
    };
  },

  onDragDrop(handler) {
    const un = getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      handler({ type: p.type, paths: p.type === "enter" || p.type === "drop" ? p.paths : [] });
    });
    return () => {
      un.then((f) => f());
    };
  },

  openedPaths: () => invoke<string[]>("opened_paths"),

  /** lib.rs sends "opened" to the main window only, so the listener is tied to this window rather than to any target. */
  onOpened(handler) {
    const un = getCurrentWebviewWindow().listen<string[]>("opened", (e) => handler(e.payload));
    return () => {
      un.then((f) => f());
    };
  },

  defaultMarkdownApp: () => invoke<DefaultApp>("default_markdown_app"),
  setDefaultMarkdownApp: () => invoke<DefaultApp>("set_default_markdown_app"),

  sendFeedback: (message, email) => invoke("send_feedback", { message, email: email?.trim() || null }),

  checkForUpdate: () => invoke<UpdateCheck>("check_for_update"),

  installUpdate(onProgress) {
    const channel = new Channel<UpdateProgress>();
    channel.onmessage = onProgress;
    return invoke("install_update", { channel });
  },

  relaunch: () => invoke("relaunch"),
};
