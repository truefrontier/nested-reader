import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Lookup, NewFileVerb, Verb } from "../state/store";
import type { Change } from "../lib/diff";
import type { RefineScope } from "../lib/prompts";
import { FEEDBACK_MAX } from "../platform";

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}

export function Caret({ left }: { left: number }) {
  return <div className="caret" style={{ left }} />;
}

/**
 * An in-flow popover centred under its block. The caret points at `caretX`,
 * measured in px from the block's left edge, and is clamped to the popover.
 */
export function PopWrap({ caretX, width, className, children }: { caretX: number; width?: number; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const place = () => {
      // The wrap and the block are siblings, so the parent's left edge is the block's left edge.
      const popLeft = el.getBoundingClientRect().left - parent.getBoundingClientRect().left;
      setLeft(Math.round(Math.min(Math.max(caretX - popLeft, 14), el.offsetWidth - 24)));
    };
    place();
    // Bring a popover that lands below the fold into view; only on mount/reposition, not on every
    // resize, so it doesn't fight the user by re-scrolling as the box grows while they type.
    if (el.getBoundingClientRect().bottom > window.innerHeight) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    const ro = new ResizeObserver(place);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [caretX]);
  return (
    <div ref={ref} className={`pop-wrap${className ? ` ${className}` : ""}`} style={width ? { width } : undefined}>
      {left !== undefined && <Caret left={left} />}
      {children}
    </div>
  );
}

type Submit = (text: string, verb: Verb, alt: boolean) => void;

/** How long the skeleton takes to fade before the first streamed text shows. Matches `.skeleton` in app.css. */
export const SKELETON_FADE_MS = 260;

/** Two pulsing bars that stand in for text still on its way. `fading` runs the exit transition. */
export function Skeleton({ fading }: { fading?: boolean }) {
  return (
    <div className={`skeleton${fading ? " fading" : ""}`}>
      <div />
      <div style={{ width: "78%" }} />
    </div>
  );
}

/**
 * Whether to show a skeleton for an answer that is still empty, and whether it is fading out.
 * As on a page, the first text starts the fade and only shows once the skeleton is gone; the
 * decision is made during render so the skeleton stays mounted and its class change can transition.
 */
function useAnswerSkeleton(lookup: Lookup) {
  const waiting = lookup.streaming && !lookup.answer && !lookup.error;
  const [prevWaiting, setPrevWaiting] = useState(waiting);
  const [fading, setFading] = useState(false);
  if (prevWaiting !== waiting) {
    setPrevWaiting(waiting);
    // Text arriving starts the fade; an error or a stream that ended empty shows its result at once.
    setFading(prevWaiting && !waiting && !!lookup.answer && !lookup.error);
  }
  useEffect(() => {
    if (!fading) return;
    const t = window.setTimeout(() => setFading(false), SKELETON_FADE_MS);
    return () => window.clearTimeout(t);
  }, [fading]);
  return { show: waiting || fading, fading };
}

function verbFor(e: KeyboardEvent): Verb | null {
  if (e.key !== "Enter") return null;
  if (e.metaKey && e.shiftKey) return "deep";
  if (e.metaKey) return "page";
  return "quick";
}

function useAutoFocus(enabled = true) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!enabled) return;
    const t = window.setTimeout(() => ref.current?.focus({ preventScroll: true }), 60);
    return () => window.clearTimeout(t);
  }, [enabled]);
  return ref;
}

export function AskVerbs({ onVerb, onEsc, onToggle }: { onVerb: (v: Verb, alt: boolean) => void; onEsc: () => void; onToggle?: () => void }) {
  return (
    <div className="verbs">
      <span className="verb" onClick={(e) => onVerb("quick", e.altKey)}>
        <Kbd>↵</Kbd>Quick Answer
      </span>
      <span className="verb" onClick={(e) => onVerb("page", e.altKey)}>
        <Kbd>⌘↵</Kbd>New Page
      </span>
      <span className="verb" onClick={(e) => onVerb("deep", e.altKey)}>
        <Kbd>⌘⇧↵</Kbd>Deep Dive
      </span>
      <span className="tail">
        {onToggle && (
          <span className="verb" onClick={onToggle}>
            <Kbd>⌘R</Kbd>Refine
          </span>
        )}
        <span className="verb esc" onClick={onEsc}>
          Esc
        </span>
      </span>
    </div>
  );
}

