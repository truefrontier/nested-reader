import { useSyncExternalStore } from "react";
import {
  DEFAULT_SETTINGS,
  emptySession,
  platform,
  readingWidthCss,
  sidebarWidthPx,
  type AiRequest,
  type ChatMessage,
  type PageMeta,
  type Placement,
  type RecentSession,
  type Session,
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
import { dirOf, folderChain, growsFrom, sessionPages } from "../lib/tree";

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
  thread: { question: string; answer: string }[];
  question: string;
  answer: string;
  streaming: boolean;
  error?: string;
};

export type Popover = "ask" | "refine";
export type Verb = "quick" | "page" | "deep";
/** The ⌘N verbs: ↵ opens the page here, ⌘↵ and ⌘⇧↵ are the New Page and Deep Dive placements. */
export type NewFileVerb = "here" | "page" | "deep";
/** Where a page's brief came from: a highlight in its source (the default) or the whole session (⌘N). */
export type PageOrigin = "highlight" | "session";

/** The box at the bottom of the pane: refine the page or corpus (⌘R), or start a new page (⌘N). */
export type PanePopover = "refine" | "new";

/** Which pane something belongs to: the reading pane, or the one opened beside or below it. */
export type PaneRole = "main" | "split";

/** One pane's version history UI: whether its menu is open, which old version it shows, and whether Restore awaits a yes. */
export type VersionView = { history: boolean; viewing?: number; confirmRestore: boolean };

export type UiState = {
  selection?: Selection;
  popover?: Popover;
  panePopover?: PanePopover;
  lookup?: Lookup;
  /** Version history UI, per pane, so each pane can show a different version of the same page. */
  versionView: Record<PaneRole, VersionView>;
  map?: "web" | "timeline";
  fullscreen: boolean;
  /** When both panes show the same page they scroll together, until this is turned off from the pane tools. */
  syncScroll: boolean;
  filter: string;
  unreadOnly: boolean;
  refining?: RefineScope;
  /** The instruction being (or last) refined, shown while it runs and kept for a retry. */
  refineText?: string;
  refineError?: { scope: RefineScope; message: string };
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
  apiKeyMissing?: boolean;
  ui: UiState;
};

const closedVersionView: VersionView = { history: false, confirmRestore: false };

