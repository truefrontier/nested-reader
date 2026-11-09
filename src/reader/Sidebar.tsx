import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { store, useReader } from "../state/store";
import { buildFolders, dotState, rootDirs, type FolderNode, type TreeItem } from "../lib/tree";
import { ChevronRight, MapIcon, MoreIcon, NestedLogo } from "./Icons";
import { RenameInput } from "./RenameInput";
import { AnchoredLayer, DeleteConfirm, EDGE } from "./AnchoredLayer";
import { DEFAULT_SETTINGS } from "../platform";
import { useSidebarGrip } from "./useSidebarGrip";
import { onEscapeFirst } from "../lib/escapeFirst";
import { moveFocus, PRESS, treeKey } from "../lib/keys";

const stop = (e: MouseEvent) => e.stopPropagation();

/**
 * A single-item menu that opens at the cursor, for the tree's empty area. Unlike `AnchoredLayer`,
 * which right-aligns under a row, this one just clamps to the viewport around the click point.
 */
function PointMenu({ at, children }: { at: { x: number; y: number } | null; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    setBox(null);
    const menu = ref.current;
    if (!menu || !at) return;
    const left = Math.max(EDGE, Math.min(at.x, window.innerWidth - menu.offsetWidth - EDGE));
    const top = Math.max(EDGE, Math.min(at.y, window.innerHeight - menu.offsetHeight - EDGE));
    setBox({ top, left });
  }, [at]);

  if (!at) return null;

  return createPortal(
    <div
      ref={ref}
      className={`row-menu${box ? " placed" : ""}`}
      role="menu"
      style={{ position: "fixed", top: box?.top ?? at.y, left: box?.left ?? at.x, visibility: box ? "visible" : "hidden" }}
      onMouseDown={stop}
      onClick={stop}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  );
}

