import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from "react";
import { store, useReader, type Selection } from "../state/store";
import { lexBlocks, resolveWikiTarget, type Block } from "../lib/markdown";
import { diffBodies, type Change, type PageDiff } from "../lib/diff";
import { applyWraps, rangeOffsets, type Wrap } from "../lib/wraps";
import { AnswerCard, AskPopover, BeforeCard, NowCard, RefinePopover } from "./Popovers";
import { TopStrip } from "./TopStrip";

type LinkState = "loading" | "unread" | "read" | "missing";

function BlockView({ html, wraps, className, index, linkState }: { html: string; wraps: Wrap[]; className: string; index: number; linkState: (target: string) => LinkState }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = html;
    applyWraps(el, wraps);
    for (const a of Array.from(el.querySelectorAll<HTMLAnchorElement>("a.wl"))) {
      a.dataset.state = linkState(a.dataset.target ?? "");
    }
  }, [html, wraps, linkState]);
  return <div ref={ref} className={className} data-index={index} />;
}

type Props = { path: string; role: "main" | "split" };

export function Page({ path, role }: Props) {
  const s = useReader();
  const body = s.bodies[path];
  const meta = s.pages[path];
  const isMain = role === "main";
  const ui = s.ui;
  const loading = s.session.loading.includes(path);
  const viewingN = isMain ? ui.viewing : undefined;
  const [activeChange, setActiveChange] = useState<string | undefined>();
  const articleRef = useRef<HTMLDivElement>(null);

  const reviewDiff: PageDiff | null = useMemo(() => {
    if (!isMain || !s.reviewBase || s.reviewBase.path !== path || body === undefined) return null;
    return diffBodies(s.reviewBase.body, body);
  }, [isMain, s.reviewBase, path, body]);

  const viewDiff: PageDiff | null = useMemo(() => {
    if (viewingN === undefined || body === undefined) return null;
    const old = s.versionBodies[viewingN];
    if (old === undefined) return null;
    return diffBodies(old, body);
  }, [viewingN, body, s.versionBodies]);

  const blocks: Block[] = useMemo(() => {
    if (viewDiff) return viewDiff.oldBlocks;
    if (reviewDiff) return reviewDiff.newBlocks;
    return lexBlocks(body ?? "");
  }, [viewDiff, reviewDiff, body]);

  const selection = isMain && !viewDiff ? ui.selection : undefined;

  const changesByBlock = useMemo(() => {
    const map = new Map<number, Change[]>();
    if (viewDiff) {
      for (const c of viewDiff.changes) {
        if (c.oldBlock < 0) continue;
        map.set(c.oldBlock, [...(map.get(c.oldBlock) ?? []), c]);
      }
    } else if (reviewDiff) {
      for (const c of reviewDiff.changes) {
        if (c.block < 0) continue;
        map.set(c.block, [...(map.get(c.block) ?? []), c]);
      }
    }
    return map;
  }, [viewDiff, reviewDiff]);

  const wrapsFor = useMemo(() => {
    const out = new Map<number, Wrap[]>();
    for (const [i, list] of changesByBlock) {
      out.set(
        i,
        list.map((c) =>
          viewDiff
            ? { start: c.oldStart, end: c.oldEnd, className: "oldchg", attrs: { "data-change": c.id } }
            : { start: c.start, end: c.end, className: "chg", attrs: { "data-change": c.id } },
        ),
      );
    }
    if (selection && !ui.lookup) {
      const list = out.get(selection.block) ?? [];
      out.set(selection.block, [...list, { start: selection.start, end: selection.end, className: "sel" }]);
    }
    return out;
  }, [changesByBlock, selection, viewDiff, ui.lookup]);

  const EMPTY: Wrap[] = useMemo(() => [], []);

  const linkState = useCallback(
    (target: string): LinkState => {
      const p = resolveWikiTarget(target, Object.keys(s.pages));
      if (!p) return "missing";
      if (s.session.loading.includes(p)) return "loading";
      if (s.session.unread.includes(p)) return "unread";
      return "read";
    },
    [s.pages, s.session.loading, s.session.unread],
  );

  useEffect(() => {
    const el = articleRef.current;
    if (!el) return;
    for (const n of Array.from(el.querySelectorAll(".chg.hover, .oldchg.hover"))) n.classList.remove("hover");
    if (activeChange) for (const n of Array.from(el.querySelectorAll(`[data-change="${activeChange}"]`))) n.classList.add("hover");
  }, [activeChange, blocks, wrapsFor]);

  useEffect(() => {
    setActiveChange(undefined);
  }, [reviewDiff, viewDiff]);

  const caretXFor = (id: string): number => {
    const el = articleRef.current?.querySelector<HTMLElement>(`[data-change="${id}"]`);
    if (!el) return 60;
    const blockEl = el.closest<HTMLElement>(".block");
    if (!blockEl) return 60;
    return el.getBoundingClientRect().left - blockEl.getBoundingClientRect().left + Math.min(el.getBoundingClientRect().width / 2, 80);
  };

  // ----- selection handling (main pane only) -----

  const onMouseUp = () => {
    if (!isMain || viewDiff) return;
    const sel = window.getSelection();
    const root = articleRef.current;
    if (!sel || !root) return;
    if (sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const text = range.toString();
    if (!text.trim()) return;
    const startBlock = (range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement)?.closest<HTMLElement>(".block");
    const endBlock = (range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement)?.closest<HTMLElement>(".block");
    if (!startBlock || startBlock !== endBlock) return;
    const index = Number(startBlock.dataset.index);
    const offsets = rangeOffsets(startBlock, range);
    if (!offsets || Number.isNaN(index)) return;
    const blockRect = startBlock.getBoundingClientRect();
    const rects = range.getClientRects();
    const last = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    const selectionState: Selection = {
      block: index,
      start: offsets.start,
      end: offsets.end,
      text: text.replace(/\s+/g, " ").trim(),
      paragraph: startBlock.textContent ?? "",
      caretX: last.right - blockRect.left,
    };
    sel.removeAllRanges();
    store.setSelection(selectionState);
  };

  const onMouseDown = (e: ReactMouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest(".pop-wrap, .card, .top")) return;
    if (t.closest(".chg, .oldchg")) return;
    setActiveChange(undefined);
    if (isMain && (ui.popover || ui.selection) && !ui.lookup) store.closePopover();
  };

  const onClick = (e: ReactMouseEvent) => {
    const t = e.target as HTMLElement;
    const a = t.closest<HTMLAnchorElement>("a.wl");
    if (a) {
      e.preventDefault();
      void store.followWikiLink(a.dataset.target ?? "", e);
      return;
    }
    const chg = t.closest<HTMLElement>(".chg, .oldchg");
    if (chg) setActiveChange(chg.dataset.change);
  };

  const onMouseOver = (e: ReactMouseEvent) => {
    const chg = (e.target as HTMLElement).closest<HTMLElement>(".chg, .oldchg");
    if (chg && chg.dataset.change !== activeChange) setActiveChange(chg.dataset.change);
  };

  const source = meta?.source ? s.pages[meta.source] : undefined;
  const reviewChanges = reviewDiff?.changes ?? [];
  const versionsCurrentN = s.versions.length ? s.versions[s.versions.length - 1].n + 1 : 1;

  const renderAfter = (i: number) => {
    const out: ReactElement[] = [];
    if (isMain) {
      if (selection?.block === i && ui.popover === "ask") {
        out.push(
          <AskPopover
            key="ask"
            caretLeft={selection.caretX}
            onSubmit={(q, verb, alt) => void store.ask(q, verb, alt)}
            onEsc={() => store.closePopover()}
            onRefine={() => store.toggleRefine()}
          />,
        );
      }
      if (selection?.block === i && ui.popover === "refine") {
        out.push(
          <RefinePopover
            key="refine"
            caretLeft={selection.caretX}
            onSubmit={(text, scope) => void store.refine(text, scope)}
            onEsc={() => store.closePopover()}
            onToggle={() => store.toggleRefine()}
          />,
        );
      }
      if (ui.lookup?.block === i) {
        out.push(<AnswerCard key="lookup" lookup={ui.lookup} onFollowUp={(q, verb, alt) => void store.ask(q, verb, alt)} onEsc={() => store.closeLookup()} />);
      }
      if (activeChange) {
        const list = changesByBlock.get(i) ?? [];
        const c = list.find((x) => x.id === activeChange);
        if (c) {
          if (viewDiff) {
            out.push(<NowCard key="now" change={c} versionN={versionsCurrentN} caretLeft={caretXFor(c.id)} />);
          } else {
            const index = reviewChanges.findIndex((x) => x.id === c.id) + 1;
            out.push(
              <BeforeCard
                key="before"
                change={c}
                index={index}
                total={reviewChanges.length}
                caretLeft={caretXFor(c.id)}
                onUndo={() => {
                  setActiveChange(undefined);
                  void store.undoChange(c);
                }}
              />,
            );
          }
        }
      }
    }
    return out;
  };

  const onCrumb = () => {
    if (!meta?.source) return;
    void store.navigate(meta.source);
  };

  return (
    <>
      {isMain && <TopStrip diff={reviewDiff} />}
      <div className="article" ref={articleRef} onMouseUp={onMouseUp} onMouseDown={onMouseDown} onClick={onClick} onMouseOver={onMouseOver}>
        {source && (
          <div className="crumb" onClick={onCrumb} title={`Back to ${source.title}`}>
            <span className="arrow">↩</span>
            {source.title}
          </div>
        )}
        {body === undefined && <div className="skeleton"><div /><div style={{ width: "78%" }} /></div>}
        {blocks.map((b, i) => (
          <div key={i}>
            {b.type === "space" ? null : (
              <BlockView html={b.html} wraps={wrapsFor.get(i) ?? EMPTY} className={`block${i === blocks.length - 1 && loading ? " streaming" : ""}`} index={i} linkState={linkState} />
            )}
            {renderAfter(i)}
          </div>
        ))}
        {loading && (
          <div className="skeleton">
            <div />
            <div style={{ width: "78%" }} />
          </div>
        )}
      </div>
    </>
  );
}
