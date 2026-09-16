import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from "react";
import { lookupId, refineToRetry, refineWorking, store, useReader, type PaneRole, type Selection } from "../state/store";
import type { Ask } from "../platform";
import { flexiblePattern, isStubBody, lexBlocks, resolveWikiTarget, type Block } from "../lib/markdown";
import { diffBodies, type Change, type PageDiff } from "../lib/diff";
import { applyWraps, rangeOffsets, type Wrap } from "../lib/wraps";
import { AnswerCard, AskPopover, BeforeCard, FailedCard, NowCard, RefinePopover, RefineStatus, SKELETON_FADE_MS, Skeleton } from "./Popovers";
import { TopStrip } from "./TopStrip";
import { FindBar } from "./FindBar";
import { DragBand } from "./DragBand";

type LinkState = "loading" | "unread" | "read" | "missing";

/** How long the pointer may be off a remembered ask and its card before the peeked card closes. */
const PEEK_GRACE_MS = 220;

/** A remembered ask placed on the page as it reads now. */
type PlacedAsk = { ask: Ask; index: number; block: number; start: number; end: number };

/**
 * Finds where each remembered ask's text sits in the page now. The saved offsets are tried first;
 * when a refine has moved the text, it is searched for; an ask whose text is gone is not shown.
 */
function placeAsks(asks: Ask[], blocks: Block[]): PlacedAsk[] {
  const squash = (t: string) => t.replace(/\s+/g, " ").trim();
  const out: PlacedAsk[] = [];
  asks.forEach((ask, index) => {
    const at = blocks[ask.block];
    if (at && at.type !== "space" && squash(at.text.slice(ask.start, ask.end)) === ask.text) {
      out.push({ ask, index, block: ask.block, start: ask.start, end: ask.end });
      return;
    }
    const re = flexiblePattern(ask.text);
    if (!re) return;
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].type === "space") continue;
      const m = re.exec(blocks[i].text);
      if (!m) continue;
      out.push({ ask, index, block: i, start: m.index, end: m.index + m[0].length });
      return;
    }
  });
  return out;
}

/** A span to tint. Empty spans (pure insertions or deletions) borrow the word before them so there is something to see. */
function displayRange(text: string, start: number, end: number): { start: number; end: number } {
  if (end > start) return { start, end };
  let s = start;
  while (s > 0 && /\s/.test(text[s - 1])) s--;
  while (s > 0 && !/\s/.test(text[s - 1])) s--;
  if (s === start) {
    let e = end;
    while (e < text.length && /\s/.test(text[e])) e++;
    while (e < text.length && !/\s/.test(text[e])) e++;
    return { start, end: e };
  }
  return { start: s, end: Math.max(end, start) };
}

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

type Props = { path: string; role: PaneRole };

