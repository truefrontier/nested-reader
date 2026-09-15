import { useSyncExternalStore } from "react";
import {
  DEFAULT_SETTINGS,
  emptySession,
  platform,
  readingWidthCss,
  sidebarWidthPx,
  type AiRequest,
  type Ask,
  type ChatMessage,
  type DefaultApp,
  type PageMeta,
  type Placement,
  type RecentSession,
  type Session,
  type SessionRoot,
  type Settings,
  type StreamHandle,
  type VersionInfo,
} from "../platform";
import { diffBodies, revertChange, type Change, type PageDiff } from "../lib/diff";
import { findWikiLink, joinBlocks, lexBlocks, linkTextInRaw, replaceFlexible, resolveWikiTarget } from "../lib/markdown";
import { authFor, modelSlot } from "../lib/models";
import { serializePage, titleFromBody } from "../lib/frontmatter";
import { slugify, titleFromQuestion, uniquePath } from "../lib/slug";
import { nowIso } from "../lib/time";
import { newFileMessages, newPageMessages, quickAnswerMessages, refineMessages, type AskContext, type RefineScope } from "../lib/prompts";
import { dirOf, folderChain, growsFrom, rootDirs, sessionPages } from "../lib/tree";

export type Selection = {
  /** The pane the text was highlighted in: the box opens there and its verbs act on that pane's page. */
  pane: PaneRole;
  block: number;
  start: number;
  end: number;
  text: string;
  paragraph: string;
  /** Horizontal position of the selection end inside the block, in px. */
  caretX: number;
};

export type Lookup = {
  /** The pane the answer card sits in. */
  pane: PaneRole;
  block: number;
  /** The highlighted text the ask is about, so the answer can be remembered against it. */
  anchor?: { start: number; end: number; text: string };
  thread: { question: string; answer: string }[];
  question: string;
  answer: string;
  streaming: boolean;
  error?: string;
  /** Shown because the pointer is over a remembered ask; it goes away when the pointer leaves. */
  peek?: boolean;
};

export type Popover = "ask" | "refine";
export type Verb = "quick" | "page" | "deep";
/** The ⌘N verbs: ↵ opens the page here, ⌘↵ and ⌘⇧↵ are the New Page and Deep Dive placements. */
export type NewFileVerb = "here" | "page" | "deep";
/** Where a page's brief came from: a highlight in its source (the default) or the whole session (⌘N). */
export type PageOrigin = "highlight" | "session";

/** The box at the bottom of the pane: refine the page or corpus (⌘R), or start a new page (⌘N). */
export type PanePopover = "refine" | "new" | "feedback";

/** Which pane something belongs to: the reading pane, or the one opened beside or below it. */
export type PaneRole = "main" | "split";

/** The key an answer card is held under: one card per block per pane, so several asks stream side by side. */
export function lookupId(pane: PaneRole, block: number): string {
  return `${pane}:${block}`;
}

/** One pane's version history UI: whether its menu is open, which old version it shows, and whether Restore awaits a yes. */
export type VersionView = { history: boolean; viewing?: number; confirmRestore: boolean };

/** One refinement asked for: what it is rewriting, and the failure it left if it came back with nothing. */
export type RefineRun = {
  /** The page it rewrites. A corpus refine names the page it was asked from and covers the session. */
  path: string;
  scope: RefineScope;
  /** The instruction it is running, shown while it runs and kept for a retry. */
  text: string;
  /** Why it failed; the card then offers Try again in the place of the progress line. */
  error?: string;
};

export type UiState = {
  selection?: Selection;
  popover?: Popover;
  panePopover?: PanePopover;
  /** The answer cards on show, by `lookupId`, so several quick asks can stream at once. */
  lookups: Record<string, Lookup>;
  /** Version history UI, per pane, so each pane can show a different version of the same page. */
  versionView: Record<PaneRole, VersionView>;
  map?: "web" | "timeline";
  fullscreen: boolean;
  /** When both panes show the same page they scroll together, until this is turned off from the pane tools. */
  syncScroll: boolean;
  filter: string;
  /** Tree filters: only unread pages (with those being written or that failed), only pages with changes to review. Both on shows either. */
  unreadOnly: boolean;
  changesOnly: boolean;
  /**
   * The refinements asked for, and the failures they left, by run id: a card each. Keyed per run
   * rather than per page, so a page refine keeps its card while a selection refine on the same page
   * queues behind it, and each card names the instruction it is actually running.
   */
  refines: Record<string, RefineRun>;
  /** The instruction Try again reopened the pane refine box with. */
  refineRetry?: string;
  error?: string;
  /** Something is being dragged over the window. */
  dragging: boolean;
  /** The find bar is open in the reading pane. */
  find: boolean;
  /** What is being searched for; kept across closing so ⌘G can pick it back up. */
  findQuery: string;
  /** Which match is current, wrapped by the page against how many there are. */
  findIndex: number;
  /** Bumped each time the find box should take focus. */
  findFocus: number;
  /** Bumped each time the current match should become the selection, with the ask or refine box open on it. */
  findSelect: number;
  /** Bumped each time the tree's Filter box should take focus. */
  filterFocus: number;
};

export type ReviewBase = { path: string; n: number; body: string };

export type ReaderState = {
  ready: boolean;
  /** The Home screen is showing instead of the session. It also shows whenever no folder is open. */
  home: boolean;
  recents: RecentSession[];
  folder?: string;
  /** Set when the session was opened from a single file: only that page and the pages grown from it are shown. */
  rootFile?: string;
  folderName: string;
  pages: Record<string, PageMeta>;
  bodies: Record<string, string>;
  session: Session;
  settings: Settings;
  /** Snapshots of each page shown in a pane, by path. */
  versions: Record<string, VersionInfo[]>;
  /** Old version texts already read, by path then version number. */
  versionBodies: Record<string, Record<number, string>>;
  /** The snapshot each pending page is being reviewed against, by path. */
  reviewBases: Record<string, ReviewBase>;
  /** Pages the model failed to write, by path, with the error; they keep their heading and can be retried. */
  pageErrors: Record<string, string>;
  /** What the model is looking at right now, by stream key ("lookup:<id>", "page:<path>", "refine:<path>"), while it uses a tool. */
  working: Record<string, string>;
  apiKeyMissing?: boolean;
  /** Which app opens .md files on this Mac; the Home offer and the Settings row follow it. */
  defaultApp?: DefaultApp;
  /** Where the app stands with updates; the bar at the bottom of the window follows it. */
  update: UpdateState;
  ui: UiState;
};

export type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "installing" | "error";

export type UpdateState = {
  phase: UpdatePhase;
  /** The running version, once a check has answered. */
  current?: string;
  /** The newer version, from "available" on. */
  version?: string;
  notes?: string;
  downloaded?: number;
  total?: number;
  /** Why the last check or install failed. */
  message?: string;
  /** Later was clicked: the bar stays away until the next launch or a check from the menu. */
  dismissed?: boolean;
};

/** How long after launch the first check waits, so it never competes with opening the session. */
const UPDATE_CHECK_DELAY = 4000;
/** How often a running app looks again. */
const UPDATE_CHECK_EVERY = 6 * 60 * 60 * 1000;

const closedVersionView: VersionView = { history: false, confirmRestore: false };

const initialUi: UiState = {
  lookups: {},
  versionView: { main: closedVersionView, split: closedVersionView },
  refines: {},
  fullscreen: false,
  syncScroll: true,
  filter: "",
  unreadOnly: false,
  changesOnly: false,
  dragging: false,
  find: false,
  findQuery: "",
  findIndex: 0,
  findFocus: 0,
  findSelect: 0,
  filterFocus: 0,
};

/** What the OS can hand the app that it cannot open. */
const OPENED_OTHERWISE = "Nested opens folders and .md files.";