export function Sidebar() {
  const s = useReader();
  // The roots added with ⌘⇧O are top folders of their own, named after their last segment.
  const roots = useMemo(() => rootDirs(s.session.roots, s.folder), [s.session.roots, s.folder]);
  // The path of each added file's own page (⌘⇧O on a .md, not a folder), so its row can offer
  // "Remove from session" directly — the only way to drop it when it has no root folder header
  // of its own (added from the session folder itself, or the lone file of a root folder elsewhere).
  const rootFilePaths = useMemo(() => {
    const set = new Set<string>();
    for (const r of s.session.roots ?? []) {
      if (r.file) set.add(r.folder === s.folder ? r.file : `${r.folder}/${r.file}`);
    }
    return set;
  }, [s.session.roots, s.folder]);
  const root = useMemo(() => buildFolders(s.pages, roots), [s.pages, roots]);
  const filterRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!s.ui.filterFocus) return;
    filterRef.current?.focus();
    filterRef.current?.select();
  }, [s.ui.filterFocus]);
  // Opening a page inside a closed folder opens the folder, so the current row is never hidden.
  useEffect(() => {
    if (s.session.current) store.revealInTree(s.session.current);
  }, [s.session.current]);
  // Esc clears the filter, then leaves the box. Enter opens the top row, as clicking it would.
  const onFilterKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      // While an input method composes, Enter confirms the text. WebKit reports that as keyCode 229.
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      e.stopPropagation();
      const first = firstShown(root);
      if (first) void store.openPage(first, store.placementFor(e));
      return;
    }
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    if (s.ui.filter) store.setFilter("");
    else e.currentTarget.blur();
  };
  const filter = s.ui.filter.trim().toLowerCase();
  // The two filter dots match the marks on the rows: unread (with pages still being written, or that
  // failed) and changes to review. A dot is only offered while some page carries its mark, and a filter
  // left on after its last page is gone is switched off, so the tree never sits empty behind it.
  const unreadMark = (path: string) => s.session.unread.includes(path) || s.session.loading.includes(path) || !!s.pageErrors[path];
  const changesMark = (path: string) => !!s.session.pending[path];
  const paths = Object.keys(s.pages);
  const anyUnread = paths.some(unreadMark);
  const anyChanges = paths.some(changesMark);
  const unreadOnly = s.ui.unreadOnly && anyUnread;
  const changesOnly = s.ui.changesOnly && anyChanges;
  useEffect(() => {
    if (s.ui.unreadOnly && !anyUnread) store.clearTreeFilter("unread");
    if (s.ui.changesOnly && !anyChanges) store.clearTreeFilter("changes");
  }, [s.ui.unreadOnly, s.ui.changesOnly, anyUnread, anyChanges]);
  // While filtering, every folder is open and one with nothing to show is left out.
  const filtering = !!filter || unreadOnly || changesOnly;
  const collapsed = s.session.collapsed ?? [];
  const shows = (it: TreeItem) => {
    const p = s.pages[it.path];
    if (!p) return false;
    if (filter && !p.title.toLowerCase().includes(filter) && !it.path.toLowerCase().includes(filter)) return false;
    // With both dots on, a page showing either mark is listed.
    if (unreadOnly || changesOnly) return (unreadOnly && unreadMark(it.path)) || (changesOnly && changesMark(it.path));
    return true;
  };
  // The top row of the tree, in the order `folder` below draws it: subfolders, then the folder's own pages.
  const firstShown = (f: FolderNode): string | undefined => {
    if (!filtering && collapsed.includes(f.path)) return undefined;
    return f.folders.map(firstShown).find(Boolean) ?? f.items.find(shows)?.path;
  };
  // Dragging the right edge resizes the sidebar; double-click resets it to the default width.
  const { onGripDown, onGripMove, onGripUp } = useSidebarGrip(s.settings.sidebarWidth);
  const onRow = (path: string) => (e: MouseEvent) => {
    e.preventDefault();
    void store.openPage(path, store.placementFor(e));
  };
  // Each row has a ⋯ menu (also on right-click), and so does the header of an added root, keyed "root:<folder>".
  // A menu, the rename box it opens, and the delete confirmation all close on a click anywhere else,
  // Esc (caught before the window's own Esc, so it doesn't also cancel a refine), or when the tree scrolls. The menu and confirmation sit in a body-level layer so a row
  // at the foot of a long tree still shows them in full, without scrolling the tree to reach them.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  // The row that opened the menu or confirmation, so the body-level layer can sit against it.
  const [layerAnchor, setLayerAnchor] = useState<HTMLElement | null>(null);
  // Right-clicking empty space in the tree (not a row or a root header, which have their own menus)
  // opens this instead, offering "Reload" and the same "Add to Session…" flow as ⌘⇧O.
  const [treeMenuAt, setTreeMenuAt] = useState<{ x: number; y: number } | null>(null);
  // The tree is one Tab stop (role="tree"): the row that last had focus, else the current page, else
  // the top row takes it, and the arrow keys move from there (see `treeKey`).
  const treeRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const focusKey = useRef<string | null>(null);
  const treeItems = () => [...(treeRef.current?.querySelectorAll<HTMLElement>("[role=treeitem]") ?? [])];
  const keyOf = (el: HTMLElement) => el.dataset.page ?? `dir:${el.dataset.folder}`;
  const rove = (to: HTMLElement | undefined, items = treeItems()) => {
    for (const el of items) el.tabIndex = el === to ? 0 : -1;
  };
  useLayoutEffect(() => {
    const items = treeItems();
    rove(items.find((el) => keyOf(el) === focusKey.current) ?? items.find((el) => el.getAttribute("aria-selected") === "true") ?? items[0], items);
  });
  const onTreeFocus = (e: FocusEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[role=treeitem]");
    if (!el || el !== e.target) return;
    focusKey.current = keyOf(el);
    rove(el);
  };
  // The row a menu was opened from with the keyboard, which takes the focus back when the menu is done.
  // A menu opened with the mouse leaves focus where the click put it.
  const returnTo = useRef<HTMLElement | null>(null);
  const refocus = () => {
    const el = returnTo.current;
    returnTo.current = null;
    if (!el) return;
    // A row that has gone (deleted, or dropped from the session) hands the focus to the tree's Tab stop.
    requestAnimationFrame(() => (el.isConnected ? el : treeRef.current?.querySelector<HTMLElement>('[role=treeitem][tabindex="0"]'))?.focus());
  };
  const closeMenus = () => {
    setMenuFor(null);
    setDeleting(null);
    setLayerAnchor(null);
    setTreeMenuAt(null);
    refocus();
  };
  useEffect(() => {
    if (!menuFor && !deleting && !treeMenuAt) return;
    const close = () => {
      returnTo.current = null;
      closeMenus();
    };
    window.addEventListener("mousedown", close);
    const stopEscape = onEscapeFirst(window, closeMenus);
    return () => {
      window.removeEventListener("mousedown", close);
      stopEscape();
    };
  }, [menuFor, deleting, treeMenuAt]);
  const onTreeContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    setMenuFor(null);
    setDeleting(null);
    setLayerAnchor(null);
    setTreeMenuAt({ x: e.clientX, y: e.clientY });
  };
  // A row whose page has left the session (deleted here or elsewhere) takes its menu and boxes with it.
  useEffect(() => {
    const gone = (key: string | null) => !!key && (key.startsWith("root:") ? !roots.includes(key.slice(5)) : !s.pages[key]);
    if (gone(menuFor)) {
      setMenuFor(null);
      if (!deleting || gone(deleting)) setLayerAnchor(null);
    }
    if (gone(deleting)) {
      setDeleting(null);
      if (!menuFor || gone(menuFor)) setLayerAnchor(null);
    }
    if (gone(renaming)) setRenaming(null);
  }, [menuFor, deleting, renaming, s.pages, roots]);
  // From the keyboard the first item (or the confirmation's Cancel) takes the focus, once the layer is
  // placed: it stays hidden until then, and a hidden element takes no focus.
  useEffect(() => {
    if (!returnTo.current || (!menuFor && !deleting)) return;
    const id = requestAnimationFrame(() => layerRef.current?.querySelector<HTMLElement>(menuFor ? "[role=menuitem]" : ".acts .c")?.focus());
    return () => cancelAnimationFrame(id);
  }, [menuFor, deleting]);
  // Keys pressed in a menu stay there, so Enter on an item doesn't also retry a failed page. Tab leaves.
  const onMenuKey = (e: KeyboardEvent) => {
    if (!e.metaKey) e.stopPropagation();
    if (e.key === "Tab") {
      e.preventDefault();
      closeMenus();
    } else if (moveFocus(e.currentTarget, "[role=menuitem]", e.key)) e.preventDefault();
  };
  // An item closes the menu, does its job, and hands the focus back to the row it was opened from.
  const pick = (run: () => void) => () => {
    setMenuFor(null);
    run();
    refocus();
  };
  const openMenuFromKeys = (key: string, row: HTMLElement) => {
    setDeleting(null);
    setMenuFor(key);
    setLayerAnchor(row);
    returnTo.current = row;
  };
  const onTreeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = treeItems();
    const at = items.indexOf(e.target as HTMLElement);
    if (at < 0) return;
    const rows = items.map((el) => ({
      level: Number(el.getAttribute("aria-level")),
      expanded: el.hasAttribute("aria-expanded") ? el.getAttribute("aria-expanded") === "true" : undefined,
    }));
    const move = treeKey(e.key, e.shiftKey, rows, at);
    if (!move) return;
    e.preventDefault();
    e.stopPropagation();
    const row = items[at];
    const { page, folder: dir, menu } = row.dataset;
    if ("focus" in move) items[move.focus].focus();
    else if ("expand" in move || "collapse" in move) store.toggleFolder(dir as string);
    else if ("activate" in move) {
      if (page) void store.openPage(page, store.placementFor(e));
      else store.toggleFolder(dir as string);
    } else if (menu) openMenuFromKeys(menu, row);
  };
  const openMenu = (path: string) => (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    returnTo.current = null;
    setDeleting(null);
    if (menuFor === path) {
      setMenuFor(null);
      setLayerAnchor(null);
    } else {
      setMenuFor(path);
      setLayerAnchor((e.currentTarget as HTMLElement).closest(".row, .frow") as HTMLElement);
    }
  };
  // Delete asks from the row itself, until "Do not ask again" has been ticked once.
  const askDelete = (path: string) => {
    if (!s.settings.confirmDelete) {
      void store.deletePage(path);
      refocus();
      return;
    }
    setDeleting(path);
  };
  // `level` is the tree depth (aria-level) of the folder's own pages; a page hung under another sits deeper.
  const rows = (items: TreeItem[], level: number) => {
    const visible = items.filter(shows);
    if (!visible.length) return null;
    return (
      <div className="rows">
        {visible.length > 1 && <div className="tree-line" />}
        {visible.map((it) => {
          const p = s.pages[it.path];
          const d = dotState(it.path, s.session);
          const cls = ["row", `d${Math.min(it.depth, 3)}`];
          if (d === "current") cls.push("current");
          const unread = s.session.unread.includes(it.path);
          const open = menuFor === it.path;
          const confirming = deleting === it.path;
          if (open || confirming) cls.push("open");
          const showTick = it.branch && !filtering;
          const isRootFile = rootFilePaths.has(it.path);
          // A page nested inside an added root, other than the root's own file, can be dropped on its own.
          const nestedInRoot = !isRootFile && roots.some((r) => it.path.startsWith(r + "/"));
          // The marks are dots a screen reader can't see, so the row's name says them.
          const name = [p.title, !!s.pageErrors[it.path] && "couldn't be written", d === "loading" && "being written", unread && "unread", !!s.session.pending[it.path] && "changes to review"];
          return (
            <div
              key={it.path}
              className={cls.join(" ")}
              role="treeitem"
              aria-level={level + it.depth}
              aria-selected={d === "current"}
              aria-label={name.filter(Boolean).join(", ")}
              tabIndex={-1}
              data-page={it.path}
              data-menu={it.path}
              onClick={onRow(it.path)}
              onContextMenu={openMenu(it.path)}
              title={p.title}
            >
              {showTick && <span className="tick" />}
              <span className={`dot ${d === "current" ? "current" : d === "loading" ? "loading" : ""}`} />
              {renaming === it.path ? (
                <RenameInput
                  value={p.title}
                  onDone={(name) => {
                    setRenaming(null);
                    if (name !== null) void store.renamePage(it.path, name);
                    refocus();
                  }}
                />
              ) : (
                <span className={`label${d === "loading" ? " shimmer" : ""}`}>{p.title}</span>
              )}
              <span className="marks">
                {!!s.pageErrors[it.path] && <span className="fdot" title="Couldn't be written. Open it to try again." />}
                {unread && <span className="udot" title="Unread" />}
                {!!s.session.pending[it.path] && <span className="cdot" title="Changes to review" />}
              </span>
              {/* Out of the Tab order: the keyboard opens the same menu with ⇧F10 on the row. */}
              <span className="more" role="button" tabIndex={-1} aria-label="More" aria-haspopup="menu" aria-expanded={open} title="More" onMouseDown={stop} onClick={openMenu(it.path)}>
                <MoreIcon />
              </span>
              {open && (
                <AnchoredLayer anchor={layerAnchor ?? undefined} className="row-menu">
                  <div ref={layerRef} role="menu" aria-label={`Page “${p.title}”`} tabIndex={-1} onKeyDown={onMenuKey}>
                    <button type="button" role="menuitem" tabIndex={-1} className="item" onClick={pick(() => store.toggleUnread(it.path))}>
                      {unread ? "Mark read" : "Mark unread"}
                    </button>
                    <div className="sep" role="separator" />
                    <button
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      className="item"
                      onClick={() => {
                        setMenuFor(null);
                        setRenaming(it.path);
                      }}
                    >
                      Rename
                    </button>
                    <button type="button" role="menuitem" tabIndex={-1} className="item" onClick={pick(() => void store.revealPage(it.path))}>
                      Reveal in Finder
                    </button>
                    {isRootFile && (
                      <button type="button" role="menuitem" tabIndex={-1} className="item" onClick={pick(() => void store.removeRootFile(it.path))}>
                        Remove from session
                      </button>
                    )}
                    {nestedInRoot && (
                      <button type="button" role="menuitem" tabIndex={-1} className="item" onClick={pick(() => void store.excludeFromSession(it.path))}>
                        Remove from session
                      </button>
                    )}
                    <div className="sep" role="separator" />
                    <button
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      className="item warn"
                      onClick={() => {
                        setMenuFor(null);
                        askDelete(it.path);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </AnchoredLayer>
              )}
              {confirming && (
                <AnchoredLayer anchor={layerAnchor ?? undefined} className="row-confirm" stretch>
                  <div ref={layerRef} role="dialog" aria-label="Delete page" tabIndex={-1} onKeyDown={(e) => !e.metaKey && e.stopPropagation()}>
                    <DeleteConfirm
                      title={p.title}
                      onCancel={() => {
                        setDeleting(null);
                        refocus();
                      }}
                      onDelete={(dontAsk) => {
                        setDeleting(null);
                        void store.deletePage(it.path, dontAsk);
                        refocus();
                      }}
                    />
                  </div>
                </AnchoredLayer>
              )}
            </div>
          );
        })}
      </div>
    );
  };
  // A folder is its subfolders, then its own pages. Only the session folder itself has no header.
  // The session folder itself has no row, so its subfolders and pages start at level 1.
  const folder = (f: FolderNode, level: number): ReactNode => {
    const kids = f.folders.map((sub) => folder(sub, level + 1)).filter(Boolean);
    const own = rows(f.items, level + 1);
    if (!f.path)
      return (
        <>
          {kids}
          {own}
        </>
      );
    if (!kids.length && !own) return null;
    const open = filtering || !collapsed.includes(f.path);
    const menuKey = `root:${f.path}`;
    // The root folder of an added root drops the whole root; a folder nested inside one drops just its pages.
    const removable = f.root ? "root" : roots.some((r) => f.path.startsWith(r + "/")) ? "nested" : undefined;
    const menuOpen = !!removable && menuFor === menuKey;
    return (
      <div key={f.path} className={`folder${open ? " open" : ""}${f.root ? " root" : ""}`}>
        <div
          className={`frow${menuOpen ? " open" : ""}`}
          role="treeitem"
          aria-level={level}
          aria-expanded={open}
          aria-label={f.name}
          tabIndex={-1}
          data-folder={f.path}
          data-menu={removable ? menuKey : undefined}
          onClick={() => store.toggleFolder(f.path)}
          onContextMenu={removable ? openMenu(menuKey) : undefined}
          title={f.path}
        >
          <span className="chev">
            <ChevronRight />
          </span>
          <span className="label">{f.name}</span>
          {removable && (
            <span className="more" role="button" tabIndex={-1} aria-label="More" aria-haspopup="menu" aria-expanded={menuOpen} title="More" onMouseDown={stop} onClick={openMenu(menuKey)}>
              <MoreIcon />
            </span>
          )}
          {menuOpen && (
            <AnchoredLayer anchor={layerAnchor ?? undefined} className="row-menu">
              <div ref={layerRef} role="menu" aria-label={`Folder “${f.name}”`} tabIndex={-1} onKeyDown={onMenuKey}>
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className="item"
                  onClick={pick(() => void (removable === "root" ? store.removeRoot(f.path) : store.excludeFromSession(f.path)))}
                >
                  Remove from session
                </button>
              </div>
            </AnchoredLayer>
          )}
        </div>
        {open && (
          <div className="fbody">
            {kids}
            {own}
          </div>
        )}
      </div>
    );
  };
  return (
    <aside className="side">
      <div className="side-head">
        <span className="brand" {...PRESS} aria-label="Home" title="Home ⌘⇧H" onClick={() => store.goHome()}>
          <NestedLogo />
        </span>
        <button className={`tbtn side-map${s.ui.map ? " on" : ""}`} title="Session map ⌘K" aria-pressed={!!s.ui.map} onClick={() => store.openMap("web")}>
          <MapIcon />
        </button>
      </div>
      <div className="side-filter">
        <input
          ref={filterRef}
          placeholder="Filter"
          title="Filter files /"
          value={s.ui.filter}
          onChange={(e) => store.setFilter(e.target.value)}
          onKeyDown={onFilterKey}
          spellCheck={false}
        />
        {anyUnread && (
          <span className={`filter-btn${unreadOnly ? " on" : ""}`} {...PRESS} aria-pressed={unreadOnly} aria-label="Unread only" title="Unread only" onClick={() => store.toggleUnreadOnly()}>
            <span className="udot" />
          </span>
        )}
        {anyChanges && (
          <span
            className={`filter-btn${changesOnly ? " on" : ""}`}
            {...PRESS}
            aria-pressed={changesOnly}
            aria-label="Changes to review only"
            title="Changes to review only"
            onClick={() => store.toggleChangesOnly()}
          >
            <span className="cdot" />
          </span>
        )}
      </div>
      <div className="tree" onScroll={() => (menuFor || deleting) && closeMenus()} onContextMenu={onTreeContextMenu}>
        {/* A click on a row sends the focus to the page body, as it did before rows could take it, so the
            window's ↵ still retries a failed page; once the keyboard is in the tree, a click moves it to that row. */}
        <div
          className="tree-inner"
          ref={treeRef}
          role="tree"
          aria-label="Pages"
          onKeyDown={onTreeKey}
          onFocus={onTreeFocus}
          onMouseDown={(e) => {
            if (treeRef.current?.contains(document.activeElement)) return;
            e.preventDefault();
            (document.activeElement as HTMLElement | null)?.blur();
          }}
        >
          {folder(root, 0)}
        </div>
      </div>
      <PointMenu at={treeMenuAt}>
        <button
          type="button"
          role="menuitem"
          className="item"
          onClick={() => {
            setTreeMenuAt(null);
            void store.reload();
          }}
        >
          Reload
        </button>
        <div className="sep" role="separator" />
        <button
          type="button"
          role="menuitem"
          className="item"
          onClick={() => {
            setTreeMenuAt(null);
            void store.addRoot();
          }}
        >
          Add to Session…
        </button>
      </PointMenu>
      <div className="side-foot">
        <span className={`link${s.ui.panePopover === "feedback" ? " on" : ""}`} {...PRESS} aria-expanded={s.ui.panePopover === "feedback"} onClick={() => store.toggleFeedback()} title="A bug, an idea, anything">
          Send feedback
        </span>
      </div>
      <div
        className="side-grip"
        title="Drag to resize"
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={onGripUp}
        onDoubleClick={() => void store.setSidebarWidth(DEFAULT_SETTINGS.sidebarWidth)}
      />
    </aside>
  );
}