export function Page({ path, role }: Props) {
  const s = useReader();
  const body = s.bodies[path];
  const meta = s.pages[path];
  const isMain = role === "main";
  const ui = s.ui;
  const loading = s.session.loading.includes(path);
  const stub = body !== undefined && isStubBody(body);
  // A page that failed to generate, or one left with only its heading, gets a retry card.
  const pageError = s.pageErrors[path];
  const unwritten = !loading && !!meta?.source && !!s.pages[meta.source] && (!!pageError || stub);

  // While a page is being written it shows a skeleton until the first text arrives. The skeleton
  // then fades out, and only once it is gone does the streamed text start to show: the page keeps
  // displaying its heading-only body for the length of the fade. The fade is decided during render
  // (from what the previous render saw) so the skeleton element stays mounted and its class change
  // can transition; an effect would unmount it for a frame first.
  const [prev, setPrev] = useState({ path, loading, stub, heading: stub ? body : undefined });
  const [fading, setFading] = useState(false);
  if (prev.path !== path || prev.loading !== loading || prev.stub !== stub) {
    // A page opened mid-stream already has text; it shows that text, not a skeleton.
    const startsFade = prev.path === path && prev.loading && loading && prev.stub && !stub;
    setPrev({ path, loading, stub, heading: stub ? body : prev.heading });
    setFading(startsFade);
  }
  useEffect(() => {
    if (!fading) return;
    const t = window.setTimeout(() => setFading(false), SKELETON_FADE_MS);
    return () => window.clearTimeout(t);
  }, [fading]);
  const waiting = loading && stub;
  const shownBody = fading ? (prev.heading ?? body) : body;
  const viewingN = ui.versionView[role].viewing;
  const [activeChange, setActiveChange] = useState<string | undefined>();
  const articleRef = useRef<HTMLDivElement>(null);

  // Any pane shows its page's pending changes, not just the main one.
  const reviewBase = s.reviewBases[path];
  const pendingN = s.session.pending[path];
  const reviewDiff: PageDiff | null = useMemo(() => {
    if (!reviewBase || body === undefined) return null;
    return diffBodies(reviewBase.body, body);
  }, [reviewBase, body]);
  useEffect(() => {
    if (pendingN && !reviewBase) store.ensureReview(path);
  }, [path, pendingN, reviewBase]);

  const viewDiff: PageDiff | null = useMemo(() => {
    if (viewingN === undefined || body === undefined) return null;
    const old = s.versionBodies[path]?.[viewingN];
    if (old === undefined) return null;
    return diffBodies(old, body);
  }, [viewingN, body, path, s.versionBodies]);

  const blocks: Block[] = useMemo(() => {
    if (viewDiff) return viewDiff.oldBlocks;
    if (reviewDiff) return reviewDiff.newBlocks;
    return lexBlocks(shownBody ?? "");
  }, [viewDiff, reviewDiff, shownBody]);

  const selection = ui.selection?.pane === role && !viewDiff ? ui.selection : undefined;

  // Every answer card in this pane draws at its own block, so several asks can stream side by side.
  const cards = useMemo(() => Object.entries(ui.lookups).filter(([, l]) => l.pane === role), [ui.lookups, role]);
  // Only one card is peeked at from hover at a time, and only that one closes when the pointer leaves.
  const peeked = cards.find(([, l]) => l.peek);
  const selectionCard = selection ? ui.lookups[lookupId(role, selection.block)] : undefined;
  // A selection refine's card sits at the highlight it was asked from, and that highlight is the one
  // still on screen, so the newest of this page's selection refines owns the spot. It shows the tool
  // line only when it holds the page's turn, as the pane-level cards do.
  const selectionRefine = useMemo(() => {
    const held = Object.entries(ui.refines)
      .filter(([, r]) => r.path === path && r.scope === "selection")
      .at(-1);
    if (!held) return undefined;
    const [id, run] = held;
    return { id, run, working: refineWorking(ui.refines, s.working)[id], hotkey: refineToRetry(ui.refines) === id };
  }, [ui.refines, s.working, path]);

  // Remembered asks stay on the page as dotted text; hovering one shows its answer again.
  const asks = s.session.asks?.[path];
  const placedAsks = useMemo(() => (asks?.length && !viewDiff ? placeAsks(asks, blocks) : []), [asks, blocks, viewDiff]);

  // ----- find in page -----
  // The find bar lives in the pane being read: the main one, or the split when it is fullscreen.
  const findHere = ui.find && (isMain ? !(ui.fullscreen && s.session.split) : ui.fullscreen);
  const findQuery = findHere ? ui.findQuery : "";
  const matches = useMemo(() => {
    const out: { block: number; start: number; end: number }[] = [];
    const q = findQuery.toLowerCase();
    if (!q.trim()) return out;
    blocks.forEach((b, i) => {
      if (b.type === "space") return;
      const text = b.text.toLowerCase();
      let from = 0;
      for (;;) {
        const at = text.indexOf(q, from);
        if (at < 0) break;
        out.push({ block: i, start: at, end: at + q.length });
        from = at + q.length;
      }
    });
    return out;
  }, [blocks, findQuery]);
  const findCurrent = matches.length ? ((ui.findIndex % matches.length) + matches.length) % matches.length : -1;
  const currentMatch = findCurrent >= 0 ? matches[findCurrent] : undefined;
  useEffect(() => {
    if (!currentMatch) return;
    articleRef.current?.querySelector(".fnd.cur")?.scrollIntoView({ block: "center" });
  }, [currentMatch?.block, currentMatch?.start, findQuery]);
  // Stepping to a match (⌘G, ↵, the arrows) selects it, so the ask or refine box opens there as if it had been dragged over.
  useEffect(() => {
    if (!ui.findSelect || !findHere || viewDiff || !currentMatch) return;
    const block = blocks[currentMatch.block];
    if (!block) return;
    const text = block.text.slice(currentMatch.start, currentMatch.end).replace(/\s+/g, " ").trim();
    if (!text) return;
    store.selectMatch({ pane: role, block: currentMatch.block, start: currentMatch.start, end: currentMatch.end, text, paragraph: block.text, caretX: midXFor(".fnd.cur") });
  }, [ui.findSelect]);
  // What has been typed into the ask/refine box; survives the ⌘R switch, resets with a new selection.
  const [draft, setDraft] = useState("");
  useEffect(() => {
    setDraft("");
  }, [selection?.block, selection?.start, selection?.end]);

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
      const text = blocks[i]?.text ?? "";
      out.set(
        i,
        list.map((c) => {
          const range = viewDiff ? displayRange(text, c.oldStart, c.oldEnd) : displayRange(text, c.start, c.end);
          return { ...range, className: viewDiff ? "oldchg" : "chg", attrs: { "data-change": c.id } };
        }),
      );
    }
    for (const p of placedAsks) {
      const list = out.get(p.block) ?? [];
      out.set(p.block, [...list, { start: p.start, end: p.end, className: "asked", attrs: { "data-asked": String(p.index) } }]);
    }
    if (selection) {
      const list = out.get(selection.block) ?? [];
      out.set(selection.block, [...list, { start: selection.start, end: selection.end, className: "sel" }]);
    }
    matches.forEach((m, j) => {
      const list = out.get(m.block) ?? [];
      out.set(m.block, [...list, { start: m.start, end: m.end, className: j === findCurrent ? "fnd cur" : "fnd" }]);
    });
    return out;
  }, [changesByBlock, placedAsks, selection, viewDiff, blocks, matches, findCurrent]);

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

  /** Horizontal midpoint of the elements a selector finds, in px from their block's left edge. */
  const midXFor = (selector: string): number => {
    const els = Array.from(articleRef.current?.querySelectorAll<HTMLElement>(selector) ?? []);
    const blockEl = els[0]?.closest<HTMLElement>(".block");
    if (!els.length || !blockEl) return 0;
    let left = Infinity;
    let right = -Infinity;
    for (const el of els) {
      for (const r of Array.from(el.getClientRects())) {
        left = Math.min(left, r.left);
        right = Math.max(right, r.right);
      }
    }
    if (!Number.isFinite(left)) return 0;
    return (left + right) / 2 - blockEl.getBoundingClientRect().left;
  };
  /** Horizontal midpoint of a change's highlight. */
  const caretXFor = (id: string): number => midXFor(`[data-change="${id}"]`);

  // ----- selection handling: either pane, with the box opening in the pane the text was highlighted in -----

  const onMouseUp = () => {
    if (viewDiff) return;
    const sel = window.getSelection();
    const root = articleRef.current;
    if (!sel || !root) return;
    if (sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const blockOf = (n: Node) => (n instanceof Element ? n : n.parentElement)?.closest<HTMLElement>(".block") ?? null;
    const startBlock = blockOf(range.startContainer);
    const endBlock = blockOf(range.endContainer);
    const block = endBlock ?? startBlock;
    if (!block) return;
    // Clamp a drag that began or ended outside this block to the block itself.
    if (startBlock !== block) range.setStart(block, 0);
    if (endBlock !== block) range.setEnd(block, block.childNodes.length);
    const index = Number(block.dataset.index);
    const offsets = rangeOffsets(block, range);
    if (!offsets || Number.isNaN(index)) return;
    const full = block.textContent ?? "";
    let { start, end } = offsets;
    while (start < end && /\s/.test(full[start])) start++;
    while (end > start && /\s/.test(full[end - 1])) end--;
    if (end <= start) return;
    const text = full.slice(start, end);
    const blockRect = block.getBoundingClientRect();
    const bounds = range.getBoundingClientRect();
    const selectionState: Selection = {
      pane: role,
      block: index,
      start,
      end,
      text: text.replace(/\s+/g, " ").trim(),
      paragraph: full,
      caretX: (bounds.left + bounds.right) / 2 - blockRect.left,
    };
    sel.removeAllRanges();
    store.setSelection(selectionState);
  };

  // ----- remembered asks: hover peeks at the answer, a click keeps it open -----

  // Esc usually leaves the pointer on the text it was asked about; that text does not peek again until the pointer has left it.
  const suppressed = useRef<{ block: number; text: string } | undefined>(undefined);
  const lastLookups = useRef(ui.lookups);
  if (lastLookups.current !== ui.lookups) {
    const prev = lastLookups.current;
    lastLookups.current = ui.lookups;
    for (const [id, l] of Object.entries(prev)) {
      if (ui.lookups[id] || l.peek || l.pane !== role || !l.anchor) continue;
      suppressed.current = { block: l.block, text: l.anchor.text };
    }
  }
  const peekTimer = useRef<number | undefined>(undefined);
  const cancelPeekClose = () => {
    window.clearTimeout(peekTimer.current);
    peekTimer.current = undefined;
  };
  useEffect(() => cancelPeekClose, []);
  const placedAskFor = (el: HTMLElement | null): PlacedAsk | undefined => {
    const span = el?.closest<HTMLElement>(".asked");
    if (!span) return undefined;
    return placedAsks.find((p) => String(p.index) === span.dataset.asked);
  };
  /** True when the element is the dotted text of the ask being peeked at, or the card showing it. */
  const keepsPeek = (el: HTMLElement | null): boolean => {
    if (!el || !peeked) return false;
    const card = el.closest<HTMLElement>(".card");
    if (card) return card.dataset.lookup === peeked[0];
    const p = placedAskFor(el);
    return !!p && p.block === peeked[1].block && p.ask.text === peeked[1].anchor?.text;
  };

  const onMouseDown = (e: ReactMouseEvent) => {
    const t = e.target as HTMLElement;
    const card = t.closest<HTMLElement>(".card");
    if (card?.dataset.lookup) store.pinAsk(card.dataset.lookup);
  };

  // A change's "Before"/"Now" card, and the ask/refine popover, close on a click anywhere else on the
  // page — not just inside the article — so clicks in the margins or the sidebar dismiss them too.
  useEffect(() => {
    if (activeChange === undefined && !ui.popover && !ui.selection) return;
    const close = (e: globalThis.MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest(".pop-wrap, .card, .top")) return;
      if (t.closest(".chg, .oldchg")) return;
      setActiveChange(undefined);
      // The card standing on this highlight is the ask box's continuation, so a click elsewhere leaves both.
      if ((ui.popover || ui.selection) && !selectionCard) store.closePopover();
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [activeChange, ui.popover, ui.selection, selectionCard]);

  const onClick = (e: ReactMouseEvent) => {
    const t = e.target as HTMLElement;
    const a = t.closest<HTMLAnchorElement>("a.wl");
    if (a) {
      e.preventDefault();
      void store.followWikiLink(a.dataset.target ?? "", e);
      return;
    }
    const asked = placedAskFor(t);
    if (asked) {
      cancelPeekClose();
      const id = lookupId(role, asked.block);
      if (ui.lookups[id]?.peek) store.pinAsk(id);
      else store.showAsk(role, asked.ask, asked, false);
      return;
    }
    const chg = t.closest<HTMLElement>(".chg, .oldchg");
    if (chg) setActiveChange(chg.dataset.change);
  };

  const onMouseOver = (e: ReactMouseEvent) => {
    const t = e.target as HTMLElement;
    if (keepsPeek(t)) {
      cancelPeekClose();
      return;
    }
    const asked = placedAskFor(t);
    if (asked && !ui.lookups[lookupId(role, asked.block)]) {
      const held = suppressed.current;
      if (held && held.block === asked.block && held.text === asked.ask.text) return;
      cancelPeekClose();
      store.showAsk(role, asked.ask, asked, true);
      return;
    }
    const chg = t.closest<HTMLElement>(".chg, .oldchg");
    if (chg && chg.dataset.change !== activeChange) setActiveChange(chg.dataset.change);
  };

  const onMouseOut = (e: ReactMouseEvent) => {
    const from = placedAskFor(e.target as HTMLElement);
    const to = placedAskFor(e.relatedTarget as HTMLElement | null);
    if (from && from.index !== to?.index) suppressed.current = undefined;
    if (!peeked || !keepsPeek(e.target as HTMLElement)) return;
    if (keepsPeek(e.relatedTarget as HTMLElement | null)) return;
    cancelPeekClose();
    peekTimer.current = window.setTimeout(() => {
      peekTimer.current = undefined;
      store.hideAskPeek();
    }, PEEK_GRACE_MS);
  };

  const source = meta?.source ? s.pages[meta.source] : undefined;
  const reviewChanges = reviewDiff?.changes ?? [];
  const versions = s.versions[path] ?? [];
  const versionsCurrentN = versions.length ? versions[versions.length - 1].n + 1 : 1;

  const renderAfter = (i: number) => {
    const out: ReactElement[] = [];
    // Keyed on the range so moving between find matches in one block refocuses the box.
    if (selection?.block === i && ui.popover === "ask") {
      out.push(
        <AskPopover
          key={`ask-${selection.start}-${selection.end}`}
          caretLeft={selection.caretX}
          value={draft}
          onChange={setDraft}
          onSubmit={(q, verb, alt) => {
            setDraft("");
            void store.ask(q, verb, alt);
          }}
          onEsc={() => store.closePopover()}
          onRefine={() => store.toggleRefine()}
        />,
      );
    }
    if (selection?.block === i && ui.popover === "refine") {
      out.push(
        <RefinePopover
          key={`refine-${selection.start}-${selection.end}`}
          caretLeft={selection.caretX}
          value={draft}
          onChange={setDraft}
          onSubmit={(text, scope) => void store.refine(text, scope)}
          onEsc={() => store.closePopover()}
          onToggle={() => store.toggleRefine()}
        />,
      );
    }
    if (selection?.block === i && !ui.popover && selectionRefine) {
      const { id, run, working, hotkey } = selectionRefine;
      out.push(
        <RefineStatus
          key="refine-status"
          scope="selection"
          text={run.text}
          working={working}
          error={run.error}
          hotkey={hotkey}
          caretLeft={selection.caretX}
          onRetry={() => store.retryRefine(id)}
          onDismiss={() => store.dismissRefine(id)}
        />,
      );
    }
    for (const [id, lookup] of cards) {
      if (lookup.block !== i) continue;
      out.push(
        <AnswerCard
          key={`lookup-${id}`}
          id={id}
          lookup={lookup}
          working={s.working[`lookup:${id}`]}
          onFollowUp={(q, verb, alt) => void store.ask(q, verb, alt, id)}
          onEsc={() => store.closeLookup(id)}
          onRefine={() => store.toggleRefine()}
        />,
      );
    }
    if (isMain && activeChange) {
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
                void store.undoChange(c, path);
              }}
            />,
          );
        }
      }
    }
    return out;
  };

  const onCrumb = (e: ReactMouseEvent) => {
    if (!meta?.source) return;
    // The crumb is a link to the parent, so ⌘ and ⌘⇧ clicks use the same placement settings as wiki links.
    const placement = store.placementFor(e);
    if (placement !== "active") {
      void store.openPage(meta.source, placement);
      return;
    }
    // In the split pane, going back to a parent the main pane already shows means "refocus on the parent":
    // closing this pane does that, and leaves the trail and read marks alone.
    if (!isMain && s.session.current === meta.source) {
      store.closeSplit();
      return;
    }
    void store.navigate(meta.source);
  };

  return (
    <>
      <DragBand />
      <TopStrip path={path} role={role} diff={reviewDiff}>
        {findHere && <FindBar count={matches.length} current={findCurrent} />}
      </TopStrip>
      <div className="article" ref={articleRef} onMouseUp={onMouseUp} onMouseDown={onMouseDown} onClick={onClick} onMouseOver={onMouseOver} onMouseOut={onMouseOut}>
        {source && (
          <div className="crumb" onClick={onCrumb} title={`Back to ${source.title}`}>
            <span className="arrow">↩</span>
            {source.title}
          </div>
        )}
        {body === undefined && <Skeleton />}
        {blocks.map((b, i) => (
          <div key={i}>
            {b.type === "space" ? null : (
              <BlockView html={b.html} wraps={wrapsFor.get(i) ?? EMPTY} className={`block${i === blocks.length - 1 && loading ? " streaming" : ""}`} index={i} linkState={linkState} />
            )}
            {renderAfter(i)}
          </div>
        ))}
        {(waiting || fading) && <Skeleton fading={fading} />}
        {waiting && s.working[`page:${path}`] && (
          <div className="tool-line">
            <span className="pulse" />
            {s.working[`page:${path}`]}…
          </div>
        )}
        {unwritten && (
          <FailedCard
            title={pageError ? "This page couldn't be written" : "This page hasn't been written yet"}
            error={pageError}
            // A failed refine's card is answered by ↵ first, so the two never take one press together.
            hotkey={isMain && !ui.popover && !Object.keys(ui.lookups).length && !refineToRetry(ui.refines)}
            onRetry={() => void store.retryPage(path)}
          />
        )}
      </div>
    </>
  );
}
