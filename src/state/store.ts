import { useSyncExternalStore } from "react";
import {
  DEFAULT_SETTINGS,
  emptySession,
  platform,
  type AiRequest,
  type ChatMessage,
  type PageMeta,
  type Placement,
  type Session,
  type Settings,
  type StreamHandle,
  type VersionInfo,
} from "../platform";
import { diffBodies, revertChange, type Change, type PageDiff } from "../lib/diff";
import { joinBlocks, lexBlocks, linkTextInRaw, resolveWikiTarget } from "../lib/markdown";
import { serializePage, titleFromBody } from "../lib/frontmatter";
import { slugify, titleFromQuestion, uniquePath } from "../lib/slug";
import { nowIso } from "../lib/time";
import { newPageMessages, quickAnswerMessages, refineMessages, type AskContext, type RefineScope } from "../lib/prompts";
import { sessionPages } from "../lib/tree";

export type Selection = {
  block: number;
  start: number;
  end: number;
  text: string;
  paragraph: string;
  /** Horizontal position of the selection end inside the block, in px. */
  caretX: number;
};

export type Lookup = {
  block: number;
  thread: { question: string; answer: string }[];
  question: string;
  answer: string;
  streaming: boolean;
  error?: string;
};

export type Popover = "ask" | "refine";
export type Verb = "quick" | "page" | "deep";

export type UiState = {
  selection?: Selection;
  popover?: Popover;
  panePopover: boolean;
  lookup?: Lookup;
  history: boolean;
  viewing?: number;
  confirmRestore: boolean;
  map?: "web" | "timeline";
  fullscreen: boolean;
  filter: string;
  unreadOnly: boolean;
  refining?: RefineScope;
  error?: string;
};

export type ReviewBase = { path: string; n: number; body: string };

export type ReaderState = {
  ready: boolean;
  folder?: string;
  folderName: string;
  pages: Record<string, PageMeta>;
  bodies: Record<string, string>;
  session: Session;
  settings: Settings;
  versions: VersionInfo[];
  versionBodies: Record<number, string>;
  reviewBase?: ReviewBase;
  apiKeyMissing?: boolean;
  ui: UiState;
};

const initialUi: UiState = { panePopover: false, history: false, confirmRestore: false, fullscreen: false, filter: "", unreadOnly: false };

