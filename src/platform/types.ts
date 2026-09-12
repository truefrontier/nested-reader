// Shared types between the reader UI, the settings window, and both backends.

export type PageMode = "new-page" | "deep-dive";

export type PageMeta = {
  /** Path relative to the session folder, e.g. "sharp-wave-ripples.md". */
  path: string;
  title: string;
  /** Parent page path (relative), when this page was grown from another. */
  source?: string;
  question?: string;
  /** ISO timestamp from front matter, falling back to file birth time. */
  created?: string;
  /** ISO timestamp of the last write. */
  modified?: string;
  mode?: PageMode;
};

export type Page = PageMeta & { body: string };

export type VersionInfo = { n: number; at: string };

export type SplitDirection = "beside" | "below";

export type Session = {
  current?: string;
  /** path -> ISO time it was last opened */
  read: Record<string, string>;
  /** pages generated in the background that have not been opened yet */
  unread: string[];
  /** pages still being written by the model */
  loading: string[];
  /** path -> version number the current text is being reviewed against */
  pending: Record<string, number>;
  /** navigation history, oldest first */
  trail: string[];
  trailIndex: number;
  sidebar: boolean;
  /** Folders (paths relative to the session folder) shown closed in the sidebar. */
  collapsed?: string[];
  split?: string;
  splitDirection: SplitDirection;
  /** Display name chosen with Rename on the Home screen; the folder name otherwise. */
  name?: string;
  /** Answered quick asks, by page path, kept so the answer can be read again from the text it was asked about. */
  asks?: Record<string, Ask[]>;
  /** Folders and files added to the session with ⌘⇧O, beyond the folder it was opened from. */
  roots?: SessionRoot[];
};

/**
 * Another root of the session: a folder, or with `file` one page (and the pages grown from it) in that
 * folder. Its pages are keyed by their absolute path, `<folder>/<page>`, so they never collide with the
 * session folder's own relative paths; `.reader` state for them lives in this folder.
 */
export type SessionRoot = { folder: string; file?: string };

/** A quick ask whose answer has come back: the text it was asked about, where that text sat, and the exchange. */
export type Ask = {
  block: number;
  start: number;
  end: number;
  text: string;
  thread: { question: string; answer: string }[];
  question: string;
  answer: string;
};

/** A session the Home screen can reopen. */
export type RecentSession = {
  folder: string;
  /** Page path relative to the folder when the session is a single .md and the pages grown from it. */
  file?: string;
  name: string;
  /** ISO time it was last opened. */
  openedAt: string;
  /** Background pages not yet read, as of the last save. */
  unread: number;
};

export type PathKind = "folder" | "file" | "other";
/** What the Open panel is for: a new session (⌘O) or a root added to the open one (⌘⇧O). */
export type PickPurpose = "open" | "add";

/** Something dragged over or dropped on the window. `paths` is set for "enter" and "drop". */
export type DragDropEvent = { type: "enter" | "over" | "drop" | "leave"; paths: string[] };

export type Provider = "builtin" | "openai" | "anthropic" | "ollama" | "custom";
/** How OpenAI and Anthropic are reached: an API key, or the plan signed in to their official CLI. */
export type Auth = "key" | "subscription";
/** Each way of reaching a provider remembers its own model. */
export type ModelSlot = Provider | "openai-subscription" | "anthropic-subscription";
export type Placement = "beside" | "below" | "active" | "background" | "window";
export type OpenAtLaunch = "last-session" | "ask" | "nothing";
/** How the reading column's width is measured: in ems of the reading text, or as a share of the pane. */
export type ReadingWidthUnit = "em" | "percent";
export type ReadingWidth = { unit: ReadingWidthUnit; em: number; percent: number };

export type Settings = {
  folder?: string;
  /** "" means new pages are saved next to their source. */
  newPagesSubfolder: string;
  openAtLaunch: OpenAtLaunch;
  theme: "system" | "light" | "dark";
  textSize: number;
  readingFont: "serif" | "sans";
  /** Both values are kept, so switching the unit brings back the last choice made in it. */
  readingWidth: ReadingWidth;
  /** Width of the sidebar in px, set by dragging its edge. */
  sidebarWidth: number;
  newPageOpens: Placement;
  deepDiveOpens: Placement;
  provider: Provider;
  /** Base URL for the Custom (OpenAI-compatible) provider. */
  baseUrl: string;
  /** Where the local Ollama server listens. */
  ollamaUrl: string;
  auth: { openai: Auth; anthropic: Auth };
  /** Chosen model per slot; "" means "not chosen yet", and Settings picks the cheapest on first contact. */
  models: Record<ModelSlot, string>;
  context: { highlight: boolean; session: boolean; folder: boolean };
  /** Let the model list, read and search the session folder's pages itself while it answers. */
  tools: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  newPagesSubfolder: "",
  openAtLaunch: "last-session",
  theme: "system",
  textSize: 17,
  readingFont: "serif",
  readingWidth: { unit: "em", em: 33, percent: 70 },
  sidebarWidth: 224,
  newPageOpens: "beside",
  deepDiveOpens: "background",
  provider: "anthropic",
  baseUrl: "",
  ollamaUrl: "http://localhost:11434",
  auth: { openai: "key", anthropic: "key" },
  models: {
    builtin: "",
    openai: "",
    anthropic: "",
    ollama: "",
    custom: "",
    "openai-subscription": "",
    "anthropic-subscription": "",
  },
  context: { highlight: true, session: true, folder: false },
  tools: true,
};