/** The typed text lives in the parent so it survives the ⌘R switch to the refine box and back. */
export function AskPopover({
  caretLeft,
  value,
  onChange,
  onSubmit,
  onEsc,
  onRefine,
}: {
  caretLeft: number;
  value: string;
  onChange: (v: string) => void;
  onSubmit: Submit;
  onEsc: () => void;
  onRefine: () => void;
}) {
  const ref = useAutoFocus();
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      // Only this box closes; the window's Esc would otherwise also close whatever sits behind it.
      e.stopPropagation();
      return onEsc();
    }
    if (e.key === "r" && e.metaKey) {
      e.preventDefault();
      return onRefine();
    }
    const v = verbFor(e);
    if (v) {
      e.preventDefault();
      onSubmit(value, v, e.altKey);
    }
  };
  return (
    <PopWrap caretX={caretLeft}>
      <div className="pop">
        <input ref={ref} data-ask="1" placeholder="Ask something…" value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} spellCheck={false} />
        <AskVerbs onVerb={(v, alt) => onSubmit(value, v, alt)} onEsc={onEsc} onToggle={onRefine} />
      </div>
    </PopWrap>
  );
}

export function RefineVerbs({
  onScope,
  onEsc,
  onToggle,
  selectionEnabled,
}: {
  onScope: (s: RefineScope) => void;
  onEsc: () => void;
  onToggle?: () => void;
  selectionEnabled: boolean;
}) {
  return (
    <div className="verbs">
      <span className={`verb${selectionEnabled ? "" : " off"}`} onClick={() => selectionEnabled && onScope("selection")}>
        <Kbd>↵</Kbd>Refine selection
      </span>
      <span className="verb" onClick={() => onScope("page")}>
        <Kbd>⌘↵</Kbd>Refine page
      </span>
      <span className="verb" onClick={() => onScope("corpus")}>
        <Kbd>⌘⇧↵</Kbd>Refine corpus
      </span>
      <span className="tail">
        {onToggle && (
          <span className="verb" onClick={onToggle}>
            <Kbd>⌘R</Kbd>Ask
          </span>
        )}
        <span className="verb esc" onClick={onEsc}>
          Esc
        </span>
      </span>
    </div>
  );
}

/**
 * In-flow, the text is controlled by the page (`value`/`onChange`) so ⌘R keeps it;
 * the pane variant keeps its own, seeded with `initial` when reopened for a retry.
 */
export function RefinePopover({
  caretLeft,
  pane,
  value,
  onChange,
  initial,
  onSubmit,
  onEsc,
  onToggle,
}: {
  caretLeft?: number;
  pane?: boolean;
  value?: string;
  onChange?: (v: string) => void;
  initial?: string;
  onSubmit: (instruction: string, scope: RefineScope) => void;
  onEsc: () => void;
  onToggle: () => void;
}) {
  const ref = useAutoFocus();
  const [local, setLocal] = useState(initial ?? "");
  const text = value ?? local;
  const setText = onChange ?? setLocal;
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      // Only this box closes; the window's Esc would otherwise also close whatever sits behind it.
      e.stopPropagation();
      return onEsc();
    }
    if (e.key === "r" && e.metaKey) {
      e.preventDefault();
      return onToggle();
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (e.metaKey && e.shiftKey) return onSubmit(text, "corpus");
    if (e.metaKey) return onSubmit(text, "page");
    if (!pane) onSubmit(text, "selection");
  };
  const body = (
    <div className="pop">
      <input
        ref={ref}
        data-ask="1"
        placeholder={pane ? "What should change?" : "How should this read?"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        spellCheck={false}
      />
      <RefineVerbs selectionEnabled={!pane} onScope={(scope) => onSubmit(text, scope)} onEsc={onEsc} onToggle={pane ? undefined : onToggle} />
    </div>
  );
  if (pane) return <div className="pane-pop">{body}</div>;
  return (
    <PopWrap caretX={caretLeft ?? 0}>
      {body}
    </PopWrap>
  );
}

/**
 * The ⌘N box at the bottom of the pane: a brief for a page written from the whole session.
 * The verbs read like the ask popover's, but ↵ opens the page here since there is no highlight to answer inline.
 */
export function NewFilePopover({ onSubmit, onEsc }: { onSubmit: (brief: string, verb: NewFileVerb, alt: boolean) => void; onEsc: () => void }) {
  const ref = useAutoFocus();
  const [text, setText] = useState("");
  const submit = (verb: NewFileVerb, alt: boolean) => text.trim() && onSubmit(text, verb, alt);
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      // Only this box closes; the window's Esc would otherwise also close whatever sits behind it.
      e.stopPropagation();
      return onEsc();
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    submit(e.metaKey && e.shiftKey ? "deep" : e.metaKey ? "page" : "here", e.altKey);
  };
  return (
    <div className="pane-pop">
      <div className="pop">
        <input ref={ref} data-ask="1" placeholder="What should the new page cover?" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} spellCheck={false} />
        <div className="verbs">
          <span className="verb" onClick={(e) => submit("here", e.altKey)}>
            <Kbd>↵</Kbd>Write here
          </span>
          <span className="verb" onClick={(e) => submit("page", e.altKey)}>
            <Kbd>⌘↵</Kbd>New Page
          </span>
          <span className="verb" onClick={(e) => submit("deep", e.altKey)}>
            <Kbd>⌘⇧↵</Kbd>Deep Dive
          </span>
          <span className="tail">
            <span className="verb esc" onClick={onEsc}>
              Esc
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