function prettyFolderName(folder: string): string {
  const base = folder.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? folder;
  return base.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export class ReaderStore {
  state: ReaderState = {
    ready: false,
    home: false,
    recents: [],
    folderName: "",
    pages: {},
    bodies: {},
    session: emptySession(),
    settings: DEFAULT_SETTINGS,
    versions: {},
    versionBodies: {},
    reviewBases: {},
    pageErrors: {},
    working: {},
    update: { phase: "idle" },
    ui: initialUi,
  };

  private listeners = new Set<() => void>();
  private streams = new Map<string, StreamHandle>();
  /** One task chain per page, so work on the same page runs in turn while other pages run alongside. */
  private chains = new Map<string, Promise<void>>();
  /** Lets go of whatever waits on a stream, by stream key, since a cancelled stream sends no last event. */
  private releases = new Map<string, (err?: unknown) => void>();
  /** Names each refine asked for, so its own card can be found again when it settles. */
  private refineSeq = 0;
  private saveTimer: number | undefined;
  private writeTimers = new Map<string, number>();
  private initialized = false;
  /** The folder (and file) an in-flight openFolder is loading, so a later open can supersede it. */
  private opening?: { folder: string; file?: string };
  /** Inode and Mac bookmark from the last resolve, written onto recents. */
  private lastIdentity: { folderId?: string; fileId?: string; bookmark?: string } = {};
  /** True while a focus rematch is in flight, so a second focus does not overlap it. */
  private rematching = false;
  /** Cumulative Finder remaps this session (`from` → `to`), so an in-flight write still finds the page. */
  private pathRemaps = new Map<string, string>();

  get = () => this.state;

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  private emit() {
    for (const l of this.listeners) l();
  }

  private set(patch: Partial<ReaderState>) {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  setUi(patch: Partial<UiState>) {
    this.set({ ui: { ...this.state.ui, ...patch } });
  }

  private setSession(patch: Partial<Session>) {
    this.set({ session: { ...this.state.session, ...patch } });
    this.persistSession();
  }

  private persistSession() {
    if (!this.state.folder) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      if (this.state.folder) platform.saveSession(this.state.folder, this.state.session, this.state.rootFile).catch(() => undefined);
      const unread = this.state.session.unread.length;
      if (this.currentRecent()?.unread !== unread) this.touchRecent({ unread });
    }, 250);
  }

  fail(err: unknown) {
    this.notify(err instanceof Error ? err.message : String(err));
  }

  /** A sentence in the toast at the bottom of the window, for six seconds. */
  notify(message: string) {
    this.setUi({ error: message });
    window.setTimeout(() => {
      if (this.state.ui.error === message) this.setUi({ error: undefined });
    }, 6000);
  }

  // ---------- lifecycle ----------

  async init() {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const [settings, recents] = await Promise.all([platform.getSettings(), platform.getRecents().catch(() => [] as RecentSession[])]);
      this.set({ settings, recents });
      this.applyTheme(settings);
      platform.onSettingsChanged((s) => {
        this.set({ settings: s });
        this.applyTheme(s);
        if (s.folder && s.folder !== (this.opening?.folder ?? this.state.folder)) void this.openFolder(s.folder);
      });
      platform.onCommand((id) => this.command(id));
      platform.onDragDrop((e) => {
        if (e.type === "drop") {
          this.setUi({ dragging: false });
          void this.openDropped(e.paths);
        } else if (e.type === "leave") {
          if (this.state.ui.dragging) this.setUi({ dragging: false });
        } else if (!this.state.ui.dragging) {
          this.setUi({ dragging: true });
        }
      });
      const url = new URL(location.href);
      const page = url.searchParams.get("page");
      const versionParam = Number(url.searchParams.get("version"));
      const initialVersion = Number.isInteger(versionParam) && versionParam > 0 ? versionParam : undefined;
      const last = recents[0];
      // Only the main window takes files from Finder; a page window shows the one page it was opened for.
      if (!page) {
        platform.onOpened((paths) => void this.openOpened(paths));
        window.addEventListener("focus", () => {
          void this.loadDefaultApp();
          void this.rematchOpenSession();
        });
        void this.loadDefaultApp();
        window.setTimeout(() => void this.checkForUpdate(), UPDATE_CHECK_DELAY);
        window.setInterval(() => void this.checkForUpdate(), UPDATE_CHECK_EVERY);
      }
      // The file that launched the app (a double-click in Finder) wins over "Open at launch".
      const opened = page ? [] : await platform.openedPaths();
      if (opened[0]) {
        await this.openPath(opened[0], OPENED_OTHERWISE);
      } else if (page && settings.folder) {
        await this.openFolder(settings.folder, {
          initialPage: page,
          initialVersion,
          file: last?.folder === settings.folder ? last.file : undefined,
          bookmark: last?.folder === settings.folder ? last.bookmark : undefined,
          ids: last?.folder === settings.folder ? idsFromRecent(last) : undefined,
        });
      } else if (settings.openAtLaunch === "ask") {
        const path = await platform.pickPath();
        if (path) await this.openPath(path, "Open a folder or a .md file.");
      } else if (settings.openAtLaunch === "last-session") {
        if (last) await this.openFolder(last.folder, { file: last.file, bookmark: last.bookmark, ids: idsFromRecent(last) });
        else if (settings.folder) await this.openFolder(settings.folder);
      }
      // "nothing", a cancelled picker or a first launch: the Home screen shows.
    } catch (e) {
      this.fail(e);
    } finally {
      this.set({ ready: true });
    }
  }

  applyTheme(s: Settings) {
    const root = document.documentElement;
    const dark = s.theme === "dark" || (s.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    root.dataset.theme = dark ? "dark" : "light";
    root.style.setProperty("--text-size", `${s.textSize}px`);
    root.style.setProperty("--reading-width", readingWidthCss(s.readingWidth));
    root.style.setProperty("--side-width", `${sidebarWidthPx(s.sidebarWidth)}px`);
    root.dataset.font = s.readingFont;
  }

  /** ⌘O: one Open panel for a folder or a single .md, then the session that path starts. */
  async pickPath() {
    try {
      const path = await platform.pickPath();
      if (path) await this.openPath(path, "Open a folder or a .md file.");
    } catch (e) {
      this.fail(e);
    }
  }

  /** A folder or a .md file starts a session; anything else is refused with `otherwise`. */
  async openPath(path: string, otherwise: string) {
    const kind = await platform.pathKind(path);
    if (kind === "folder") await this.openFolder(path);
    else if (kind === "file") await this.openFile(path);
    else this.fail(otherwise);
  }

  /** Opens one .md as a session: that page and the pages grown from it, saved beside it. */
  async openFile(path: string) {
    const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    if (i <= 0) return this.fail(`Could not find the folder of ${path}`);
    await this.openFolder(path.slice(0, i), { file: path.slice(i + 1) });
  }

  /** Paths the OS asked the app to open (Finder, the Dock icon): a folder or a .md file starts a session. */
  async openOpened(paths: string[]) {
    const path = paths[0];
    if (!path) return;
    try {
      await this.openPath(path, OPENED_OTHERWISE);
    } catch (e) {
      this.fail(e);
    }
  }

  /** Paths dropped on the window: a folder or a .md file starts a session. */
  async openDropped(paths: string[]) {
    const path = paths[0];
    if (!path) return this.fail("Drop a folder or a .md file.");
    try {
      await this.openPath(path, "Drop a folder or a .md file.");
    } catch (e) {
      this.fail(e);
    }
  }

  // ---------- roots added to the session ----------

  /** ⌘⇧O: adds a folder or a .md file to the open session, so its pages join the tree, the context and the model's tools. */
  async addRoot() {
    if (!this.state.folder || this.state.home) return;
    try {
      const path = await platform.pickPath("add");
      if (!path) return;
      const kind = await platform.pathKind(path);
      if (kind === "other") return this.fail("Add a folder or a .md file.");
      await this.includeRoot(kind === "folder" ? { folder: path } : splitFilePath(path));
    } catch (e) {
      this.fail(e);
    }
  }

  private async includeRoot(root: SessionRoot) {
    const primary = this.state.folder;
    if (!primary) return;
    const roots = this.state.session.roots ?? [];
    if (roots.some((r) => r.folder === root.folder && (r.file ?? "") === (root.file ?? ""))) return this.fail("That is already part of this session.");
    const fresh = await this.rootPages(root, primary, takenPaths(this.state.pages, primary, this.rootDirs()));
    if (!this.state.folder || this.state.folder !== primary) return;
    const keys = Object.keys(fresh);
    if (!keys.length) return this.fail(root.file ? "That page is already in this session." : "No new pages there: the folder has none, or they are already in this session.");
    this.set({ pages: { ...this.state.pages, ...fresh } });
    this.setSession({ roots: [...roots, root] });
    const dir = root.folder === primary ? "" : root.folder;
    if (this.state.session.collapsed?.includes(dir)) this.toggleFolder(dir);
    if (!this.state.session.current) await this.navigate(root.file ? keys[0] : keys.sort()[0]);
  }

  /** Takes a root's folder (every root in it) out of the session and reloads, so its pages leave the tree. */
  async removeRoot(folder: string) {
    await this.dropRoots((r) => r.folder !== folder);
  }

  /** Saves the session with only the roots `keep` accepts, then reloads it so the tree matches. */
  private async dropRoots(keep: (r: SessionRoot) => boolean) {
    const { folder: primary, rootFile, session } = this.state;
    if (!primary) return;
    const roots = (session.roots ?? []).filter(keep);
    try {
      window.clearTimeout(this.saveTimer);
      await platform.saveSession(primary, { ...session, roots: roots.length ? roots : undefined }, rootFile);
      await this.openFolder(primary, { file: rootFile });
    } catch (e) {
      this.fail(e);
    }
  }

  /** The key a root's own page is held under: relative in the session folder, absolute in any other. */
  private rootKey(r: SessionRoot): string | undefined {
    if (!r.file) return undefined;
    return r.folder === this.state.folder ? r.file : `${r.folder}/${r.file}`;
  }

  /**
   * The pages of one root, keyed as the session holds them: by full path, `<folder>/<page>`, or by their
   * relative path when the root is the session folder itself. A file root gives that page and the pages grown
   * from it, like a file session. Pages whose file is already in the session (`taken` holds full paths) are
   * left out, so overlapping roots never list a page twice.
   */
  private async rootPages(root: SessionRoot, primary: string, taken: Set<string>): Promise<Record<string, PageMeta>> {
    const list = await platform.listPages(root.folder);
    const all: Record<string, PageMeta> = {};
    for (const p of list) all[p.path] = p;
    if (root.file && !all[root.file]) throw new Error(`Not a Markdown page: ${root.file}`);
    const own = root.folder === primary;
    const out: Record<string, PageMeta> = {};
    for (const p of list) {
      if (root.file && !growsFrom(p.path, root.file, all)) continue;
      const abs = `${root.folder}/${p.path}`;
      if (taken.has(abs)) continue;
      const key = own ? p.path : abs;
      out[key] = keyedMeta(p, key, root.folder);
    }
    return out;
  }

  /** The folders of the roots added with ⌘⇧O, other than the session folder itself. */
  private rootDirs(): string[] {
    return rootDirs(this.state.session.roots, this.state.folder);
  }

  /**
   * Where a page lives on disk: the session folder and the page's path inside it, or for a page of an added
   * root (keyed by its full path) that root's folder and the path inside it.
   */
  private loc(path: string): { folder: string; rel: string } {
    const dir = rootOfKey(path, this.rootDirs());
    return dir ? { folder: dir, rel: path.slice(dir.length + 1) } : { folder: this.state.folder ?? "", rel: path };
  }

  /** Writes a page's front matter and body where the page lives; the source is written as that folder knows it. */
  private async writePage(path: string, body: string, meta?: PageMeta) {
    // Rematch rewrites `source:` on disk; wait so a flush cannot put the old parent path back.
    while (this.rematching) {
      await new Promise((r) => window.setTimeout(r, 50));
    }
    path = this.livePath(path);
    const live = this.state.pages[path];
    const base = live
      ? { ...live, title: meta?.title ?? live.title, question: meta?.question ?? live.question, mode: meta?.mode ?? live.mode, created: meta?.created ?? live.created, source: live.source, path: live.path }
      : meta;
    if (!base) return;
    const { folder, rel } = this.loc(path);
    const source = base.source?.startsWith(folder + "/") ? base.source.slice(folder.length + 1) : base.source;
    await platform.writePage(folder, rel, serializePage({ ...base, source }, body));
  }

  /** Follow Finder remaps so a stream started under the old path still writes the live page. */
  private livePath(path: string): string {
    let cur = path;
    const seen = new Set<string>();
    while (this.pathRemaps.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = this.pathRemaps.get(cur)!;
    }
    return cur;
  }

  /**
   * Loads a folder as the session. With `file`, only that page and the pages grown from it
   * are shown. The folder's saved session is restored, so you land where you left off.
   */
  async openFolder(
    folder: string,
    opts: { initialPage?: string; initialVersion?: number; file?: string; bookmark?: string; ids?: Record<string, string> } = {},
  ) {
    const { initialPage, initialVersion } = opts;
    let { file } = opts;
    const target = { folder, file };
    this.opening = target;
    try {
      const recentHint = this.findRecent(folder, file);
      const ids = { ...idsFromRecent(recentHint), ...opts.ids };
      const bookmark = opts.bookmark ?? recentHint?.bookmark;
      const resolved = await platform.resolveSession(folder, file, Object.keys(ids).length ? ids : undefined, bookmark);
      if (this.opening !== target) return; // a later open superseded this one
      folder = resolved.folder;
      file = resolved.file ?? file;
      this.lastIdentity = { folderId: resolved.folderId, fileId: resolved.fileId, bookmark: resolved.bookmark };
      const list = await platform.listPages(folder);
      if (this.opening !== target) return;
      const all: Record<string, PageMeta> = {};
      for (const p of list) all[p.path] = p;
      if (file && !all[file]) throw new Error(`Not a Markdown page: ${file}`);
      const pages: Record<string, PageMeta> = {};
      for (const p of list) if (!file || growsFrom(p.path, file, all)) pages[p.path] = p;
      const stored = await platform.loadSession(folder, file);
      if (this.opening !== target) return;
      const session: Session = { ...emptySession(), ...(stored ?? {}) };
      // The roots added with ⌘⇧O bring their pages along; one that cannot be read any more is dropped from the session.
      const roots: SessionRoot[] = [];
      let lost: string | undefined;
      for (const root of session.roots ?? []) {
        try {
          Object.assign(pages, await this.rootPages(root, folder, takenPaths(pages, folder, rootDirs(roots, folder))));
          roots.push(root);
        } catch {
          lost = root.file ? `${root.folder}/${root.file}` : root.folder;
        }
      }
      if (this.opening !== target) return;
      session.roots = roots.length ? roots : undefined;
      session.loading = session.loading.filter((p) => pages[p]);
      session.unread = session.unread.filter((p) => pages[p]);
      for (const key of Object.keys(session.pending)) if (!pages[key]) delete session.pending[key];
      if (session.split && !pages[session.split]) session.split = undefined;
      // Pages deleted outside the app drop out of the trail.
      const before = session.trail.slice(0, session.trailIndex + 1).filter((p) => pages[p]);
      session.trail = session.trail.filter((p) => pages[p]);
      session.trailIndex = before.length - 1;
      const recent = this.findRecent(folder, file) ?? this.findRecentById(resolved.folderId, resolved.fileId) ?? recentHint;
      const folderName = session.name || recent?.name || (file ? pages[file].title : prettyFolderName(folder));
      this.pathRemaps.clear();
      this.chains.clear();
      this.set({ folder, rootFile: file, folderName, pages, bodies: {}, session, versions: {}, versionBodies: {}, reviewBases: {}, pageErrors: {}, home: false, ui: { ...initialUi } });
      let current = initialPage && pages[initialPage] ? initialPage : session.current;
      if (!current || !pages[current]) {
        const sorted = Object.values(pages).sort((a, b) => Date.parse(b.created ?? b.modified ?? "") - Date.parse(a.created ?? a.modified ?? ""));
        current = file ?? sorted[0]?.path;
      }
      if (current) await this.navigate(current, { push: session.trail.length === 0 });
      // A window opened on an old version (⌘Click on a version with the "window" placement) starts out viewing it.
      if (initialVersion !== undefined && current && current === initialPage) await this.viewVersion(initialVersion, "main");
      if (session.split) {
        await this.loadBody(session.split);
        await this.refreshVersions(session.split);
      }
      this.rememberSession();
      if (lost) this.fail(`Couldn't read ${lost}; it was dropped from the session.`);
      if (this.state.settings.folder !== folder) {
        const settings = { ...this.state.settings, folder };
        this.set({ settings });
        await platform.saveSettings(settings);
      }
    } catch (e) {
      this.fail(e);
    } finally {
      if (this.opening === target) this.opening = undefined;
    }
  }

  // ---------- home & recent sessions ----------

  private sameSession(r: RecentSession, folder: string | undefined, file: string | undefined): boolean {
    return r.folder === folder && (r.file ?? "") === (file ?? "");
  }

  private findRecent(folder: string, file?: string): RecentSession | undefined {
    return this.state.recents.find((r) => this.sameSession(r, folder, file));
  }

  private findRecentById(folderId?: string, fileId?: string): RecentSession | undefined {
    if (!folderId) return undefined;
    return this.state.recents.find((r) => r.folderId === folderId && (r.fileId ?? "") === (fileId ?? ""));
  }

  private currentRecent(): RecentSession | undefined {
    if (!this.state.folder) return undefined;
    return this.findRecent(this.state.folder, this.state.rootFile) ?? this.findRecentById(this.lastIdentity.folderId, this.lastIdentity.fileId);
  }

  private setRecents(recents: RecentSession[]) {
    this.set({ recents });
    platform.saveRecents(recents).catch(() => undefined);
  }

  /** Puts the open session at the top of the recents list. */
  private rememberSession() {
    const { folder, rootFile, folderName, session } = this.state;
    if (!folder) return;
    const id = this.lastIdentity;
    const previous = this.findRecent(folder, rootFile) ?? this.findRecentById(id.folderId, id.fileId);
    const entry: RecentSession = {
      folder,
      file: rootFile,
      name: folderName,
      openedAt: nowIso(),
      unread: session.unread.length,
      folderId: id.folderId ?? previous?.folderId,
      fileId: rootFile ? (id.fileId ?? previous?.fileId) : undefined,
      bookmark: id.bookmark ?? previous?.bookmark,
    };
    this.setRecents([entry, ...this.state.recents.filter((r) => !this.matchesRecent(r, entry, previous))].slice(0, 30));
  }

  private matchesRecent(r: RecentSession, entry: RecentSession, previous?: RecentSession): boolean {
    if (this.sameSession(r, entry.folder, entry.file)) return true;
    if (previous && this.sameSession(r, previous.folder, previous.file)) return true;
    if (entry.folderId && r.folderId === entry.folderId && (r.fileId ?? "") === (entry.fileId ?? "")) return true;
    return false;
  }

  private touchRecent(patch: Partial<RecentSession>) {
    const cur = this.currentRecent();
    if (cur) this.setRecents(this.state.recents.map((r) => (r === cur ? { ...r, ...patch } : r)));
  }

  /** Steps up to the Home screen. The session stays loaded, so leaving Home returns to it as it was. */
  goHome() {
    this.setUi({ popover: undefined, selection: undefined, panePopover: undefined, map: undefined, versionView: this.closedMenus({ confirmRestore: false }) });
    this.set({ home: true });
  }

  leaveHome() {
    if (this.state.folder) this.set({ home: false });
  }

  toggleHome() {
    if (this.state.home) this.leaveHome();
    else this.goHome();
  }

  async openRecent(r: RecentSession) {
    if (this.sameSession(r, this.state.folder, this.state.rootFile)) return this.leaveHome();
    await this.openFolder(r.folder, { file: r.file, bookmark: r.bookmark, ids: idsFromRecent(r) });
  }

  removeRecent(r: RecentSession) {
    this.setRecents(this.state.recents.filter((x) => x !== r));
  }

  /** Renames a session on Home and in its own session.json, so the name travels with the folder. */
  async renameSession(r: RecentSession, name: string) {
    const trimmed = name.trim();
    if (!trimmed || trimmed === r.name) return;
    this.setRecents(this.state.recents.map((x) => (x === r ? { ...x, name: trimmed } : x)));
    if (this.sameSession(r, this.state.folder, this.state.rootFile)) {
      this.set({ folderName: trimmed });
      this.setSession({ name: trimmed });
      return;
    }
    try {
      const stored = await platform.loadSession(r.folder, r.file);
      await platform.saveSession(r.folder, { ...emptySession(), ...(stored ?? {}), name: trimmed }, r.file);
    } catch (e) {
      this.fail(e);
    }
  }

  async revealSession(r: RecentSession) {
    try {
      await platform.revealInFinder(r.file ? `${r.folder}/${r.file}` : r.folder);
    } catch (e) {
      this.fail(e);
    }
  }

  async mapSession(r: RecentSession) {
    await this.openRecent(r);
    if (this.sameSession(r, this.state.folder, this.state.rootFile)) this.openMap("web");
  }

  async loadBody(path: string): Promise<string> {
    const cached = this.state.bodies[path];
    if (cached !== undefined) return cached;
    if (!this.state.folder) return "";
    const { folder, rel } = this.loc(path);
    const page = await platform.readPage(folder, rel);
    const meta = keyedMeta({ ...this.state.pages[path], ...page, body: undefined } as PageMeta, path, folder);
    this.set({ bodies: { ...this.state.bodies, [path]: page.body }, pages: { ...this.state.pages, [path]: meta } });
    return page.body;
  }

  // ---------- navigation ----------

  async navigate(path: string, opts: { push?: boolean } = {}) {
    if (!this.state.pages[path]) return;
    try {
      await this.loadBody(path);
      // The cards leaving with the old page are filed under it, so this runs before `current` moves.
      const lookups = this.closedLookups(this.lookupIdsIn("main"));
      const s = this.state.session;
      const trail = opts.push === false ? s.trail : [...s.trail.slice(0, s.trailIndex + 1), path];
      const trailIndex = opts.push === false ? s.trailIndex : trail.length - 1;
      this.setSession({
        current: path,
        read: { ...s.read, [path]: nowIso() },
        unread: s.unread.filter((p) => p !== path),
        trail,
        trailIndex,
      });
      const ui = this.state.ui;
      // The split pane keeps its version view and its answer cards; only the main pane changed. The
      // refine status of every page stays: those cards follow the work, not what is being read.
      this.setUi({
        ...initialUi,
        filter: ui.filter,
        unreadOnly: ui.unreadOnly,
        changesOnly: ui.changesOnly,
        map: undefined,
        versionView: { ...initialUi.versionView, split: ui.versionView.split },
        lookups,
        refines: ui.refines,
      });
      await this.refreshVersions(path);
      await this.refreshReview(path);
    } catch (e) {
      this.fail(e);
    }
  }

  async openPage(path: string, placement: Placement) {
    if (!this.state.pages[path]) return;
    if (placement === "active") return this.navigate(path);
    if (placement === "window") {
      if (this.state.folder) await platform.openPageWindow(this.state.folder, path).catch((e) => this.fail(e));
      return;
    }
    if (placement === "background") {
      // For a page that already exists this is a read-later mark, and doing it again clears it.
      const s = this.state.session;
      if (s.current === path || s.split === path) return;
      this.toggleUnread(path);
      return;
    }
    await this.loadBody(path);
    this.dropPaneUi("split");
    this.setSession({ split: path, splitDirection: placement, sidebar: false });
    this.setUi({ versionView: { ...this.state.ui.versionView, split: closedVersionView }, syncScroll: true });
    await this.refreshVersions(path);
  }

  /** Marks a page to read later, or clears the mark if it already carries one. Opening the page clears it too. */
  toggleUnread(path: string) {
    const s = this.state.session;
    if (!this.state.pages[path]) return;
    this.setSession({ unread: s.unread.includes(path) ? s.unread.filter((p) => p !== path) : [...s.unread, path] });
  }

  /**
   * Renames a page: its title, which is what the tree, the maps and the page's own first heading show.
   * The file keeps its name, so the [[wiki links]] and `source` lines that point at it stay good.
   */
  async renamePage(path: string, name: string) {
    const meta = this.state.pages[path];
    const title = name.trim();
    if (!meta || !title || title === meta.title || !this.state.folder) return;
    try {
      const body = await this.loadBody(path);
      const nextBody = renameHeading(body, meta.title, title);
      const next: PageMeta = { ...meta, title };
      await this.writePage(path, nextBody, next);
      this.set({ pages: { ...this.state.pages, [path]: next }, bodies: { ...this.state.bodies, [path]: nextBody } });
      // A session opened from this page is named after it, until it is given a name of its own on Home.
      if (this.state.rootFile === path && !this.state.session.name) {
        this.set({ folderName: title });
        this.touchRecent({ name: title });
      }
    } catch (e) {
      this.fail(e);
    }
  }

  /** Selects a page's file in Finder. */
  async revealPage(path: string) {
    const { folder, rel } = this.loc(path);
    try {
      await platform.revealInFinder(`${folder}/${rel}`);
    } catch (e) {
      this.fail(e);
    }
  }

  /**
   * Deletes a page. The desktop backend parks its file and its snapshots in `.reader/trash` inside the
   * folder the page lives in, rather than removing them, so the delete can still be undone by hand.
   * `dontAskAgain` is the confirmation's checkbox: it turns the confirmation off for good.
   */
  async deletePage(path: string, dontAskAgain = false) {
    if (!this.state.pages[path] || !this.state.folder) return;
    // A page still being written, or with a write waiting behind its timer, would put the file straight back.
    this.stopStream(`page:${path}`);
    this.stopStream(`refine:${path}`);
    window.clearTimeout(this.writeTimers.get(path));
    this.writeTimers.delete(path);
    const { folder, rel } = this.loc(path);
    try {
      await platform.deletePage(folder, rel);
    } catch (e) {
      // The write in flight is stopped either way; with the file still there, the page is simply idle now.
      const s = this.state.session;
      if (s.loading.includes(path)) this.setSession({ loading: s.loading.filter((p) => p !== path) });
      return this.fail(e);
    }
    // The checkbox only counts once the delete itself has gone through.
    if (dontAskAgain && this.state.settings.confirmDelete) void this.saveSettings({ confirmDelete: false });
    // The page a session, or an added root, was opened from takes that root with it.
    if (this.state.rootFile === path) return this.endFileSession();
    const root = (this.state.session.roots ?? []).find((r) => this.rootKey(r) === path);
    if (root) return this.dropRoots((r) => r !== root);
    this.forgetPage(path);
  }

  /** Drops every trace of a page from the open session, once its file is gone. */
  private forgetPage(path: string) {
    const without = <T,>(map: Record<string, T>): Record<string, T> => {
      const next = { ...map };
      delete next[path];
      return next;
    };
    const working = { ...this.state.working };
    delete working[`page:${path}`];
    delete working[`refine:${path}`];
    const s = this.state.session;
    const pages = without(this.state.pages);
    this.chains.delete(path);
    const ui = this.state.ui;
    const refines = { ...ui.refines };
    for (const [id] of this.refinesOn(path)) delete refines[id];
    this.set({
      pages,
      bodies: without(this.state.bodies),
      versions: without(this.state.versions),
      versionBodies: without(this.state.versionBodies),
      reviewBases: without(this.state.reviewBases),
      pageErrors: without(this.state.pageErrors),
      working,
      // A page that is gone takes its refine cards with it.
      ui: { ...ui, refines },
    });
    if (s.split === path) this.closeSplit();
    // The trail keeps its place: the index follows the entries still standing before it.
    const before = s.trail.slice(0, s.trailIndex + 1).filter((p) => p !== path);
    this.setSession({
      read: without(s.read),
      unread: s.unread.filter((p) => p !== path),
      loading: s.loading.filter((p) => p !== path),
      pending: without(s.pending),
      asks: s.asks ? without(s.asks) : undefined,
      trail: s.trail.filter((p) => p !== path),
      trailIndex: before.length - 1,
    });
    if (s.current !== path) return;
    // The page being read is gone: fall back to where the trail now points, or to the newest page left.
    const next = this.state.session.trail[this.state.session.trailIndex] ?? newestPath(pages);
    if (next) void this.navigate(next, { push: false });
    else this.setSession({ current: undefined });
  }

  /** The page a file session was opened from is gone, so the session is too: back to Home, and out of recents. */
  private endFileSession() {
    const recent = this.currentRecent();
    window.clearTimeout(this.saveTimer);
    this.set({
      folder: undefined,
      rootFile: undefined,
      folderName: "",
      pages: {},
      bodies: {},
      session: emptySession(),
      versions: {},
      versionBodies: {},
      reviewBases: {},
      pageErrors: {},
      working: {},
      home: true,
      ui: { ...initialUi },
    });
    if (recent) this.removeRecent(recent);
  }

  /**
   * What a click on a link or tree row does. The modifiers mean the same as on the ask verbs:
   * ⌘ is the New Page placement, ⌘⇧ the Deep Dive placement, ⌥ flips either; a plain click opens here.
   */
  placementFor(e: { metaKey: boolean; shiftKey: boolean; altKey: boolean }): Placement {
    const s = this.state.settings;
    const base: Placement = e.metaKey && e.shiftKey ? s.deepDiveOpens : e.metaKey ? s.newPageOpens : "active";
    return e.altKey ? flipPlacement(base) : base;
  }

  async followWikiLink(target: string, e: { metaKey: boolean; shiftKey: boolean; altKey: boolean }) {
    const path = resolveWikiTarget(target, Object.keys(this.state.pages));
    if (path) {
      await this.openPage(path, this.placementFor(e));
      return;
    }
    // Unknown target: grow a page for it in the background.
    const current = this.state.session.current;
    if (!current) return;
    await this.createPage({ question: target.replace(/[-_]+/g, " "), mode: "deep-dive", placement: "background", sourceText: undefined });
  }

  back() {
    const s = this.state.session;
    if (s.trailIndex <= 0) return;
    const i = s.trailIndex - 1;
    this.setSession({ trailIndex: i });
    void this.navigate(s.trail[i], { push: false });
  }

  forward() {
    const s = this.state.session;
    if (s.trailIndex >= s.trail.length - 1) return;
    const i = s.trailIndex + 1;
    this.setSession({ trailIndex: i });
    void this.navigate(s.trail[i], { push: false });
  }

  closeSplit() {
    this.dropPaneUi("split");
    this.setSession({ split: undefined });
    this.setUi({ fullscreen: false, versionView: { ...this.state.ui.versionView, split: closedVersionView } });
  }

  /** Drops the highlight, its box and the answer cards sitting in `role` when that pane's page changes or the pane closes. */
  private dropPaneUi(role: PaneRole) {
    const ui = this.state.ui;
    const selection = ui.selection?.pane === role;
    const ids = this.lookupIdsIn(role);
    if (!selection && !ids.length) return;
    const lookups = this.closedLookups(ids);
    this.setUi({ ...(selection ? { selection: undefined, popover: undefined } : {}), ...(ids.length ? { lookups } : {}) });
  }

  /** Turns linked scrolling of two panes showing the same page on or off. */
  toggleSyncScroll() {
    this.setUi({ syncScroll: !this.state.ui.syncScroll });
  }

  toggleSidebar() {
    this.setSession({ sidebar: !this.state.session.sidebar });
  }

  /** Shows the sidebar at `px` wide while its edge is being dragged; nothing is saved until `setSidebarWidth`. */
  previewSidebarWidth(px: number) {
    document.documentElement.style.setProperty("--side-width", `${sidebarWidthPx(px)}px`);
  }

  /** Keeps a dragged sidebar width, clamped to its range, with the other settings. */
  async setSidebarWidth(px: number) {
    const settings = { ...this.state.settings, sidebarWidth: sidebarWidthPx(px) };
    this.set({ settings });
    this.applyTheme(settings);
    try {
      await platform.saveSettings(settings);
    } catch (e) {
      this.fail(e);
    }
  }

  private async saveSettings(patch: Partial<Settings>) {
    const settings = { ...this.state.settings, ...patch };
    this.set({ settings });
    try {
      await platform.saveSettings(settings);
    } catch (e) {
      this.fail(e);
    }
  }

  // ---------- the Mac's app for Markdown ----------

  /** Reads which app opens .md files. Quiet on failure: the offer and the row simply stay hidden. */
  async loadDefaultApp() {
    try {
      this.set({ defaultApp: await platform.defaultMarkdownApp() });
    } catch {
      /* no backend answer: nothing to offer */
    }
  }

  /**
   * If a Finder rename happened while Nested was in the background, remap the open session.
   * Quiet: a missing path is retried on the next focus rather than toasted.
   *
   * Page streams and writeTimers keep running. `writePage` / `generatePage` wait while
   * `rematching` is set, so a debounced flush cannot overwrite `rewrite_source_keys`
   * with a stale in-memory `source` (the race `deletePage` stops by cancelling the write).
   */
  private async rematchOpenSession() {
    const folder = this.state.folder;
    const rootFile = this.state.rootFile;
    if (!folder || this.opening || this.rematching) return;
    this.rematching = true;
    try {
      const recent = this.currentRecent();
      const ids = { ...(this.state.session.ids ?? {}), ...idsFromRecent(recent) };
      if (rootFile && recent?.fileId) ids[rootFile] = recent.fileId;
      const resolved = await platform.resolveSession(folder, rootFile, Object.keys(ids).length ? ids : undefined, recent?.bookmark ?? this.lastIdentity.bookmark);
      if (this.opening || this.state.folder !== folder) return;
      const remaps = resolved.remaps ?? [];
      const folderChanged = resolved.folder !== folder;
      const fileChanged = (resolved.file ?? "") !== (rootFile ?? "");
      this.lastIdentity = { folderId: resolved.folderId, fileId: resolved.fileId, bookmark: resolved.bookmark };
      if (!remaps.length && !folderChanged && !fileChanged) {
        if (
          recent &&
          (resolved.folderId !== recent.folderId || resolved.fileId !== recent.fileId || resolved.bookmark !== recent.bookmark)
        ) {
          this.touchRecent({
            folderId: resolved.folderId ?? recent.folderId,
            fileId: resolved.fileId ?? recent.fileId,
            bookmark: resolved.bookmark ?? recent.bookmark,
          });
        }
        return;
      }
      this.applyPathRemaps(remaps, resolved.folder, resolved.file);
      this.rememberSession();
      if (folderChanged && this.state.settings.folder !== resolved.folder) {
        const settings = { ...this.state.settings, folder: resolved.folder };
        this.set({ settings });
        await platform.saveSettings(settings).catch(() => undefined);
      }
    } catch {
      /* Finder rematch is quiet */
    } finally {
      this.rematching = false;
    }
  }

  /** Rewrites in-memory page keys, session paths and `rootFile` after resolve remapped them on disk. */
  private applyPathRemaps(remaps: [string, string][], folder: string, file: string | undefined) {
    const table = new Map(remaps);
    const swap = (path: string) => table.get(path) ?? path;
    const swapKeys = <T,>(map: Record<string, T>, touch?: (key: string, value: T) => T): Record<string, T> => {
      if (!remaps.length) return map;
      const out: Record<string, T> = {};
      for (const [k, v] of Object.entries(map)) {
        const nk = swap(k);
        out[nk] = touch ? touch(nk, v) : v;
      }
      return out;
    };
    const pages = swapKeys(this.state.pages, (key, meta) => ({ ...meta, path: key, source: meta.source ? swap(meta.source) : meta.source }));
    const working: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.state.working)) {
      const nk = k.startsWith("page:") ? `page:${swap(k.slice(5))}` : k.startsWith("refine:") ? `refine:${swap(k.slice(7))}` : k;
      working[nk] = v;
    }
    for (const [from, to] of remaps) {
      if (from === to) continue;
      this.pathRemaps.set(from, to);
      const timer = this.writeTimers.get(from);
      if (timer !== undefined) {
        this.writeTimers.delete(from);
        this.writeTimers.set(to, timer);
      }
      for (const prefix of ["page:", "refine:"] as const) {
        const handle = this.streams.get(prefix + from);
        if (handle) {
          this.streams.delete(prefix + from);
          this.streams.set(prefix + to, handle);
        }
        const release = this.releases.get(prefix + from);
        if (release) {
          this.releases.delete(prefix + from);
          this.releases.set(prefix + to, release);
        }
      }
      // The page's queue travels with it, so the work behind it still takes its turn.
      const chain = this.chains.get(from);
      if (chain) {
        this.chains.delete(from);
        this.chains.set(to, chain);
      }
    }
    const oldFolder = this.state.folder;
    const s = this.state.session;
    const session: Session = {
      ...s,
      current: s.current ? swap(s.current) : s.current,
      split: s.split ? swap(s.split) : s.split,
      trail: s.trail.map(swap),
      unread: s.unread.map(swap),
      loading: s.loading.map(swap),
      read: swapKeys(s.read),
      pending: swapKeys(s.pending),
      asks: s.asks ? swapKeys(s.asks) : s.asks,
      ids: s.ids ? swapKeys(s.ids) : s.ids,
      roots: s.roots?.map((r) => (r.folder === oldFolder ? { folder, file: r.file ? swap(r.file) : r.file } : r)),
    };
    this.set({
      folder,
      rootFile: file,
      pages,
      bodies: swapKeys(this.state.bodies),
      versions: swapKeys(this.state.versions),
      versionBodies: swapKeys(this.state.versionBodies),
      reviewBases: swapKeys(this.state.reviewBases, (key, base) => ({ ...base, path: key })),
      pageErrors: swapKeys(this.state.pageErrors),
      working,
      session,
      // Each refine card names the page it is rewriting, so it follows the rename with the rest.
      ui: { ...this.state.ui, refines: mapValues(this.state.ui.refines, (r) => ({ ...r, path: swap(r.path) })) },
    });
    if (remaps.length) this.persistSession();
  }

  /**
   * Asks the OS to make Nested the app for .md files. macOS 26.4 and later confirm with the user
   * first, so this settles on whatever the system reports afterwards, and stops offering once it is Nested.
   */
  async makeDefaultApp() {
    try {
      const defaultApp = await platform.setDefaultMarkdownApp();
      this.set({ defaultApp });
      if (defaultApp.isNested) await this.saveSettings({ offerDefaultApp: false });
    } catch (e) {
      this.fail(e);
      void this.loadDefaultApp();
    }
  }

  /** Not now: the Home screen stops offering. The row in Settings › General stays. */
  dismissDefaultAppOffer() {
    void this.saveSettings({ offerDefaultApp: false });
  }

  // ---------- app updates ----------

  /**
   * Asks the update server for a newer release. The launch and timer checks are quiet: a
   * failure shows nothing, and no update shows nothing. From the menu (`manual`), both get a word,
   * and an update that was put off with Later comes back.
   */
  async checkForUpdate(manual = false) {
    const u = this.state.update;
    if (u.phase === "downloading" || u.phase === "installing" || u.phase === "checking") return;
    if (u.phase === "available" && !manual) return;
    this.set({ update: { ...u, phase: "checking", message: undefined } });
    try {
      const found = await platform.checkForUpdate();
      if (found.update) {
        this.set({ update: { phase: "available", current: found.current, version: found.update.version, notes: found.update.notes, dismissed: manual ? false : u.dismissed } });
      } else {
        this.set({ update: { phase: "idle", current: found.current } });
        if (manual) this.notify(found.supported ? `You're on the latest version, Nested ${found.current}.` : "Updates arrive in the built app, not this preview.");
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.set({ update: manual ? { phase: "error", current: u.current, message } : { phase: "idle", current: u.current } });
    }
  }

  /** Downloads and installs the update the bar offers, then relaunches. */
  async installUpdate() {
    const u = this.state.update;
    if (u.phase !== "available" && u.phase !== "error") return;
    if (!u.version) return void this.checkForUpdate(true);
    this.set({ update: { ...u, phase: "downloading", downloaded: 0, total: undefined, message: undefined, dismissed: false } });
    try {
      await platform.installUpdate((p) => {
        if (p.type === "progress") this.set({ update: { ...this.state.update, phase: "downloading", downloaded: p.downloaded, total: p.total ?? undefined } });
        else this.set({ update: { ...this.state.update, phase: "installing" } });
      });
      this.set({ update: { ...this.state.update, phase: "installing" } });
      await platform.relaunch();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.set({ update: { ...this.state.update, phase: "error", message } });
    }
  }

  /** Later: the bar goes away until the next launch, or until Check for Updates… in the menu. */
  dismissUpdate() {
    this.set({ update: { ...this.state.update, dismissed: true } });
  }

  /** Closes a sidebar folder, or opens it again. */
  toggleFolder(dir: string) {
    const list = this.state.session.collapsed ?? [];
    this.setSession({ collapsed: list.includes(dir) ? list.filter((d) => d !== dir) : [...list, dir] });
  }

  /** Opens every folder on the way to `path`, so the row for it can be seen. */
  revealInTree(path: string) {
    const list = this.state.session.collapsed ?? [];
    if (!list.length) return;
    const chain = folderChain(dirOf(path), this.rootDirs());
    const next = list.filter((d) => !chain.includes(d));
    if (next.length !== list.length) this.setSession({ collapsed: next });
  }

  setFilter(filter: string) {
    this.setUi({ filter });
  }

  toggleUnreadOnly() {
    this.setUi({ unreadOnly: !this.state.ui.unreadOnly });
  }

  toggleChangesOnly() {
    this.setUi({ changesOnly: !this.state.ui.changesOnly });
  }

  /** Switches a tree filter off. The sidebar calls this when the filter has nothing left to show, so the tree comes back instead of sitting empty. */
  clearTreeFilter(kind: "unread" | "changes") {
    const ui = this.state.ui;
    if (kind === "unread" ? ui.unreadOnly : ui.changesOnly) this.setUi(kind === "unread" ? { unreadOnly: false } : { changesOnly: false });
  }

  /** Shows the tree if it is hidden and puts the cursor in its Filter box (/ or ⌘/). */
  focusFilter() {
    if (!this.state.session.sidebar) this.setSession({ sidebar: true });
    this.setUi({ filterFocus: this.state.ui.filterFocus + 1 });
  }

  // ---------- find in page ----------

  /** Opens the find bar, or refocuses it. A fresh selection becomes the query, as "use selection for find" would. */
  openFind() {
    const ui = this.state.ui;
    const at = ui.selection;
    const card = at ? ui.lookups[lookupId(at.pane, at.block)] : undefined;
    const fromSelection = !ui.find && ui.popover === "ask" && !card ? at?.text : undefined;
    if (fromSelection && fromSelection.length <= 200) {
      this.closePopover();
      this.setUi({ find: true, findQuery: fromSelection, findIndex: 0, findFocus: ui.findFocus + 1, versionView: this.closedMenus() });
      return;
    }
    this.setUi({ find: true, findFocus: ui.findFocus + 1, versionView: this.closedMenus() });
  }

  closeFind() {
    this.setUi({ find: false });
  }

  setFindQuery(findQuery: string) {
    this.setUi({ findQuery, findIndex: 0 });
  }

  /** Moves to the next (1) or previous (-1) match and selects it; the page wraps the index around the match count. */
  findStep(dir: 1 | -1) {
    const ui = this.state.ui;
    if (!ui.find) return this.openFind();
    if (!ui.findQuery.trim()) return this.setUi({ findFocus: ui.findFocus + 1 });
    this.setUi({ findIndex: ui.findIndex + dir, findSelect: ui.findSelect + 1 });
  }

  /** ↵ in the find box: the current match becomes the selection, so a question or refinement can follow. */
  findSelectCurrent() {
    const ui = this.state.ui;
    if (!ui.find || !ui.findQuery.trim()) return;
    this.setUi({ findSelect: ui.findSelect + 1 });
  }

  /** The page calls this with the current match once it is on screen. The refine box stays if that is what was open. */
  selectMatch(selection: Selection) {
    const popover = this.state.ui.popover === "refine" ? "refine" : "ask";
    this.setUi({ selection, popover, panePopover: undefined, versionView: this.closedMenus(), ...this.withoutSelectionFailure(this.panePath(selection.pane)) });
  }

  openMap(kind: "web" | "timeline") {
    this.setUi({ map: kind, popover: undefined, selection: undefined, panePopover: undefined, versionView: this.closedMenus() });
  }

  closeMap() {
    this.setUi({ map: undefined });
  }

  // ---------- selection & popovers ----------

  setSelection(selection: Selection | undefined) {
    if (!selection) {
      if (this.state.ui.popover) this.setUi({ selection: undefined, popover: undefined });
      return;
    }
    // The cards keep streaming; only the one peeked at from hover gives way to a fresh highlight.
    this.setUi({
      selection,
      popover: "ask",
      panePopover: undefined,
      lookups: this.withoutPeek(),
      versionView: this.closedMenus(),
      ...this.withoutSelectionFailure(this.panePath(selection.pane)),
    });
  }

  closePopover() {
    const at = this.state.ui.selection;
    this.setUi({ popover: undefined, selection: undefined, panePopover: undefined, refineRetry: undefined, ...this.withoutSelectionFailure(at && this.panePath(at.pane)) });
  }

  /** Esc on a refine status card: a failure is dismissed; a refine still running keeps its card. */
  dismissRefine(id: string) {
    const refines = { ...this.state.ui.refines };
    if (refines[id]?.error) delete refines[id];
    this.setUi({ popover: undefined, selection: undefined, panePopover: undefined, refines });
  }

  /**
   * A failed selection refine's card hangs off the highlight it was asked from, so it goes when that
   * highlight does. Cards for refines still running, and the pane-level ones, are left standing.
   */
  private withoutSelectionFailure(path: string | undefined): Partial<UiState> {
    if (!path) return {};
    const stale = this.refinesOn(path).filter(([, r]) => r.scope === "selection" && r.error);
    if (!stale.length) return {};
    const refines = { ...this.state.ui.refines };
    for (const [id] of stale) delete refines[id];
    return { refines };
  }

  /** Hides one answer card. The answer is not lost: it stays under a dotted line on the text it was asked about. */
  closeLookup(id: string) {
    const cur = this.state.ui.lookups[id];
    if (!cur) return;
    const lookups = this.closedLookups([id]);
    const at = this.state.ui.selection;
    const onIt = at?.pane === cur.pane && at.block === cur.block;
    this.setUi({ lookups, ...(onIt ? { selection: undefined, popover: undefined } : {}) });
  }

  /** Stops one running answer, keeping whatever has streamed in so far so nothing that was read disappears. */
  private dropLookup(id: string) {
    const cur = this.state.ui.lookups[id];
    if (!cur) return;
    if (cur.streaming) this.stopStream(`lookup:${id}`);
    this.rememberLookup(cur);
  }

  /** Stops and files away the cards `ids` names, and gives back the cards left standing. */
  private closedLookups(ids: string[]): Record<string, Lookup> {
    for (const id of ids) this.dropLookup(id);
    const lookups = { ...this.state.ui.lookups };
    for (const id of ids) delete lookups[id];
    return lookups;
  }

  /** The cards sitting in one pane. */
  private lookupIdsIn(role: PaneRole): string[] {
    return Object.entries(this.state.ui.lookups)
      .filter(([, l]) => l.pane === role)
      .map(([id]) => id);
  }

  /** Only one remembered ask is peeked at from hover at a time; the streaming cards are many. */
  private withoutPeek(): Record<string, Lookup> {
    const ui = this.state.ui;
    const out: Record<string, Lookup> = {};
    for (const [id, l] of Object.entries(ui.lookups)) if (!l.peek) out[id] = l;
    return out;
  }

  /** The card Esc answers for: the peeked one, else the one opened last. */
  private topLookupId(): string | undefined {
    const ids = Object.keys(this.state.ui.lookups);
    return ids.find((id) => this.state.ui.lookups[id].peek) ?? ids[ids.length - 1];
  }

  /**
   * Files an answered ask under its page, keyed on the text it was asked about, so a follow-up
   * replaces the earlier exchange rather than sitting beside it.
   */
  private rememberLookup(lookup: Lookup) {
    const path = this.panePath(lookup.pane);
    if (!path || !lookup.anchor || !lookup.answer.trim() || lookup.error) return;
    const { start, end, text } = lookup.anchor;
    const ask: Ask = { block: lookup.block, start, end, text, thread: lookup.thread, question: lookup.question, answer: lookup.answer };
    const asks = this.state.session.asks ?? {};
    const list = asks[path] ?? [];
    // Matched on the text alone: a refine may have moved it to another block since it was first asked about.
    const at = list.findIndex((a) => a.text === text);
    const next = at >= 0 ? list.map((a, i) => (i === at ? ask : a)) : [...list, ask];
    this.setSession({ asks: { ...asks, [path]: next } });
  }

  /**
   * Reopens a remembered ask on its text. Peeked (from hover) the card goes away when the pointer leaves;
   * opened (from a click) it stays until Esc. `block`, `start` and `end` are where the page found the text now.
   */
  showAsk(pane: PaneRole, ask: Ask, at: { block: number; start: number; end: number }, peek: boolean) {
    const ui = this.state.ui;
    const id = lookupId(pane, at.block);
    const held = ui.lookups[id];
    // An answer still streaming, or one opened on purpose, is not taken over.
    if (held?.streaming) return;
    if (peek && held && !held.peek) return;
    if (ui.popover || ui.panePopover) return;
    const path = this.panePath(pane);
    if (!path) return;
    const body = this.state.bodies[path] ?? "";
    const paragraph = lexBlocks(body)[at.block]?.text ?? ask.text;
    const lookup: Lookup = { pane, block: at.block, anchor: { ...at, text: ask.text }, thread: ask.thread, question: ask.question, answer: ask.answer, streaming: false, peek };
    const selection: Selection = { pane, block: at.block, start: at.start, end: at.end, text: ask.text, paragraph, caretX: 0 };
    this.setUi({ lookups: { ...this.withoutPeek(), [id]: lookup }, selection, popover: undefined, versionView: this.closedMenus() });
  }

  /** A peeked card the pointer has left: closes it unless it was pinned by a click in the meantime. */
  hideAskPeek() {
    if (!Object.values(this.state.ui.lookups).some((l) => l.peek)) return;
    this.setUi({ lookups: this.withoutPeek(), selection: undefined });
  }

  /** Keeps a peeked card open after a click on it or its text, so a follow-up can be typed. */
  pinAsk(id: string) {
    const cur = this.state.ui.lookups[id];
    if (cur?.peek) this.setUi({ lookups: { ...this.state.ui.lookups, [id]: { ...cur, peek: false } } });
  }

  toggleRefine() {
    const ui = this.state.ui;
    if (ui.selection && ui.popover === "ask") return this.setUi({ popover: "refine" });
    if (ui.popover === "refine") return this.setUi({ popover: "ask" });
    // The refine box takes the place of the card on this highlight; cards on other blocks stay.
    const id = ui.selection ? lookupId(ui.selection.pane, ui.selection.block) : undefined;
    if (id && ui.lookups[id]) return this.setUi({ popover: "refine", lookups: this.closedLookups([id]) });
    // Opened by hand rather than by Try again, so the box starts empty.
    this.setUi({ panePopover: ui.panePopover === "refine" ? undefined : "refine", popover: undefined, selection: undefined, refineRetry: undefined });
  }

  /** ⌘N: the box for a new page written from the whole session. Pressing it again closes the box. */
  toggleNewFile() {
    const ui = this.state.ui;
    if (!this.state.session.current) return;
    this.setUi({ panePopover: ui.panePopover === "new" ? undefined : "new", popover: undefined, selection: undefined, lookups: this.withoutPeek() });
  }

  /** The Send feedback link at the bottom of the sidebar. Clicking it again closes the box. */
  toggleFeedback() {
    const ui = this.state.ui;
    this.setUi({ panePopover: ui.panePopover === "feedback" ? undefined : "feedback", popover: undefined, selection: undefined, lookups: this.withoutPeek() });
  }

  /** Sends the note; the box shows the rejection's message when it fails. */
  sendFeedback(message: string, email: string) {
    return platform.sendFeedback(message, email);
  }

  /** Reopens the refine box on the instruction a failed attempt was carrying, and retires its card. */
  retryRefine(id: string) {
    const ui = this.state.ui;
    const run = ui.refines[id];
    if (!run?.error) return;
    const refines = { ...ui.refines };
    delete refines[id];
    if (run.scope === "selection" && ui.selection) return this.setUi({ refines, popover: "refine" });
    this.setUi({ refines, refineRetry: run.text, panePopover: "refine", popover: undefined, selection: undefined });
  }

  escape() {
    const ui = this.state.ui;
    if (this.state.home) return this.leaveHome();
    // The pane being read answers first: the split when it is fullscreen, else the main pane.
    const roles: PaneRole[] = ui.fullscreen && this.state.session.split ? ["split", "main"] : ["main", "split"];
    for (const role of roles) if (ui.versionView[role].confirmRestore) return this.cancelRestore(role);
    for (const role of roles) if (ui.versionView[role].history) return this.setVersionView(role, { history: false });
    for (const role of roles) if (ui.versionView[role].viewing !== undefined) return this.backToCurrent(role);
    if (ui.popover || ui.panePopover) return this.closePopover();
    // A failure card belongs to a page, so this dismisses the one on the page being read.
    for (const role of roles) {
      const path = this.panePath(role);
      const failed = path ? this.refinesOn(path).find(([, r]) => r.error) : undefined;
      if (failed) return this.dismissRefine(failed[0]);
    }
    const top = this.topLookupId();
    if (top) return this.closeLookup(top);
    if (ui.find) return this.closeFind();
    if (ui.map) return this.closeMap();
    if (ui.fullscreen) return this.setUi({ fullscreen: false });
  }

  // ---------- AI plumbing ----------

  /**
   * Runs `task` after whatever this page already has in hand, and gives back when it is done. Pages
   * hold a chain each, so writing one page and refining another run at once while two pieces of work
   * on the same page take their turn: a refine asked for mid-generation reads the finished body.
   */
  private queue(path: string, task: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(path) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(task);
    this.chains.set(path, next);
    // Nothing behind it: the chain is dropped, so the map does not keep an entry per page ever touched.
    void next.catch(() => {}).then(() => {
      if (this.chains.get(path) === next) this.chains.delete(path);
    });
    return next;
  }

  /**
   * The settle half of a queued stream task: `finish()` when the stream ends, `finish(err)` when it
   * failed, and the same call is left with `releases` so a cancel lets the page's chain move on.
   */
  private settler(key: string, resolve: () => void, reject: (e: unknown) => void) {
    let settled = false;
    const finish = (err?: unknown) => {
      if (settled) return;
      settled = true;
      if (this.releases.get(key) === finish) this.releases.delete(key);
      if (err === undefined) resolve();
      else reject(err instanceof Error ? err : new Error(String(err)));
    };
    return {
      finish,
      /** Called once the stream is running; a stream that failed on the spot needs no release. */
      watch: () => {
        if (!settled) this.releases.set(key, finish);
      },
    };
  }

  private request(system: string, messages: ChatMessage[], maxTokens?: number, kind?: string): AiRequest {
    const s = this.state.settings;
    const auth = authFor(s, s.provider);
    // Only the providers with a server field carry a base URL; OpenAI and Anthropic go to their own hosts.
    const baseUrl = s.provider === "ollama" ? s.ollamaUrl : s.provider === "custom" ? s.baseUrl : undefined;
    // With tools on, the request names the session folder so the model can read its pages itself.
    const folder = s.tools ? this.state.folder : undefined;
    const roots = folder ? this.rootDirs() : undefined;
    return { provider: s.provider, auth, model: s.models[modelSlot(s.provider, auth)], baseUrl: baseUrl || undefined, system, messages, maxTokens, folder, roots: roots?.length ? roots : undefined, kind };
  }

  private stream(key: string, req: AiRequest, on: { delta: (t: string) => void; done: () => void; error: (m: string) => void }) {
    this.stopStream(key);
    if (req.provider === "builtin") {
      on.error("The built-in plan is not available in this build. Choose a provider in Settings › AI.");
      return;
    }
    if (!req.model) {
      on.error("Choose a model in Settings › AI.");
      return;
    }
    const handle = platform.aiStream(req, (e) => {
      if (e.type === "delta") {
        // Text after a tool call means the model has moved on from looking things up.
        if (this.state.working[key]) this.setWorking(key, undefined);
        on.delta(e.text);
      } else if (e.type === "tool") {
        this.setWorking(key, e.detail);
      } else if (e.type === "done") {
        this.streams.delete(key);
        this.setWorking(key, undefined);
        on.done();
      } else {
        this.streams.delete(key);
        this.setWorking(key, undefined);
        on.error(e.message);
      }
    });
    this.streams.set(key, handle);
  }

  private stopStream(key: string) {
    this.streams.get(key)?.cancel();
    this.streams.delete(key);
    // A cancelled stream sends no last event, so the task waiting on it is let go here.
    this.releases.get(key)?.();
    if (this.state.working[key]) this.setWorking(key, undefined);
  }

  private setWorking(key: string, detail: string | undefined) {
    const working = { ...this.state.working };
    if (detail) working[key] = detail;
    else delete working[key];
    this.set({ working });
  }

  private async askContext(selection?: Pick<Selection, "text" | "paragraph">, thread?: Lookup["thread"], pagePath?: string): Promise<AskContext | null> {
    const current = pagePath ?? this.state.session.current;
    if (!current) return null;
    const body = await this.loadBody(current);
    const settings = this.state.settings;
    const session: AskContext["session"] = [];
    const folder: AskContext["folder"] = [];
    const inSession = new Set<string>();
    if (settings.context.session) {
      for (const p of sessionPages(current, this.state.pages).slice(0, 12)) {
        inSession.add(p.path);
        session.push({ meta: p, body: await this.loadBody(p.path) });
      }
    }
    if (settings.context.folder) {
      for (const p of Object.values(this.state.pages)) {
        if (p.path === current || inSession.has(p.path)) continue;
        folder.push({ meta: p, body: await this.loadBody(p.path) });
      }
    }
    return {
      page: { meta: this.state.pages[current], body },
      selection: selection?.text,
      paragraph: selection?.paragraph,
      session,
      folder,
      settings,
      thread,
    };
  }

  /**
   * Runs the verb chosen in the ask popover or the inline card. `from` is the card a follow-up was
   * typed into, so the answer lands back in that card rather than wherever the highlight has moved on to.
   */
  async ask(question: string, verb: Verb, alt = false, from?: string) {
    const ui = this.state.ui;
    const selection = ui.selection;
    const card = from ? ui.lookups[from] : undefined;
    if (verb === "quick") return this.quickAnswer(question, selection, card);
    const mode = verb === "deep" ? "deep-dive" : "new-page";
    const preferred = verb === "deep" ? this.state.settings.deepDiveOpens : this.state.settings.newPageOpens;
    const placement = alt ? flipPlacement(preferred) : preferred;
    // The page grows from the page the highlight (or the answer card) is in, which may be the split pane's.
    const source = this.panePath(selection?.pane ?? card?.pane ?? "main");
    await this.createPage({ question, mode, placement, source, sourceText: selection?.text, block: selection?.block ?? card?.block });
  }

  private async quickAnswer(question: string, selection: Selection | undefined, existing?: Lookup) {
    // A follow-up belongs to the card it was typed into; a fresh ask to the highlight it was asked from.
    const block = existing?.block ?? selection?.block;
    const pane = existing?.pane ?? selection?.pane;
    if (block === undefined || !pane) return;
    const id = lookupId(pane, block);
    const thread = existing ? (existing.answer ? [...existing.thread, { question: existing.question, answer: existing.answer }] : existing.thread) : [];
    const q = question || (selection ? `Explain: ${selection.text}` : "");
    const anchor = existing ? existing.anchor : selection ? { start: selection.start, end: selection.end, text: selection.text } : undefined;
    const lookup: Lookup = { pane, block, anchor, thread, question: q, answer: "", streaming: true };
    this.setUi({ lookups: { ...this.state.ui.lookups, [id]: lookup }, popover: undefined, selection: existing ? this.state.ui.selection : selection, panePopover: undefined });
    try {
      const ctx = await this.askContext(selection ?? this.state.ui.selection, thread, this.panePath(pane));
      if (!ctx) return;
      const { system, messages } = quickAnswerMessages(ctx, q);
      // The card's own stream key, so a second ask elsewhere never cancels this one.
      this.stream(`lookup:${id}`, this.request(system, messages, 400, "quick_answer"), {
        delta: (t) => this.patchLookup(id, (cur) => ({ ...cur, answer: cur.answer + t })),
        done: () => {
          const finished = this.patchLookup(id, (cur) => ({ ...cur, streaming: false }));
          if (finished) this.rememberLookup(finished);
        },
        error: (m) => this.patchLookup(id, (cur) => ({ ...cur, streaming: false, error: m })),
      });
    } catch (e) {
      this.fail(e);
    }
  }

  /** Rewrites one card, if it is still on show; a card closed mid-stream simply stops being updated. */
  private patchLookup(id: string, patch: (cur: Lookup) => Lookup): Lookup | undefined {
    const cur = this.state.ui.lookups[id];
    if (!cur) return undefined;
    const next = patch(cur);
    this.setUi({ lookups: { ...this.state.ui.lookups, [id]: next } });
    return next;
  }

  /**
   * ⌘N: a page written from the reader's brief with the whole session as context. There is no
   * highlight and nothing is linked; the page hangs off the current one so it belongs to the session.
   * ↵ opens it here, ⌘↵ follows the New Page placement, ⌘⇧↵ writes a Deep Dive; ⌥ flips the placement.
   */
  async newFile(brief: string, verb: NewFileVerb, alt = false) {
    if (!brief.trim()) return;
    const s = this.state.settings;
    const mode = verb === "deep" ? "deep-dive" : "new-page";
    const preferred: Placement = verb === "deep" ? s.deepDiveOpens : verb === "page" ? s.newPageOpens : "active";
    const placement = alt ? flipPlacement(preferred) : preferred;
    await this.createPage({ question: brief, mode, placement, from: "session" });
  }

  async createPage(opts: { question: string; mode: "new-page" | "deep-dive"; placement: Placement; source?: string; sourceText?: string; block?: number; from?: PageOrigin }) {
    const { folder, session, settings, pages } = this.state;
    // The new page hangs off `source`: the page the highlight was in, or the main page when nothing says otherwise.
    const current = opts.source ?? session.current;
    if (!folder || !current || !pages[current]) return;
    const sourceText = opts.sourceText?.trim();
    const question = opts.question.trim() || (sourceText ? sourceText : "");
    const title = titleFromQuestion(question || pages[current].title);
    const path = uniquePath(slugify(title), new Set(Object.keys(pages)), settings.newPagesSubfolder);
    const slug = path.replace(/\.md$/, "").split("/").pop() ?? path;
    const meta: PageMeta = { path, title, source: current, question: question || undefined, created: nowIso(), mode: opts.mode };
    const heading = `# ${title}\n\n`;
    try {
      await platform.writePage(folder, path, serializePage(meta, heading));
      this.set({ pages: { ...this.state.pages, [path]: meta }, bodies: { ...this.state.bodies, [path]: heading } });
      // Link the source text to the new page so the file itself remembers the branch.
      if (sourceText && opts.block !== undefined) await this.linkSelection(current, opts.block, sourceText, slug);
      this.setSession({ loading: [...this.state.session.loading, path] });
      // The answer cards keep streaming: starting a page no longer cancels the ask it grew out of.
      this.setUi({ popover: undefined, selection: undefined, panePopover: undefined });
      if (opts.placement === "active") await this.navigate(path);
      else if (opts.placement === "beside" || opts.placement === "below") {
        this.setSession({ split: path, splitDirection: opts.placement, sidebar: false });
      } else if (opts.placement === "window") {
        await platform.openPageWindow(folder, path);
      }
      await this.generatePage(path, { sourcePath: current, question, mode: opts.mode, sourceText, block: opts.block, from: opts.from });
    } catch (e) {
      this.fail(e);
    }
  }

  /**
   * Streams a page's text from the model, in that page's turn, and gives back once the stream has
   * ended: a refine asked for while the page is being written waits here for the finished body.
   */
  private generatePage(
    path: string,
    opts: { sourcePath: string; question: string; mode: "new-page" | "deep-dive"; sourceText?: string; block?: number; from?: PageOrigin },
  ): Promise<void> {
    return this.queue(path, () => this.runGeneratePage(path, opts));
  }

  /**
   * One page's turn at being written. On failure the page keeps its heading and the
   * error is remembered, so the page shows a retry instead of silently staying empty.
   */
  private runGeneratePage(
    path: string,
    opts: { sourcePath: string; question: string; mode: "new-page" | "deep-dive"; sourceText?: string; block?: number; from?: PageOrigin },
  ): Promise<void> {
    const key = `page:${path}`;
    return new Promise<void>((resolve, reject) => {
      const { finish, watch } = this.settler(key, resolve, reject);
      void (async () => {
        const folder = this.state.folder;
        if (!folder) return finish();
        const title = this.state.pages[path]?.title ?? opts.question;
        const heading = `# ${title}\n\n`;
        const selection = opts.sourceText
          ? { block: opts.block ?? 0, start: 0, end: 0, text: opts.sourceText, paragraph: this.paragraphOf(opts.sourcePath, opts.block), caretX: 0 }
          : undefined;
        const ctx = await this.askContext(selection, undefined, opts.sourcePath);
        if (!ctx) return finish();
        const deep = opts.mode === "deep-dive";
        const { system, messages } = opts.from === "session" ? newFileMessages(ctx, opts.question, deep) : newPageMessages(ctx, opts.question, deep);
        const kind = opts.mode === "deep-dive" ? "deep_dive" : "new_page";
        let text = "";
        const flush = (final: boolean) => {
          const dest = this.livePath(path);
          const body = text.trim().startsWith("#") ? text : heading + text;
          this.set({ bodies: { ...this.state.bodies, [dest]: body } });
          const write = () => {
            // Hold the disk write until rematch has updated in-memory `source`, then re-read meta.
            if (this.rematching) {
              window.clearTimeout(this.writeTimers.get(dest));
              this.writeTimers.set(
                dest,
                window.setTimeout(() => {
                  this.writeTimers.delete(this.livePath(path));
                  write();
                }, 100),
              );
              return;
            }
            const at = this.livePath(path);
            const live = this.state.pages[at];
            if (!live) return;
            const t = titleFromBody(body, title);
            const m: PageMeta = { ...live, title: t };
            this.set({ pages: { ...this.state.pages, [at]: m } });
            void this.writePage(at, body, m).catch((e) => this.fail(e));
          };
          if (final) {
            window.clearTimeout(this.writeTimers.get(dest));
            this.writeTimers.delete(dest);
            write();
          } else if (!this.writeTimers.has(dest)) {
            this.writeTimers.set(
              dest,
              window.setTimeout(() => {
                this.writeTimers.delete(this.livePath(path));
                write();
              }, 500),
            );
          }
        };
        const stopLoading = () => {
          const s = this.state.session;
          const at = this.livePath(path);
          this.setSession({ loading: s.loading.filter((p) => p !== at && p !== path) });
        };
        this.stream(key, this.request(system, messages, opts.mode === "deep-dive" ? 2400 : 1200, kind), {
          delta: (t) => {
            text += t;
            flush(false);
          },
          done: () => {
            flush(true);
            const at = this.livePath(path);
            const s = this.state.session;
            const visible = s.current === at || s.split === at;
            this.setSession({ loading: s.loading.filter((p) => p !== at && p !== path), unread: visible || s.unread.includes(at) ? s.unread : [...s.unread, at] });
            if (this.state.pageErrors[at] || this.state.pageErrors[path]) {
              const errors = this.withoutPageError(at);
              delete errors[path];
              this.set({ pageErrors: errors });
            }
            finish();
          },
          error: (m) => {
            flush(true);
            stopLoading();
            const at = this.livePath(path);
            this.set({ pageErrors: { ...this.state.pageErrors, [at]: m } });
            const s = this.state.session;
            if (s.current !== at && s.split !== at) this.fail(`Couldn't write "${title}": ${m}`);
            finish();
          },
        });
        watch();
      })().catch(finish);
    });
  }

  private withoutPageError(path: string): Record<string, string> {
    const errors = { ...this.state.pageErrors };
    delete errors[path];
    return errors;
  }

  /** Writes a page the model failed to write, using the question and highlight its source page still holds. */
  async retryPage(path: string) {
    const meta = this.state.pages[path];
    const source = meta?.source;
    if (!meta || !source || !this.state.pages[source] || !this.state.folder) return;
    if (this.state.session.loading.includes(path)) return;
    try {
      const sourceBody = await this.loadBody(source);
      const slug = path.replace(/\.md$/, "").split("/").pop() ?? path;
      const link = findWikiLink(sourceBody, slug);
      this.set({ pageErrors: this.withoutPageError(path) });
      this.setSession({ loading: [...this.state.session.loading, path] });
      // No link in the source means the page was started from the session (⌘N), not from a highlight.
      await this.generatePage(path, {
        sourcePath: source,
        question: meta.question ?? meta.title,
        mode: meta.mode === "deep-dive" ? "deep-dive" : "new-page",
        sourceText: link?.text,
        block: link?.block,
        from: link ? undefined : "session",
      });
    } catch (e) {
      this.fail(e);
    }
  }

  private paragraphOf(path: string, block: number | undefined): string {
    if (block === undefined) return "";
    const blocks = lexBlocks(this.state.bodies[path] ?? "");
    return blocks[block]?.text ?? "";
  }

  private async linkSelection(path: string, block: number, text: string, slug: string) {
    const body = this.state.bodies[path];
    if (body === undefined || !this.state.folder) return;
    const blocks = lexBlocks(body);
    const b = blocks[block];
    if (!b) return;
    const raw = linkTextInRaw(b.raw, text, slug);
    if (!raw) return;
    blocks[block] = { ...b, raw };
    const next = joinBlocks(blocks);
    this.set({ bodies: { ...this.state.bodies, [path]: next } });
    await this.writePage(path, next);
  }

  // ---------- refine & review ----------

  async refine(instruction: string, scope: RefineScope) {
    const { session, folder } = this.state;
    const highlight = this.state.ui.selection;
    // The box under a highlight acts on the page of the pane the highlight is in; the pane-level box (⌘R) acts on the main page.
    const current = highlight ? this.panePath(highlight.pane) : session.current;
    if (!folder || !current || !instruction.trim()) return;
    if (scope === "selection" && !highlight) return;
    // A corpus refine touches every page of the session, but reads as the one thing it was asked for,
    // so it keeps a single status card on the page it was asked from while the pages refine at once.
    const targets = scope === "corpus" ? [current, ...sessionPages(current, this.state.pages).map((p) => p.path)] : [current];
    // This refine's own card, so it keeps its scope and its instruction whatever is asked for next.
    const id = `refine#${++this.refineSeq}`;
    this.setUi({ refines: { ...this.state.ui.refines, [id]: { path: current, scope, text: instruction } }, popover: undefined, panePopover: undefined });
    const selection = scope === "selection" ? highlight : undefined;
    const failures = await Promise.all(
      targets.map((path) => this.refinePage(path, instruction, path === current ? selection : undefined).then(() => undefined, (e) => (e instanceof Error ? e.message : String(e)))),
    );
    const message = failures.find((m) => m);
    const held = this.state.ui.refines[id];
    const refines = { ...this.state.ui.refines };
    // The failure is shown where the refine box was, with the text kept for a retry. A card dismissed
    // while it ran stays gone.
    if (message && held) refines[id] = { ...held, error: message };
    else delete refines[id];
    this.setUi({ refines });
    // The highlight the refine ran on goes once it has landed, unless it has moved on since.
    if (!message && highlight && this.state.ui.selection === highlight) this.setUi({ selection: undefined, popover: undefined });
  }

  /** The refines on one page, oldest first: the page's chain runs them in that order. */
  private refinesOn(path: string): [string, RefineRun][] {
    return Object.entries(this.state.ui.refines).filter(([, r]) => r.path === path);
  }

  private refinePage(path: string, instruction: string, selection: Selection | undefined): Promise<void> {
    // In the page's own turn: a refine asked for during a generation, or behind another refine,
    // waits here and then rewrites the finished body.
    return this.queue(path, () => this.runRefine(path, instruction, selection));
  }

  private runRefine(path: string, instruction: string, selection: Selection | undefined): Promise<void> {
    const key = `refine:${path}`;
    return new Promise<void>((resolve, reject) => {
      const { finish, watch } = this.settler(key, resolve, reject);
      void (async () => {
        if (!this.state.folder) return finish();
        const body = await this.loadBody(path);
        const blocks = lexBlocks(body);
        const target = selection ? selection.text : body;
        const ctx = await this.askContext(selection, undefined, path);
        if (!ctx) return finish();
        const { system, messages } = refineMessages({ ...ctx, page: { meta: this.state.pages[path], body } }, instruction, selection ? "selection" : "page", target);
        let out = "";
        this.stream(key, this.request(system, messages, selection ? 800 : 4000, "refine"), {
          delta: (t) => {
            out += t;
          },
          done: () => {
            void (async () => {
              try {
                let next: string;
                const cleaned = stripFences(out).trim();
                if (selection) {
                  const b = blocks[selection.block];
                  const raw = b ? replaceFlexible(b.raw, selection.text, cleaned) : null;
                  if (!b || raw === null) throw new Error("Could not find the selection in the page source.");
                  blocks[selection.block] = { ...b, raw };
                  next = joinBlocks(blocks);
                } else {
                  next = cleaned.endsWith("\n") ? cleaned : cleaned + "\n";
                }
                if (next.trim() === body.trim()) return finish();
                const { folder: root, rel } = this.loc(path);
                const n = await platform.snapshotVersion(root, rel);
                await this.writePage(path, next);
                this.set({ bodies: { ...this.state.bodies, [path]: next } });
                // Refines stacked on one page read as one set of edits: the review stays pinned to the
                // snapshot the first of them took, so the strip counts every change since.
                const pending = this.state.session.pending;
                if (pending[path] === undefined) this.setSession({ pending: { ...pending, [path]: n } });
                if (this.isShown(path)) await this.refreshVersions(path);
                // Every changed page gets its review base, so the split pane and later visits show the tints.
                await this.refreshReview(path);
              } catch (e) {
                finish(e);
                return;
              }
              finish();
            })();
          },
          error: (m) => finish(new Error(m)),
        });
        watch();
      })().catch(finish);
    });
  }

  private withoutReview(path: string): Record<string, ReviewBase> {
    const bases = { ...this.state.reviewBases };
    delete bases[path];
    return bases;
  }

  private async refreshReview(path: string) {
    const n = this.state.session.pending[path];
    if (!n || !this.state.folder) {
      if (this.state.reviewBases[path]) this.set({ reviewBases: this.withoutReview(path) });
      return;
    }
    if (this.state.reviewBases[path]?.n === n) return;
    try {
      const { folder, rel } = this.loc(path);
      const raw = await platform.readVersion(folder, rel, n);
      this.set({ reviewBases: { ...this.state.reviewBases, [path]: { path, n, body: stripFrontMatter(raw) } } });
    } catch {
      const pending = { ...this.state.session.pending };
      delete pending[path];
      this.setSession({ pending });
      this.set({ reviewBases: this.withoutReview(path) });
    }
  }

  /** Loads the review base for a page shown outside the main pane, such as the split pane. */
  ensureReview(path: string) {
    if (this.state.session.pending[path] && !this.state.reviewBases[path]) void this.refreshReview(path);
  }

  reviewDiff(path = this.state.session.current): PageDiff | null {
    if (!path) return null;
    const base = this.state.reviewBases[path];
    const body = this.state.bodies[path];
    if (!base || body === undefined) return null;
    return diffBodies(base.body, body);
  }

  async undoChange(change: Change, path = this.state.session.current) {
    const diff = this.reviewDiff(path);
    if (!diff || !path || !this.state.folder) return;
    try {
      const next = revertChange(diff, change);
      await this.writePage(path, next);
      this.set({ bodies: { ...this.state.bodies, [path]: next } });
      if (diffBodies(this.state.reviewBases[path]?.body ?? "", next).changes.length === 0) await this.undoAll(path);
    } catch (e) {
      this.fail(e);
    }
  }

  async undoAll(path = this.state.session.current) {
    const base = path ? this.state.reviewBases[path] : undefined;
    if (!path || !base || !this.state.folder) return;
    try {
      await this.writePage(path, base.body);
      const { folder, rel } = this.loc(path);
      // The pinned base is what comes back, so every snapshot taken from it on goes with the edits:
      // refines stacked on one page leave one each, and history would otherwise keep the orphans.
      const list = await platform.listVersions(folder, rel).catch(() => []);
      const stale = list.filter((v) => v.n >= base.n).map((v) => v.n);
      for (const n of stale.length ? stale : [base.n]) await platform.deleteVersion(folder, rel, n);
      const pending = { ...this.state.session.pending };
      delete pending[path];
      this.set({ bodies: { ...this.state.bodies, [path]: base.body }, reviewBases: this.withoutReview(path) });
      this.setSession({ pending });
      if (this.isShown(path)) await this.refreshVersions(path);
    } catch (e) {
      this.fail(e);
    }
  }

  done(path = this.state.session.current) {
    if (!path) return;
    const pending = { ...this.state.session.pending };
    delete pending[path];
    this.setSession({ pending });
    this.set({ reviewBases: this.withoutReview(path) });
  }

  // ---------- versions ----------

  /** Whether a page is on screen in either pane. */
  private isShown(path: string): boolean {
    const s = this.state.session;
    return s.current === path || s.split === path;
  }

  /** The page a pane shows. */
  private panePath(role: PaneRole): string | undefined {
    return role === "main" ? this.state.session.current : this.state.session.split;
  }

  private setVersionView(role: PaneRole, patch: Partial<VersionView>) {
    const views = this.state.ui.versionView;
    this.setUi({ versionView: { ...views, [role]: { ...views[role], ...patch } } });
  }

  /** Both panes' version views with their menus closed, and any other fields changed alike. */
  private closedMenus(patch: Partial<VersionView> = {}): Record<PaneRole, VersionView> {
    const views = this.state.ui.versionView;
    return { main: { ...views.main, history: false, ...patch }, split: { ...views.split, history: false, ...patch } };
  }

  private async refreshVersions(path: string) {
    if (!this.state.folder) return;
    let list: VersionInfo[] = [];
    try {
      const { folder, rel } = this.loc(path);
      list = await platform.listVersions(folder, rel);
    } catch {
      list = [];
    }
    this.set({ versions: { ...this.state.versions, [path]: list }, versionBodies: { ...this.state.versionBodies, [path]: {} } });
  }

  toggleHistory(role: PaneRole = "main") {
    const open = this.state.ui.versionView[role].history;
    this.setUi({ popover: undefined, selection: undefined, versionView: this.closedMenus() });
    if (!open) this.setVersionView(role, { history: true });
  }

  /**
   * Shows version `n` of the page a pane displays. A ⌘ or ⌘⇧ click on a version passes the New Page or Deep Dive
   * placement: "beside" and "below" put the page in the other pane and view the version there, "window" opens a
   * window on it. "background" has no meaning for a version, so it views the version here like a plain click.
   */
  async viewVersion(n: number, role: PaneRole = "main", placement: Placement = "active") {
    let path = this.panePath(role);
    if (!path || !this.state.folder) return;
    const folder = this.state.folder;
    try {
      if (placement === "window") {
        this.setUi({ versionView: this.closedMenus() });
        await platform.openPageWindow(folder, path, n);
        return;
      }
      if (placement === "beside" || placement === "below") {
        if (role === "main") {
          await this.openPage(path, placement);
          role = "split";
        } else {
          // The page already sits in the split pane, so the other pane is the main one.
          if (this.state.session.current !== path) await this.navigate(path);
          role = "main";
        }
        if (this.panePath(role) !== path) return;
      }
      if (this.state.versionBodies[path]?.[n] === undefined) {
        const { folder: root, rel } = this.loc(path);
        const raw = await platform.readVersion(root, rel, n);
        const forPage = { ...(this.state.versionBodies[path] ?? {}), [n]: stripFrontMatter(raw) };
        this.set({ versionBodies: { ...this.state.versionBodies, [path]: forPage } });
      }
      // Both menus close: the click may have come from the other pane's menu. The pane's answer cards
      // go with them: they hang off the blocks of the page as it reads now, not of an old version.
      this.setUi({ popover: undefined, selection: undefined, lookups: this.closedLookups(this.lookupIdsIn(role)), versionView: this.closedMenus() });
      this.setVersionView(role, { viewing: n, history: false, confirmRestore: false });
    } catch (e) {
      this.fail(e);
    }
  }

  backToCurrent(role: PaneRole = "main") {
    this.setVersionView(role, { viewing: undefined, confirmRestore: false });
  }

  askRestore(role: PaneRole = "main") {
    this.setVersionView(role, { confirmRestore: true });
  }

  cancelRestore(role: PaneRole = "main") {
    this.setVersionView(role, { confirmRestore: false });
  }

  async restore(role: PaneRole = "main") {
    const path = this.panePath(role);
    const n = this.state.ui.versionView[role].viewing;
    if (!path || n === undefined || !this.state.folder) return;
    try {
      const { folder, rel } = this.loc(path);
      await platform.restoreVersion(folder, rel, n);
      const page = await platform.readPage(folder, rel);
      const pending = { ...this.state.session.pending };
      delete pending[path];
      this.set({ bodies: { ...this.state.bodies, [path]: page.body }, reviewBases: this.withoutReview(path) });
      this.setSession({ pending });
      // Restoring drops every newer snapshot, so a pane showing one of them on the same page goes back to current too.
      const views = this.state.ui.versionView;
      const other: PaneRole = role === "main" ? "split" : "main";
      const otherView = this.panePath(other) === path && (views[other].viewing ?? 0) >= n ? closedVersionView : views[other];
      this.setUi({ versionView: { ...views, [role]: closedVersionView, [other]: otherView } });
      await this.refreshVersions(path);
    } catch (e) {
      this.fail(e);
    }
  }

  // ---------- commands from the menu bar ----------

  command(id: string) {
    // Home replaces the window, so only the commands that make sense there get through.
    if (this.state.home && !["open", "home", "settings", "check-update"].includes(id)) return;
    switch (id) {
      case "check-update":
        void this.checkForUpdate(true);
        break;
      case "open":
        void this.pickPath();
        break;
      case "add-root":
        void this.addRoot();
        break;
      case "home":
        this.toggleHome();
        break;
      case "toggle-sidebar":
        this.toggleSidebar();
        break;
      case "map":
        this.state.ui.map ? this.closeMap() : this.openMap("web");
        break;
      case "fullscreen-pane":
        if (this.state.session.split) this.setUi({ fullscreen: !this.state.ui.fullscreen });
        break;
      case "refine":
        this.toggleRefine();
        break;
      case "find":
        this.openFind();
        break;
      case "find-next":
        this.findStep(1);
        break;
      case "find-prev":
        this.findStep(-1);
        break;
      case "filter":
        this.focusFilter();
        break;
      case "new-page":
        this.toggleNewFile();
        break;
      case "back":
        this.back();
        break;
      case "forward":
        this.forward();
        break;
      case "settings":
        void platform.openSettings();
        break;
      case "close-pane":
        if (this.state.session.split) this.closeSplit();
        break;
    }
  }
}