export const READING_WIDTH_RANGE: Record<ReadingWidthUnit, { min: number; max: number }> = {
  em: { min: 20, max: 60 },
  percent: { min: 30, max: 100 },
};

/** The CSS length behind `--reading-width`; a value outside its range (a hand-edited settings file) is clamped. */
export const SIDEBAR_WIDTH_RANGE = { min: 180, max: 480 };

/** The sidebar width to apply: the setting clamped to its range, or the default when it is not a number. */
export function sidebarWidthPx(w: unknown): number {
  const n = typeof w === "number" && Number.isFinite(w) ? w : DEFAULT_SETTINGS.sidebarWidth;
  return Math.round(Math.min(SIDEBAR_WIDTH_RANGE.max, Math.max(SIDEBAR_WIDTH_RANGE.min, n)));
}

export function readingWidthCss(w: ReadingWidth): string {
  const unit = w.unit === "percent" ? "percent" : "em";
  const range = READING_WIDTH_RANGE[unit];
  const raw = Number(w[unit]);
  const n = Number.isFinite(raw) ? Math.min(range.max, Math.max(range.min, raw)) : DEFAULT_SETTINGS.readingWidth[unit];
  return unit === "percent" ? `${n}%` : `${n}em`;
}

export function emptySession(): Session {
  return {
    read: {},
    unread: [],
    loading: [],
    pending: {},
    trail: [],
    trailIndex: -1,
    sidebar: true,
    splitDirection: "beside",
  };
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type AiRequest = {
  provider: Provider;
  auth?: Auth;
  model: string;
  baseUrl?: string;
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** The session folder the model may read with its tools; without it no tools are offered. */
  folder?: string;
  /** The folders of the session's other roots, which the tools may read too. */
  roots?: string[];
};

/** A tool the model is using, reported so the UI can say what it is looking at. */
export type ToolEvent = { type: "tool"; name: string; detail: string };

export type StreamEvent =
  | { type: "delta"; text: string }
  | ToolEvent
  | { type: "done" }
  | { type: "error"; message: string };

/** `models` lists what the provider offers (installed models for Ollama, cheapest first). */
export type PingResult = { ok: true; ms: number; models?: string[] } | { ok: false; error: string; models?: string[] };

export type StreamHandle = { cancel(): void };

export interface Platform {
  isTauri: boolean;
  /** Shows the Open panel; resolves to the chosen folder or Markdown file, or null when cancelled. "add" words the panel for ⌘⇧O. */
  pickPath(purpose?: PickPurpose): Promise<string | null>;
  /** Picks a folder only; Settings uses it for the default folder. */
  pickFolder(): Promise<string | null>;
  /** Whether a dropped path is a folder, a Markdown file, or something else. */
  pathKind(path: string): Promise<PathKind>;
  /** Selects the path in the system file manager. */
  revealInFinder(path: string): Promise<void>;
  getRecents(): Promise<RecentSession[]>;
  saveRecents(recents: RecentSession[]): Promise<void>;
  listPages(folder: string): Promise<PageMeta[]>;
  readPage(folder: string, path: string): Promise<Page>;
  /** Writes the full file content (front matter included). */
  writePage(folder: string, path: string, content: string): Promise<void>;
  /** A folder's session, or with `file`, the separate session kept for a single-file session in that folder. */
  loadSession(folder: string, file?: string): Promise<Session | null>;
  saveSession(folder: string, session: Session, file?: string): Promise<void>;
  listVersions(folder: string, path: string): Promise<VersionInfo[]>;
  readVersion(folder: string, path: string, n: number): Promise<string>;
  /** Copies the page's current content into a new numbered snapshot. */
  snapshotVersion(folder: string, path: string): Promise<number>;
  /** Writes snapshot n back to the page and drops every newer snapshot. */
  restoreVersion(folder: string, path: string, n: number): Promise<void>;
  deleteVersion(folder: string, path: string, n: number): Promise<void>;
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
  setApiKey(provider: Provider, key: string): Promise<void>;
  hasApiKey(provider: Provider): Promise<boolean>;
  aiStream(req: AiRequest, onEvent: (e: StreamEvent) => void): StreamHandle;
  aiPing(provider: Provider, auth: Auth | undefined, baseUrl: string, model: string): Promise<PingResult>;
  openSettings(): Promise<void>;
  /** Opens a page in its own window, showing an old version of it when `version` is given. */
  openPageWindow(folder: string, path: string, version?: number): Promise<void>;
  /** Menu / shortcut commands coming from the native menu bar. */
  onCommand(handler: (id: string) => void): () => void;
  onSettingsChanged(handler: (s: Settings) => void): () => void;
  /** Files or folders dragged over or dropped on the window. */
  onDragDrop(handler: (e: DragDropEvent) => void): () => void;
}