function prettyFolderName(folder: string): string {
  const base = folder.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? folder;
  return base.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export class ReaderStore {
  state: ReaderState = {
    ready: false,
    folderName: "",
    pages: {},
    bodies: {},
    session: emptySession(),
    settings: DEFAULT_SETTINGS,
    versions: [],
    versionBodies: {},
    ui: initialUi,
  };

  private listeners = new Set<() => void>();
  private streams = new Map<string, StreamHandle>();
  private saveTimer: number | undefined;
  private writeTimers = new Map<string, number>();

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
      if (this.state.folder) platform.saveSession(this.state.folder, this.state.session).catch(() => undefined);
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
    try {
      const settings = await platform.getSettings();
      this.set({ settings });
      this.applyTheme(settings);
      platform.onSettingsChanged((s) => {
        this.set({ settings: s });
        this.applyTheme(s);
        if (s.folder && s.folder !== this.state.folder) void this.openFolder(s.folder);
      });
      platform.onCommand((id) => this.command(id));
      const url = new URL(location.href);
      const page = url.searchParams.get("page");
      if (settings.folder && settings.openAtLaunch !== "nothing") {
        await this.openFolder(settings.folder, page ?? undefined);
      }
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
    root.dataset.font = s.readingFont;
  }

  async pickFolder() {
    try {
      const folder = await platform.pickFolder();
      if (!folder) return;
      const settings = { ...this.state.settings, folder };
      await platform.saveSettings(settings);
      this.set({ settings });
      await this.openFolder(folder);
    } catch (e) {
      this.fail(e);
    }
  }

  async openFolder(folder: string, initialPage?: string) {
    try {
      const list = await platform.listPages(folder);
      const pages: Record<string, PageMeta> = {};
      for (const p of list) pages[p.path] = p;
      const stored = await platform.loadSession(folder);
      const session: Session = { ...emptySession(), ...(stored ?? {}) };
      session.loading = session.loading.filter((p) => pages[p]);
      session.unread = session.unread.filter((p) => pages[p]);
      for (const key of Object.keys(session.pending)) if (!pages[key]) delete session.pending[key];
      if (session.split && !pages[session.split]) session.split = undefined;
      this.set({ folder, folderName: prettyFolderName(folder), pages, bodies: {}, session, versions: [], versionBodies: {}, reviewBase: undefined, ui: { ...initialUi } });
      let current = initialPage && pages[initialPage] ? initialPage : session.current;
      if (!current || !pages[current]) {
        const sorted = [...list].sort((a, b) => Date.parse(b.created ?? b.modified ?? "") - Date.parse(a.created ?? a.modified ?? ""));
        current = sorted[0]?.path;
      }
      if (current) await this.navigate(current, { push: session.trail.length === 0 });
      if (session.split) await this.loadBody(session.split);
    } catch (e) {
      this.fail(e);
    }
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
      this.setUi({ ...initialUi, filter: this.state.ui.filter, unreadOnly: this.state.ui.unreadOnly, map: undefined });
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
      const s = this.state.session;
      if (s.current !== path && !s.unread.includes(path)) this.setSession({ unread: [...s.unread, path] });
      return;
    }
    await this.loadBody(path);
    this.setSession({ split: path, splitDirection: placement, sidebar: false });
  }

  /** Placement for a click on a link or tree row, following browser conventions. */
  placementFor(e: { metaKey: boolean; shiftKey: boolean; altKey: boolean }): Placement {
    if (e.altKey) return "beside";
    if (e.metaKey && e.shiftKey) return "active";
    if (e.metaKey) return "background";
    return "active";
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
    this.setSession({ split: undefined });
    this.setUi({ fullscreen: false });
  }

  toggleSidebar() {
    this.setSession({ sidebar: !this.state.session.sidebar });
  }

  setFilter(filter: string) {
    this.setUi({ filter });
  }

  toggleUnreadOnly() {
    this.setUi({ unreadOnly: !this.state.ui.unreadOnly });
  }

  openMap(kind: "web" | "timeline") {
    this.setUi({ map: kind, popover: undefined, selection: undefined, panePopover: false, history: false });
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
    this.setUi({ selection, popover: "ask", panePopover: false, history: false });
  }

  closePopover() {
    this.setUi({ popover: undefined, selection: undefined, panePopover: false });
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
    this.setUi({ panePopover: !ui.panePopover, popover: undefined, selection: undefined });
  }

  escape() {
    const ui = this.state.ui;
    if (ui.confirmRestore) return this.setUi({ confirmRestore: false });
    if (ui.history) return this.setUi({ history: false });
    if (ui.viewing !== undefined) return this.backToCurrent();
    if (ui.popover || ui.panePopover) return this.closePopover();
    if (ui.lookup) return this.closeLookup();
    if (ui.map) return this.closeMap();
    if (ui.fullscreen) return this.setUi({ fullscreen: false });
  }

  // ---------- AI plumbing ----------

  private request(system: string, messages: ChatMessage[], maxTokens?: number): AiRequest {
    const s = this.state.settings;
    return { provider: s.provider, model: s.models[s.provider], baseUrl: s.baseUrl || undefined, system, messages, maxTokens };
  }

  private stream(key: string, req: AiRequest, on: { delta: (t: string) => void; done: () => void; error: (m: string) => void }) {
    this.stopStream(key);
    if (req.provider === "builtin") {
      on.error("The built-in plan is not available in this build. Choose a provider in Settings › AI.");
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

  private async askContext(selection?: Selection, thread?: Lookup["thread"]): Promise<AskContext | null> {
    const current = this.state.session.current;
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
    await this.createPage({ question, mode, placement, sourceText: selection?.text, block: selection?.block ?? ui.lookup?.block });
  }

  private async quickAnswer(question: string, selection: Selection | undefined, existing?: Lookup) {
    const block = selection?.block ?? existing?.block;
    if (block === undefined) return;
    const thread = existing ? (existing.answer ? [...existing.thread, { question: existing.question, answer: existing.answer }] : existing.thread) : [];
    const q = question || (selection ? `Explain: ${selection.text}` : "");
    const lookup: Lookup = { block, thread, question: q, answer: "", streaming: true };
    this.setUi({ lookup, popover: undefined, selection: existing?.block === block ? this.state.ui.selection : selection, panePopover: false });
    try {
      const ctx = await this.askContext(selection ?? this.state.ui.selection, thread);
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

  async createPage(opts: { question: string; mode: "new-page" | "deep-dive"; placement: Placement; sourceText?: string; block?: number }) {
    const { folder, session, settings, pages } = this.state;
    const current = session.current;
    if (!folder || !current) return;
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
      this.setUi({ popover: undefined, selection: undefined, lookup: undefined, panePopover: false });
      if (opts.placement === "active") await this.navigate(path);
      else if (opts.placement === "beside" || opts.placement === "below") {
        this.setSession({ split: path, splitDirection: opts.placement, sidebar: false });
      } else if (opts.placement === "window") {
        await platform.openPageWindow(folder, path);
      }
      const ctx = await this.askContext(sourceText ? { block: opts.block ?? 0, start: 0, end: 0, text: sourceText, paragraph: this.paragraphOf(current, opts.block), caretX: 0 } : undefined);
      if (!ctx) return;
      const { system, messages } = newPageMessages(ctx, question, opts.mode === "deep-dive");
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
        },
        error: (m) => {
          flush(true);
          const s = this.state.session;
          this.setSession({ loading: s.loading.filter((p) => p !== path) });
          this.fail(m);
        },
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
    const current = session.current;
    if (!folder || !current || !instruction.trim()) return;
    const selection = this.state.ui.selection;
    if (scope === "selection" && !selection) return;
    this.setUi({ refining: scope, popover: undefined, panePopover: false });
    try {
      if (scope === "corpus") {
        const targets = [current, ...sessionPages(current, this.state.pages).map((p) => p.path)];
        for (const path of targets) await this.refinePage(path, instruction, undefined);
      } else {
        await this.refinePage(current, instruction, scope === "selection" ? selection : undefined);
      }
    } catch (e) {
      this.fail(e);
    } finally {
      this.setUi({ refining: undefined, selection: undefined });
    }
  }

  private refinePage(path: string, instruction: string, selection: Selection | undefined): Promise<void> {
    return new Promise((resolve) => {
      void (async () => {
        const folder = this.state.folder;
        if (!folder) return resolve();
        const body = await this.loadBody(path);
        const blocks = lexBlocks(body);
        const target = selection ? selection.text : body;
        const ctx = await this.askContext(selection);
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
                  if (!b || !b.raw.includes(selection.text)) throw new Error("Could not find the selection in the page source.");
                  blocks[selection.block] = { ...b, raw: b.raw.replace(selection.text, cleaned) };
                  next = joinBlocks(blocks);
                } else {
                  next = cleaned.endsWith("\n") ? cleaned : cleaned + "\n";
                }
                if (next.trim() === body.trim()) return resolve();
                const n = await platform.snapshotVersion(folder, path);
                await platform.writePage(folder, path, serializePage(this.state.pages[path], next));
                this.set({ bodies: { ...this.state.bodies, [path]: next } });
                this.setSession({ pending: { ...this.state.session.pending, [path]: n } });
                if (this.state.session.current === path) {
                  await this.refreshVersions(path);
                  await this.refreshReview(path);
                }
              } catch (e) {
                this.fail(e);
              }
              resolve();
            })();
          },
          error: (m) => {
            this.fail(m);
            resolve();
          },
        });
      })();
    });
  }

  private async refreshReview(path: string) {
    const n = this.state.session.pending[path];
    if (!n || !this.state.folder) {
      if (this.state.reviewBase) this.set({ reviewBase: undefined });
      return;
    }
    if (this.state.reviewBase?.path === path && this.state.reviewBase.n === n) return;
    try {
      const raw = await platform.readVersion(this.state.folder, path, n);
      this.set({ reviewBase: { path, n, body: stripFrontMatter(raw) } });
    } catch {
      const pending = { ...this.state.session.pending };
      delete pending[path];
      this.setSession({ pending });
      this.set({ reviewBase: undefined });
    }
  }

  reviewDiff(): PageDiff | null {
    const { reviewBase, session, bodies } = this.state;
    const path = session.current;
    if (!path || !reviewBase || reviewBase.path !== path) return null;
    const body = bodies[path];
    if (body === undefined) return null;
    return diffBodies(reviewBase.body, body);
  }

  async undoChange(change: Change) {
    const diff = this.reviewDiff();
    const path = this.state.session.current;
    if (!diff || !path || !this.state.folder) return;
    try {
      const next = revertChange(diff, change);
      await platform.writePage(this.state.folder, path, serializePage(this.state.pages[path], next));
      this.set({ bodies: { ...this.state.bodies, [path]: next } });
      if (diffBodies(this.state.reviewBase?.body ?? "", next).changes.length === 0) await this.undoAll();
    } catch (e) {
      this.fail(e);
    }
  }

  async undoAll() {
    const path = this.state.session.current;
    const base = this.state.reviewBase;
    if (!path || !base || !this.state.folder) return;
    try {
      await platform.writePage(this.state.folder, path, serializePage(this.state.pages[path], base.body));
      await platform.deleteVersion(this.state.folder, path, base.n);
      const pending = { ...this.state.session.pending };
      delete pending[path];
      this.set({ bodies: { ...this.state.bodies, [path]: base.body }, reviewBase: undefined });
      this.setSession({ pending });
      await this.refreshVersions(path);
    } catch (e) {
      this.fail(e);
    }
  }

  done() {
    const path = this.state.session.current;
    if (!path) return;
    const pending = { ...this.state.session.pending };
    delete pending[path];
    this.setSession({ pending });
    this.set({ reviewBase: undefined });
  }

  // ---------- versions ----------

  private async refreshVersions(path: string) {
    if (!this.state.folder) return;
    try {
      const versions = await platform.listVersions(this.state.folder, path);
      this.set({ versions, versionBodies: {} });
    } catch {
      this.set({ versions: [], versionBodies: {} });
    }
  }

  toggleHistory() {
    this.setUi({ history: !this.state.ui.history, popover: undefined, selection: undefined });
  }

  async viewVersion(n: number) {
    const path = this.state.session.current;
    if (!path || !this.state.folder) return;
    try {
      if (this.state.versionBodies[n] === undefined) {
        const raw = await platform.readVersion(this.state.folder, path, n);
        this.set({ versionBodies: { ...this.state.versionBodies, [n]: stripFrontMatter(raw) } });
      }
      this.setUi({ viewing: n, history: false, confirmRestore: false, popover: undefined, selection: undefined, lookup: undefined });
    } catch (e) {
      this.fail(e);
    }
  }

  backToCurrent() {
    this.setUi({ viewing: undefined, confirmRestore: false });
  }

  askRestore() {
    this.setUi({ confirmRestore: true });
  }

  cancelRestore() {
    this.setUi({ confirmRestore: false });
  }

  async restore() {
    const path = this.state.session.current;
    const n = this.state.ui.viewing;
    if (!path || n === undefined || !this.state.folder) return;
    try {
      await platform.restoreVersion(this.state.folder, path, n);
      const page = await platform.readPage(this.state.folder, path);
      const pending = { ...this.state.session.pending };
      delete pending[path];
      this.set({ bodies: { ...this.state.bodies, [path]: page.body }, reviewBase: undefined });
      this.setSession({ pending });
      this.setUi({ viewing: undefined, confirmRestore: false });
      await this.refreshVersions(path);
    } catch (e) {
      this.fail(e);
    }
  }

  // ---------- commands from the menu bar ----------

  command(id: string) {
    switch (id) {
      case "open-folder":
        void this.pickFolder();
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
