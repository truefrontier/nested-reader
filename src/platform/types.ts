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
  /**
   * Pages, or whole subfolders, dropped from an added root's session view with "Remove from
   * session"; keyed the same way `roots` pages are (absolute inside that root's folder). Their
   * files stay on disk untouched.
   */
  excluded?: string[];
  /** Unix `dev:ino` for each page path, written on save so a Finder rename can be remapped. */
  ids?: Record<string, string>;
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
  /** Unix `dev:ino` of the session folder. */
  folderId?: string;
  /** Unix `dev:ino` of `file`, when the session is a single .md. */
  fileId?: string;
  /** Mac NSURL bookmark for the folder, used when the absolute path is gone. */
  bookmark?: string;
};

/** What `resolveSession` found after matching missing paths by identity. */
export type ResolvedSession = {
  folder: string;
  file?: string;
  remaps: [string, string][];
  folderId?: string;
  fileId?: string;
  bookmark?: string;
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
  /** `map` is the session map: every page named, the nearest described. See `src/lib/sessionmap.ts`. */
  context: { highlight: boolean; session: boolean; folder: boolean; map: boolean };
  /** Let the model list, read and search the session folder's pages itself while it answers. */
  tools: boolean;
  /** Ask before deleting a page from the tree; "Do not ask again" in that confirmation turns it off. */
  confirmDelete: boolean;
  /** The Home screen still offers to make Nested the Mac's app for .md files; off after Not now or once it is. */
  offerDefaultApp: boolean;
};

/** The Send feedback box keeps the note this long at most; the relay refuses more. */
export const FEEDBACK_MAX = 5000;

/** Which Mac app opens .md files today, from the desktop backend. */
export type DefaultApp = {
  /** Display name, e.g. "Typora"; missing when no app is set. */
  app?: string;
  isNested: boolean;
  /** False under `tauri dev`, which runs a bare executable rather than an app bundle. */
  available: boolean;
};

/** A newer release of the app, as the desktop backend reports it. */
export type UpdateInfo = { version: string; notes?: string };

/** What a check for updates found. `supported` is false where nothing can be swapped in: the browser preview and `tauri dev`. */
export type UpdateCheck = { current: string; supported: boolean; update?: UpdateInfo };

/** Download progress while an update installs; `installed` comes once, just before the app relaunches. */
export type UpdateProgress = { type: "progress"; downloaded: number; total?: number | null } | { type: "installed" };

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
  context: { highlight: true, session: true, folder: false, map: true },
  tools: true,
  confirmDelete: true,
  offerDefaultApp: true,
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
  /**
   * Pages, or whole subfolders, dropped from an added root with "Remove from session"; kept out
   * of the tools' reach, and out of what a CLI is told is fair to read. Keyed the same way
   * `Session.excluded` is.
   */
  excluded?: string[];
  /** The kind of AI ask for analytics: "quick_answer", "new_page", "deep_dive", or "refine". */
  kind?: string;
};

/** A tool the model is using, reported so the UI can say what it is looking at. */
export type ToolEvent = { type: "tool"; name: string; detail: string };

export type StreamEvent =
  | { type: "delta"; text: string }
  | ToolEvent
  /** `truncated` means the model hit its token ceiling mid-answer, so the text is cut off. */
  | { type: "done"; truncated?: boolean }
  | { type: "error"; message: string };

/** `models` lists what the provider offers (installed models for Ollama, cheapest first). */
export type PingResult = { ok: true; ms: number; models?: string[] } | { ok: false; error: string; models?: string[] };

export type StreamHandle = { cancel(): void };

export interface Platform {
  isTauri: boolean;
  /**
   * Shows the Open panel; resolves to the chosen folders and/or Markdown files, empty when
   * cancelled. "add" words the panel for ⌘⇧O and allows picking more than one at once; "open"
   * (the default) is single-selection, since a session starts from one folder or file.
   */
  pickPath(purpose?: PickPurpose): Promise<string[]>;
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
  /** Takes a page out of the folder; the desktop backend parks it in `.reader/trash` rather than removing it. */
  deletePage(folder: string, path: string): Promise<void>;
  /** A folder's session, or with `file`, the separate session kept for a single-file session in that folder. */
  loadSession(folder: string, file?: string): Promise<Session | null>;
  saveSession(folder: string, session: Session, file?: string): Promise<void>;
  /** A yes/no before something costly. `detail` is the smaller line under the question. */
  confirm(message: string, detail?: string, okLabel?: string): Promise<boolean>;
  /** The session map's one-line summaries, kept in `.reader/map.json`. */
  loadMap(folder: string): Promise<Record<string, { about: string; for: string }> | null>;
  saveMap(folder: string, cache: Record<string, { about: string; for: string }>, rendered: string): Promise<void>;
  /**
   * If a stored path is missing, match Markdown in the folder by `dev:ino` (and on Mac, the
   * folder bookmark first). Remaps session keys and `.reader` files in the same pass.
   */
  resolveSession(folder: string, file: string | undefined, ids?: Record<string, string>, bookmark?: string): Promise<ResolvedSession>;
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
  /** Files the OS asked the app to open before the reader was listening (the double-click that launched it). Drains them. */
  openedPaths(): Promise<string[]>;
  /** Files the OS asks the running app to open: a double-click in Finder, Open With, a drop on the Dock icon. */
  onOpened(handler: (paths: string[]) => void): () => void;
  /** Which app opens .md files on this Mac. */
  defaultMarkdownApp(): Promise<DefaultApp>;
  /** Asks the OS to make this app the default for .md files; resolves once it has answered, with the new state. */
  setDefaultMarkdownApp(): Promise<DefaultApp>;
  /** Sends a note from the Send feedback box; it is filed as a GitHub issue. Rejects with a sentence to show. */
  sendFeedback(message: string, email?: string): Promise<void>;
  /** Asks the update server for a newer release. Rejects with a sentence to show. */
  checkForUpdate(): Promise<UpdateCheck>;
  /** Downloads and installs the update the last check found; resolves once it is in place, ready for `relaunch`. */
  installUpdate(onProgress: (p: UpdateProgress) => void): Promise<void>;
  /** Starts the app again, on the new version. */
  relaunch(): Promise<void>;
}