const SCOPE_LABEL: Record<RefineScope, string> = { selection: "selection", page: "page", corpus: "corpus" };

/** Takes the refine box's place while a refinement runs, and holds the failure until retried or dismissed. */
export function RefineStatus({
  scope,
  text,
  working,
  pagesLeft,
  error,
  hotkey,
  caretLeft,
  pane,
  onRetry,
  onDismiss,
}: {
  scope: RefineScope;
  text?: string;
  /** What the model is reading with its tools right now, if anything. */
  working?: string;
  /** How many pages a refinement over several of them has still to finish; one card counts for the set. */
  pagesLeft?: number;
  error?: string;
  /** Whether ↵ answers this card. Only one failure takes the key, so a press retries one refine. */
  hotkey?: boolean;
  caretLeft?: number;
  pane?: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!error || !hotkey) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Enter" && !(e.target as HTMLElement)?.closest("input, textarea")) {
        e.preventDefault();
        onRetry();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [error, hotkey, onRetry]);
  const body = error ? (
    <div className="pop small-card status-card failed">
      <div className="lab">Couldn't refine the {SCOPE_LABEL[scope]}</div>
      <div className="msg">{error}</div>
      <div className="acts">
        <span className="do" onClick={onRetry}>
          <Kbd>↵</Kbd> Try again
        </span>
        <span className="r verb esc" onClick={onDismiss}>
          Esc
        </span>
      </div>
    </div>
  ) : (
    <div className="pop small-card status-card">
      <div className="working">
        <span className="pulse" />
        <span>Refining the {SCOPE_LABEL[scope]}…</span>
        {text && <em title={text}>“{text}”</em>}
        {!!pagesLeft && <span className="pages-left">{pagesLeft === 1 ? "1 page" : `${pagesLeft} pages`} to go</span>}
      </div>
      {working && <div className="working tool">{working}…</div>}
    </div>
  );
  if (pane) return <div className="pane-pop">{body}</div>;
  return <PopWrap caretX={caretLeft ?? 0}>{body}</PopWrap>;
}

export function AnswerCard({
  id,
  lookup,
  working,
  onFollowUp,
  onEsc,
  onRefine,
}: {
  /** Which card this is, so the page can tell the one it is peeking at from the ones streaming beside it. */
  id: string;
  lookup: Lookup;
  /** What the model is reading with its tools right now, shown while the answer is still on its way. */
  working?: string;
  onFollowUp: Submit;
  onEsc: () => void;
  onRefine?: () => void;
}) {
  // A card peeked at from hover must not pull focus; it takes it once a click keeps it open.
  const ref = useAutoFocus(!lookup.peek);
  const [q, setQ] = useState("");
  const skeleton = useAnswerSkeleton(lookup);
  // The card stays mounted across a quick follow-up, so the box is emptied here once the question is sent.
  const submit = (v: Verb, alt: boolean) => {
    if (!q.trim()) return;
    onFollowUp(q, v, alt);
    setQ("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      // Only this box closes; the window's Esc would otherwise also close whatever sits behind it.
      e.stopPropagation();
      return onEsc();
    }
    const v = verbFor(e);
    if (v) {
      e.preventDefault();
      submit(v, e.altKey);
    }
  };
  return (
    <div className="card" data-lookup={id}>
      {lookup.thread.map((t, i) => (
        <div key={i} className="answer" style={{ marginBottom: 12, color: "var(--mute)" }}>
          <div style={{ fontFamily: "var(--sans)", fontSize: 12, marginBottom: 4 }}>{t.question}</div>
          {t.answer}
        </div>
      ))}
      {lookup.thread.length > 0 && <div style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--mute)", marginBottom: 4 }}>{lookup.question}</div>}
      {lookup.error ? (
        <div className="answer err">{lookup.error}</div>
      ) : skeleton.show ? (
        <>
          <Skeleton fading={skeleton.fading} />
          {lookup.streaming && working && (
            <div className="answer tool">
              <span className="pulse" />
              {working}…
            </div>
          )}
        </>
      ) : (
        <div className={`answer${lookup.streaming ? " streaming-cursor" : ""}`}>{lookup.answer}</div>
      )}
      <input ref={ref} data-ask="1" placeholder="Follow up…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} spellCheck={false} />
      <AskVerbs onVerb={submit} onEsc={onEsc} onToggle={onRefine} />
    </div>
  );
}

