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
  split?: string;
  splitDirection: SplitDirection;
};

export type Provider = "builtin" | "openai" | "anthropic" | "ollama" | "custom";
/** How OpenAI and Anthropic are reached: an API key, or the plan signed in to their official CLI. */
export type Auth = "key" | "subscription";
/** Each way of reaching a provider remembers its own model. */
export type ModelSlot = Provider | "openai-subscription" | "anthropic-subscription";
export type Placement = "beside" | "below" | "active" | "background" | "window";
export type OpenAtLaunch = "last-session" | "ask" | "nothing";

export type Settings = {
  folder?: string;
  /** "" means new pages are saved next to their source. */
  newPagesSubfolder: string;
  openAtLaunch: OpenAtLaunch;
  theme: "system" | "light" | "dark";
  textSize: number;
  readingFont: "serif" | "sans";
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
};

export const DEFAULT_SETTINGS: Settings = {
  newPagesSubfolder: "",
  openAtLaunch: "last-session",
  theme: "system",
  textSize: 17,
  readingFont: "serif",
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
};

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
};

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

/** `models` lists what the provider offers (installed models for Ollama, cheapest first). */
export type PingResult = { ok: true; ms: number; models?: string[] } | { ok: false; error: string; models?: string[] };

export type StreamHandle = { cancel(): void };

export interface Platform {
  isTauri: boolean;
  pickFolder(): Promise<string | null>;
  listPages(folder: string): Promise<PageMeta[]>;
  readPage(folder: string, path: string): Promise<Page>;
  /** Writes the full file content (front matter included). */
  writePage(folder: string, path: string, content: string): Promise<void>;
  loadSession(folder: string): Promise<Session | null>;
  saveSession(folder: string, session: Session): Promise<void>;
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
  openPageWindow(folder: string, path: string): Promise<void>;
  /** Menu / shortcut commands coming from the native menu bar. */
  onCommand(handler: (id: string) => void): () => void;
  onSettingsChanged(handler: (s: Settings) => void): () => void;
}