const initialUi: UiState = {
  versionView: { main: closedVersionView, split: closedVersionView },
  fullscreen: false,
  syncScroll: true,
  filter: "",
  unreadOnly: false,
  dragging: false,
  find: false,
  findQuery: "",
  findIndex: 0,
  findFocus: 0,
  findSelect: 0,
  filterFocus: 0,
};

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
    ui: initialUi,
  };

  private listeners = new Set<() => void>();
  private streams = new Map<string, StreamHandle>();
  private saveTimer: number | undefined;
  private writeTimers = new Map<string, number>();
  private initialized = false;
  /** The folder (and file) an in-flight openFolder is loading, so a later open can supersede it. */
  private opening?: { folder: string; file?: string };

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
    const message = err instanceof Error ? err.message : String(err);
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
      if (page && settings.folder) {
        await this.openFolder(settings.folder, { initialPage: page, initialVersion, file: last?.folder === settings.folder ? last.file : undefined });
      } else if (settings.openAtLaunch === "ask") {
        const folder = await platform.pickFolder();
        if (folder) await this.openFolder(folder);
      } else if (settings.openAtLaunch === "last-session") {
        if (last) await this.openFolder(last.folder, { file: last.file });
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

  async pickFolder() {
    try {
      const folder = await platform.pickFolder();
      if (folder) await this.openFolder(folder);
    } catch (e) {
      this.fail(e);
    }
  }

  async pickFile() {
    try {
      const path = await platform.pickFile();
      if (path) await this.openFile(path);
    } catch (e) {
      this.fail(e);
    }
  }

  /** Opens one .md as a session: that page and the pages grown from it, saved beside it. */
  async openFile(path: string) {
    const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    if (i <= 0) return this.fail(`Could not find the folder of ${path}`);
    await this.openFolder(path.slice(0, i), { file: path.slice(i + 1) });
  }

  /** Paths dropped on the window: a folder or a .md file starts a session. */
  async openDropped(paths: string[]) {
    const path = paths[0];
    if (!path) return this.fail("Drop a folder or a .md file.");
    try {
      const kind = await platform.pathKind(path);
      if (kind === "folder") await this.openFolder(path);
      else if (kind === "file") await this.openFile(path);
      else this.fail("Drop a folder or a .md file.");
    } catch (e) {
      this.fail(e);
    }
  }

  /**
   * Loads a folder as the session. With `file`, only that page and the pages grown from it
   * are shown. The folder's saved session is restored, so you land where you left off.
   */
  async openFolder(folder: string, opts: { initialPage?: string; initialVersion?: number; file?: string } = {}) {
    const { initialPage, initialVersion, file } = opts;
    const target = { folder, file };
    this.opening = target;
    try {
      const list = await platform.listPages(folder);
      if (this.opening !== target) return; // a later open superseded this one
      const all: Record<string, PageMeta> = {};
      for (const p of list) all[p.path] = p;
      if (file && !all[file]) throw new Error(`Not a Markdown page: ${file}`);
      const pages: Record<string, PageMeta> = {};
      for (const p of list) if (!file || growsFrom(p.path, file, all)) pages[p.path] = p;
      const stored = await platform.loadSession(folder, file);
      if (this.opening !== target) return;
      const session: Session = { ...emptySession(), ...(stored ?? {}) };
      session.loading = session.loading.filter((p) => pages[p]);
      session.unread = session.unread.filter((p) => pages[p]);
      for (const key of Object.keys(session.pending)) if (!pages[key]) delete session.pending[key];
      if (session.split && !pages[session.split]) session.split = undefined;
      // Pages deleted outside the app drop out of the trail.
      const before = session.trail.slice(0, session.trailIndex + 1).filter((p) => pages[p]);
      session.trail = session.trail.filter((p) => pages[p]);
      session.trailIndex = before.length - 1;
      const recent = this.findRecent(folder, file);
      const folderName = session.name || recent?.name || (file ? pages[file].title : prettyFolderName(folder));
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

  private currentRecent(): RecentSession | undefined {
    return this.state.folder ? this.findRecent(this.state.folder, this.state.rootFile) : undefined;
  }

  private setRecents(recents: RecentSession[]) {
    this.set({ recents });
    platform.saveRecents(recents).catch(() => undefined);
  }

  /** Puts the open session at the top of the recents list. */
  private rememberSession() {
    const { folder, rootFile, folderName, session } = this.state;
    if (!folder) return;
    const entry: RecentSession = { folder, file: rootFile, name: folderName, openedAt: nowIso(), unread: session.unread.length };
    this.setRecents([entry, ...this.state.recents.filter((r) => !this.sameSession(r, folder, rootFile))].slice(0, 30));
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
    await this.openFolder(r.folder, { file: r.file });
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
    const page = await platform.readPage(this.state.folder, path);
    this.set({ bodies: { ...this.state.bodies, [path]: page.body }, pages: { ...this.state.pages, [path]: { ...this.state.pages[path], ...page, body: undefined } as PageMeta } });
    return page.body;
  }

  // ---------- navigation ----------

  async navigate(path: string, opts: { push?: boolean } = {}) {
    if (!this.state.pages[path]) return;
    try {
      await this.loadBody(path);
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
      // The split pane keeps its version view; only the main pane changed.
      this.setUi({ ...initialUi, filter: ui.filter, unreadOnly: ui.unreadOnly, map: undefined, versionView: { ...initialUi.versionView, split: ui.versionView.split } });
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
      this.setSession({ unread: s.unread.includes(path) ? s.unread.filter((p) => p !== path) : [...s.unread, path] });
      return;
    }
    await this.loadBody(path);
    this.dropPaneUi("split");
    this.setSession({ split: path, splitDirection: placement, sidebar: false });
    this.setUi({ versionView: { ...this.state.ui.versionView, split: closedVersionView }, syncScroll: true });
    await this.refreshVersions(path);
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

  /** Drops the highlight, its box and the answer card sitting in `role` when that pane's page changes or the pane closes. */
  private dropPaneUi(role: PaneRole) {
    const ui = this.state.ui;
    const selection = ui.selection?.pane === role;
    const lookup = ui.lookup?.pane === role;
    if (!selection && !lookup) return;
    if (lookup) this.stopStream("lookup");
    this.setUi({ ...(selection ? { selection: undefined, popover: undefined } : {}), ...(lookup ? { lookup: undefined } : {}) });
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

  /** Closes a sidebar folder, or opens it again. */
  toggleFolder(dir: string) {
    const list = this.state.session.collapsed ?? [];
    this.setSession({ collapsed: list.includes(dir) ? list.filter((d) => d !== dir) : [...list, dir] });
  }

  /** Opens every folder on the way to `path`, so the row for it can be seen. */
  revealInTree(path: string) {
    const list = this.state.session.collapsed ?? [];
    if (!list.length) return;
    const chain = folderChain(dirOf(path));
    const next = list.filter((d) => !chain.includes(d));
    if (next.length !== list.length) this.setSession({ collapsed: next });
  }

  setFilter(filter: string) {
    this.setUi({ filter });
  }

  toggleUnreadOnly() {
    this.setUi({ unreadOnly: !this.state.ui.unreadOnly });
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
    const fromSelection = !ui.find && ui.popover === "ask" && !ui.lookup ? ui.selection?.text : undefined;
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
    this.setUi({ selection, popover, panePopover: undefined, versionView: this.closedMenus(), refineError: undefined, refineText: undefined });
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
    this.setUi({ selection, popover: "ask", panePopover: undefined, versionView: this.closedMenus(), refineError: undefined, refineText: undefined });
  }

  closePopover() {
    this.setUi({ popover: undefined, selection: undefined, panePopover: undefined, refineError: undefined, refineText: undefined });
  }

  closeLookup() {
    this.stopStream("lookup");
    this.setUi({ lookup: undefined, selection: undefined, popover: undefined });
  }

  toggleRefine() {
    const ui = this.state.ui;
    if (ui.selection && ui.popover === "ask") return this.setUi({ popover: "refine" });
    if (ui.popover === "refine") return this.setUi({ popover: "ask" });
    if (ui.selection && ui.lookup) return this.setUi({ popover: "refine", lookup: undefined });
    this.setUi({ panePopover: ui.panePopover === "refine" ? undefined : "refine", popover: undefined, selection: undefined });
  }

  /** ⌘N: the box for a new page written from the whole session. Pressing it again closes the box. */
  toggleNewFile() {
    const ui = this.state.ui;
    if (!this.state.session.current) return;
    this.setUi({ panePopover: ui.panePopover === "new" ? undefined : "new", popover: undefined, selection: undefined, lookup: undefined });
  }

  /** Reopens the refine box, pre-filled, after a failed attempt. */
  retryRefine() {
    const ui = this.state.ui;
    const err = ui.refineError;
    if (!err) return;
    if (err.scope === "selection" && ui.selection) return this.setUi({ refineError: undefined, popover: "refine" });
    this.setUi({ refineError: undefined, panePopover: "refine", popover: undefined, selection: undefined });
  }

  escape() {
    const ui = this.state.ui;
    if (this.state.home) return this.leaveHome();
    // The pane being read answers first: the split when it is fullscreen, else the main pane.
    const roles: PaneRole[] = ui.fullscreen && this.state.session.split ? ["split", "main"] : ["main", "split"];
    for (const role of roles) if (ui.versionView[role].confirmRestore) return this.cancelRestore(role);
    for (const role of roles) if (ui.versionView[role].history) return this.setVersionView(role, { history: false });
    for (const role of roles) if (ui.versionView[role].viewing !== undefined) return this.backToCurrent(role);
    if (ui.popover || ui.panePopover || ui.refineError) return this.closePopover();
    if (ui.lookup) return this.closeLookup();
    if (ui.find) return this.closeFind();
    if (ui.map) return this.closeMap();
    if (ui.fullscreen) return this.setUi({ fullscreen: false });
  }

  // ---------- AI plumbing ----------

  private request(system: string, messages: ChatMessage[], maxTokens?: number): AiRequest {
    const s = this.state.settings;
    const auth = authFor(s, s.provider);
    const baseUrl = s.provider === "ollama" ? s.ollamaUrl : s.baseUrl;
    return { provider: s.provider, auth, model: s.models[modelSlot(s.provider, auth)], baseUrl: baseUrl || undefined, system, messages, maxTokens };
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
      if (e.type === "delta") on.delta(e.text);
      else if (e.type === "done") {
        this.streams.delete(key);
        on.done();
      } else {
        this.streams.delete(key);
        on.error(e.message);
      }
    });
    this.streams.set(key, handle);
  }

  private stopStream(key: string) {
    this.streams.get(key)?.cancel();
    this.streams.delete(key);
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

  /** Runs the verb chosen in the ask popover or the inline card. */
  async ask(question: string, verb: Verb, alt = false) {
    const ui = this.state.ui;
    const selection = ui.selection;
    if (verb === "quick") return this.quickAnswer(question, selection, ui.lookup);
    const mode = verb === "deep" ? "deep-dive" : "new-page";
    const preferred = verb === "deep" ? this.state.settings.deepDiveOpens : this.state.settings.newPageOpens;
    const placement = alt ? flipPlacement(preferred) : preferred;
    // The page grows from the page the highlight (or the answer card) is in, which may be the split pane's.
    const source = this.panePath(selection?.pane ?? ui.lookup?.pane ?? "main");
    await this.createPage({ question, mode, placement, source, sourceText: selection?.text, block: selection?.block ?? ui.lookup?.block });
  }

  private async quickAnswer(question: string, selection: Selection | undefined, existing?: Lookup) {
    const block = selection?.block ?? existing?.block;
    const pane = selection?.pane ?? existing?.pane;
    if (block === undefined || !pane) return;
    const thread = existing ? (existing.answer ? [...existing.thread, { question: existing.question, answer: existing.answer }] : existing.thread) : [];
    const q = question || (selection ? `Explain: ${selection.text}` : "");
    const lookup: Lookup = { pane, block, thread, question: q, answer: "", streaming: true };
    this.setUi({ lookup, popover: undefined, selection: existing?.block === block ? this.state.ui.selection : selection, panePopover: undefined });
    try {
      const ctx = await this.askContext(selection ?? this.state.ui.selection, thread, this.panePath(pane));
      if (!ctx) return;
      const { system, messages } = quickAnswerMessages(ctx, q);
      this.stream("lookup", this.request(system, messages, 400), {
        delta: (t) => {
          const cur = this.state.ui.lookup;
          if (cur) this.setUi({ lookup: { ...cur, answer: cur.answer + t } });
        },
        done: () => {
          const cur = this.state.ui.lookup;
          if (cur) this.setUi({ lookup: { ...cur, streaming: false } });
        },
        error: (m) => {
          const cur = this.state.ui.lookup;
          if (cur) this.setUi({ lookup: { ...cur, streaming: false, error: m } });
        },
      });
    } catch (e) {
      this.fail(e);
    }
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
      this.setUi({ popover: undefined, selection: undefined, lookup: undefined, panePopover: undefined });
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
   * Streams a page's text from the model. On failure the page keeps its heading and the
   * error is remembered, so the page shows a retry instead of silently staying empty.
   */
  private async generatePage(
    path: string,
    opts: { sourcePath: string; question: string; mode: "new-page" | "deep-dive"; sourceText?: string; block?: number; from?: PageOrigin },
  ) {
    const folder = this.state.folder;
    if (!folder) return;
    const title = this.state.pages[path]?.title ?? opts.question;
    const heading = `# ${title}\n\n`;
    const selection = opts.sourceText
      ? { block: opts.block ?? 0, start: 0, end: 0, text: opts.sourceText, paragraph: this.paragraphOf(opts.sourcePath, opts.block), caretX: 0 }
      : undefined;
    const ctx = await this.askContext(selection, undefined, opts.sourcePath);
    if (!ctx) return;
    const deep = opts.mode === "deep-dive";
    const { system, messages } = opts.from === "session" ? newFileMessages(ctx, opts.question, deep) : newPageMessages(ctx, opts.question, deep);
    let text = "";
    const flush = (final: boolean) => {
      const body = text.trim().startsWith("#") ? text : heading + text;
      this.set({ bodies: { ...this.state.bodies, [path]: body } });
      const write = () => {
        const t = titleFromBody(body, title);
        const m: PageMeta = { ...this.state.pages[path], title: t };
        this.set({ pages: { ...this.state.pages, [path]: m } });
        platform.writePage(folder, path, serializePage(m, body)).catch((e) => this.fail(e));
      };
      if (final) {
        window.clearTimeout(this.writeTimers.get(path));
        write();
      } else if (!this.writeTimers.has(path)) {
        this.writeTimers.set(
          path,
          window.setTimeout(() => {
            this.writeTimers.delete(path);
            write();
          }, 500),
        );
      }
    };
    const stopLoading = () => {
      const s = this.state.session;
      this.setSession({ loading: s.loading.filter((p) => p !== path) });
    };
    this.stream(`page:${path}`, this.request(system, messages, opts.mode === "deep-dive" ? 2400 : 1200), {
      delta: (t) => {
        text += t;
        flush(false);
      },
      done: () => {
        flush(true);
        const s = this.state.session;
        const visible = s.current === path || s.split === path;
        this.setSession({ loading: s.loading.filter((p) => p !== path), unread: visible || s.unread.includes(path) ? s.unread : [...s.unread, path] });
        if (this.state.pageErrors[path]) this.set({ pageErrors: this.withoutPageError(path) });
      },
      error: (m) => {
        flush(true);
        stopLoading();
        this.set({ pageErrors: { ...this.state.pageErrors, [path]: m } });
        const s = this.state.session;
        if (s.current !== path && s.split !== path) this.fail(`Couldn't write "${title}": ${m}`);
      },
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
    await platform.writePage(this.state.folder, path, serializePage(this.state.pages[path], next));
  }

  // ---------- refine & review ----------

  async refine(instruction: string, scope: RefineScope) {
    const { session, folder } = this.state;
    const selection = this.state.ui.selection;
    // The box under a highlight acts on the page of the pane the highlight is in; the pane-level box (⌘R) acts on the main page.
    const current = selection ? this.panePath(selection.pane) : session.current;
    if (!folder || !current || !instruction.trim()) return;
    if (scope === "selection" && !selection) return;
    this.setUi({ refining: scope, refineText: instruction, refineError: undefined, popover: undefined, panePopover: undefined });
    let ok = true;
    try {
      if (scope === "corpus") {
        const targets = [current, ...sessionPages(current, this.state.pages).map((p) => p.path)];
        for (const path of targets) await this.refinePage(path, instruction, undefined);
      } else {
        await this.refinePage(current, instruction, scope === "selection" ? selection : undefined);
      }
    } catch (e) {
      // The failure is shown where the refine box was, with the text kept for a retry.
      ok = false;
      this.setUi({ refineError: { scope, message: e instanceof Error ? e.message : String(e) } });
    } finally {
      this.setUi(ok ? { refining: undefined, selection: undefined, refineText: undefined } : { refining: undefined });
    }
  }

  private refinePage(path: string, instruction: string, selection: Selection | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      void (async () => {
        const folder = this.state.folder;
        if (!folder) return resolve();
        const body = await this.loadBody(path);
        const blocks = lexBlocks(body);
        const target = selection ? selection.text : body;
        const ctx = await this.askContext(selection, undefined, path);
        if (!ctx) return resolve();
        const { system, messages } = refineMessages({ ...ctx, page: { meta: this.state.pages[path], body } }, instruction, selection ? "selection" : "page", target);
        let out = "";
        this.stream(`refine:${path}`, this.request(system, messages, selection ? 800 : 4000), {
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
                if (next.trim() === body.trim()) return resolve();
                const n = await platform.snapshotVersion(folder, path);
                await platform.writePage(folder, path, serializePage(this.state.pages[path], next));
                this.set({ bodies: { ...this.state.bodies, [path]: next } });
                this.setSession({ pending: { ...this.state.session.pending, [path]: n } });
                if (this.isShown(path)) await this.refreshVersions(path);
                // Every changed page gets its review base, so the split pane and later visits show the tints.
                await this.refreshReview(path);
              } catch (e) {
                reject(e);
                return;
              }
              resolve();
            })();
          },
          error: (m) => reject(new Error(m)),
        });
      })();
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
      const raw = await platform.readVersion(this.state.folder, path, n);
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
      await platform.writePage(this.state.folder, path, serializePage(this.state.pages[path], next));
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
      await platform.writePage(this.state.folder, path, serializePage(this.state.pages[path], base.body));
      await platform.deleteVersion(this.state.folder, path, base.n);
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
      list = await platform.listVersions(this.state.folder, path);
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
        const raw = await platform.readVersion(this.state.folder, path, n);
        const forPage = { ...(this.state.versionBodies[path] ?? {}), [n]: stripFrontMatter(raw) };
        this.set({ versionBodies: { ...this.state.versionBodies, [path]: forPage } });
      }
      // Both menus close: the click may have come from the other pane's menu.
      this.setUi({ popover: undefined, selection: undefined, lookup: undefined, versionView: this.closedMenus() });
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
      await platform.restoreVersion(this.state.folder, path, n);
      const page = await platform.readPage(this.state.folder, path);
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
    if (this.state.home && !["open-folder", "open-file", "home", "settings"].includes(id)) return;
    switch (id) {
      case "open-folder":
        void this.pickFolder();
        break;
      case "open-file":
        void this.pickFile();
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