/** The folder among `dirs` an added root's page key starts with, the longest when they nest; undefined for a session-folder page. */
function rootOfKey(key: string, dirs: string[]): string | undefined {
  let best: string | undefined;
  for (const dir of dirs) if (key.startsWith(dir + "/") && dir.length > (best?.length ?? 0)) best = dir;
  return best;
}

/** A .md path as a root: its folder, and the file inside it. */
function splitFilePath(path: string): SessionRoot {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i <= 0) throw new Error(`Could not find the folder of ${path}`);
  return { folder: path.slice(0, i), file: path.slice(i + 1) };
}

/** The same keys, with each value rewritten. */
function mapValues<T>(map: Record<string, T>, touch: (value: T) => T): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(map)) out[k] = touch(v);
  return out;
}

/** The full path of every page the session holds, whichever root it came from. */
function takenPaths(pages: Record<string, PageMeta>, primary: string, dirs: string[]): Set<string> {
  return new Set(Object.keys(pages).map((k) => (rootOfKey(k, dirs) ? k : `${primary}/${k}`)));
}

/**
 * A page as the session keys it. A page read from disk names its source relative to its own folder; under a
 * full-path key (`key` differs from the path inside `folder`) the source is given the same prefix, so the link
 * resolves against the session's pages.
 */