export function BeforeCard({ change, index, total, caretLeft, onUndo }: { change: Change; index: number; total: number; caretLeft: number; onUndo: () => void }) {
  return (
    <PopWrap caretX={caretLeft} width={400}>
      <div className="pop small-card">
        <div className="lab">Before</div>
        <div className="old">{change.before || <em>nothing</em>}</div>
        <div className="acts">
          <span className="do" onClick={onUndo}>
            Undo
          </span>
          <span className="r">
            {index} of {total}
          </span>
        </div>
      </div>
    </PopWrap>
  );
}

export function NowCard({ change, versionN, caretLeft }: { change: Change; versionN: number; caretLeft: number }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(change.after).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      },
      () => undefined,
    );
  };
  return (
    <PopWrap caretX={caretLeft} width={400}>
      <div className="pop small-card">
        <div className="lab">Now · Version {versionN}</div>
        <div className="old">{change.after || <em>removed</em>}</div>
        <div className="acts">
          <span className="do" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </span>
          <span className="r">changed in Version {versionN}</span>
        </div>
      </div>
    </PopWrap>
  );
}

/** Sits at the end of a page the model never wrote, offering to try again (↵ when `hotkey`). */
export function FailedCard({ title, error, hotkey, onRetry }: { title: string; error?: string; hotkey?: boolean; onRetry: () => void }) {
  useEffect(() => {
    if (!hotkey) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Enter" && !e.metaKey && !(e.target as HTMLElement)?.closest("input, textarea")) {
        e.preventDefault();
        onRetry();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hotkey, onRetry]);
  return (
    <div className="pop small-card status-card failed page-failed">
      <div className="lab">{title}</div>
      {error && <div className="msg">{error}</div>}
      <div className="acts">
        <span className="do" onClick={onRetry}>
          <Kbd>↵</Kbd> Try again
        </span>
      </div>
    </div>
  );
}

/**
 * The Send feedback box, opened from the link at the bottom of the sidebar. The note goes to the
 * relay as a GitHub issue; the email is optional and only for a reply. ↵ makes a new line, ⌘↵ sends.
 */
export function FeedbackPopover({ onSend, onEsc }: { onSend: (message: string, email: string) => Promise<void>; onEsc: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [email, setEmail] = useState("");
  const [state, setState] = useState<{ kind: "idle" } | { kind: "sending" } | { kind: "sent" } | { kind: "error"; message: string }>({ kind: "idle" });
  const busy = state.kind === "sending";
  useEffect(() => {
    const t = window.setTimeout(() => ref.current?.focus({ preventScroll: true }), 60);
    return () => window.clearTimeout(t);
  }, []);
  // A sent note closes the box on its own after a moment, once the thanks has been seen. The
  // callback is read through a ref so a parent re-render does not restart the wait.
  const close = useRef(onEsc);
  close.current = onEsc;
  useEffect(() => {
    if (state.kind !== "sent") return;
    const t = window.setTimeout(() => close.current(), 1600);
    return () => window.clearTimeout(t);
  }, [state.kind]);
  const canSend = !!text.trim() && text.length <= FEEDBACK_MAX && !busy && state.kind !== "sent";
  const send = async () => {
    if (!canSend) return;
    setState({ kind: "sending" });
    try {
      await onSend(text, email);
      setState({ kind: "sent" });
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      // Only this box closes; the window's Esc would otherwise also close whatever sits behind it.
      e.stopPropagation();
      return onEsc();
    }
    if (e.key === "Enter" && e.metaKey) {
      e.preventDefault();
      void send();
    }
  };
  const over = text.length > FEEDBACK_MAX;
  return (
    <div className="pane-pop feedback-pop" onKeyDown={onKey}>
      <div className="pop">
        <textarea
          ref={ref}
          data-ask="1"
          placeholder="What's working, what isn't, what you wish it did…"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy || state.kind === "sent"}
          spellCheck
        />
        <input
          className="email"
          type="email"
          placeholder="Email, if you'd like a reply (optional)"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy || state.kind === "sent"}
          autoComplete="email"
          spellCheck={false}
        />
        <div className="verbs">
          {state.kind === "sent" ? (
            <span className="note ok">Thanks. It's on its way.</span>
          ) : state.kind === "error" ? (
            <span className="note err" title={state.message}>
              {state.message}
            </span>
          ) : over ? (
            <span className="note err">Keep it under {FEEDBACK_MAX.toLocaleString()} characters.</span>
          ) : (
            <span className="note">Goes to the people who make Nested, as an issue on GitHub.</span>
          )}
          <span className="tail">
            <span className={`verb${canSend ? "" : " off"}`} onClick={() => void send()}>
              <Kbd>⌘↵</Kbd>
              {busy ? "Sending…" : state.kind === "error" ? "Try again" : "Send"}
            </span>
            <span className="verb esc" onClick={onEsc}>
              Esc
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