function keyedMeta(meta: PageMeta, key: string, folder: string): PageMeta {
  const source = meta.source && key !== meta.path ? `${folder}/${meta.source}` : meta.source;
  return { ...meta, path: key, source };
}

/** The newest page of a set, by the same reckoning the session uses when it has to choose one. */
function newestPath(pages: Record<string, PageMeta>): string | undefined {
  return Object.values(pages).sort((a, b) => Date.parse(b.created ?? b.modified ?? "") - Date.parse(a.created ?? a.modified ?? ""))[0]?.path;
}

/** Recents `fileId` keyed as resolve_session expects: the relative page path it last knew. */
function idsFromRecent(r: RecentSession | undefined): Record<string, string> | undefined {
  if (!r?.file || !r.fileId) return undefined;
  return { [r.file]: r.fileId };
}

/** Swaps a page's first heading for its new title, when that heading still reads as the old one. */
function renameHeading(body: string, from: string, to: string): string {
  const m = /^([ \t]*#[ \t]+)(.+?)([ \t]*)$/m.exec(body);
  if (!m || m[2].trim() !== from.trim()) return body;
  return body.slice(0, m.index) + m[1] + to + m[3] + body.slice(m.index + m[0].length);
}

function flipPlacement(p: Placement): Placement {
  switch (p) {
    case "beside":
      return "background";
    case "background":
      return "beside";
    case "below":
      return "background";
    case "active":
      return "beside";
    case "window":
      return "beside";
  }
}

function stripFences(s: string): string {
  const m = /^\s*```[a-z]*\n([\s\S]*?)\n```\s*$/i.exec(s);
  return m ? m[1] : s;
}

function stripFrontMatter(raw: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
  return m ? raw.slice(m[0].length) : raw;
}

export const store = new ReaderStore();

export function useReader(): ReaderState {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

// Module-level state cannot survive a hot update; reload instead.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
