import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Lookup, Verb } from "../state/store";
import type { Change } from "../lib/diff";
import type { RefineScope } from "../lib/prompts";

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}

export function Caret({ left }: { left: number }) {
  return <div className="caret" style={{ left }} />;
}

type Submit = (text: string, verb: Verb, alt: boolean) => void;

function verbFor(e: KeyboardEvent): Verb | null {
  if (e.key !== "Enter") return null;
  if (e.metaKey && e.shiftKey) return "deep";
  if (e.metaKey) return "page";
  return "quick";
}

function useAutoFocus() {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = window.setTimeout(() => ref.current?.focus({ preventScroll: true }), 60);
    return () => window.clearTimeout(t);
  }, []);
  return ref;
}

export function AskVerbs({ onVerb, onEsc }: { onVerb: (v: Verb, alt: boolean) => void; onEsc: () => void }) {
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
      <span className="verb esc" onClick={onEsc}>
        Esc
      </span>
    </div>
  );
}

export function AskPopover({ caretLeft, onSubmit, onEsc, onRefine }: { caretLeft: number; onSubmit: Submit; onEsc: () => void; onRefine: () => void }) {
  const ref = useAutoFocus();
  const [q, setQ] = useState("");
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") return onEsc();
    if (e.key === "r" && e.metaKey) {
      e.preventDefault();
      return onRefine();
    }
    const v = verbFor(e);
    if (v) {
      e.preventDefault();
      onSubmit(q, v, e.altKey);
    }
  };
  return (
    <div className="pop-wrap narrow" style={{ marginLeft: 40 + Math.max(0, caretLeft - 70) }}>
      <Caret left={74} />
      <div className="pop">
        <input ref={ref} data-ask="1" placeholder="Ask something…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} spellCheck={false} />
        <AskVerbs onVerb={(v, alt) => onSubmit(q, v, alt)} onEsc={onEsc} />
      </div>
    </div>
  );
}

export function RefineVerbs({ onScope, onEsc, selectionEnabled }: { onScope: (s: RefineScope) => void; onEsc: () => void; selectionEnabled: boolean }) {
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
      <span className="verb esc" onClick={onEsc}>
        Esc
      </span>
    </div>
  );
}

export function RefinePopover({
  caretLeft,
  pane,
  onSubmit,
  onEsc,
  onToggle,
}: {
  caretLeft?: number;
  pane?: boolean;
  onSubmit: (instruction: string, scope: RefineScope) => void;
  onEsc: () => void;
  onToggle: () => void;
}) {
  const ref = useAutoFocus();
  const [text, setText] = useState("");
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") return onEsc();
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
      <RefineVerbs selectionEnabled={!pane} onScope={(scope) => onSubmit(text, scope)} onEsc={onEsc} />
    </div>
  );
  if (pane) return <div className="pane-pop">{body}</div>;
  return (
    <div className="pop-wrap" style={{ marginLeft: 40 + Math.max(0, (caretLeft ?? 0) - 90) }}>
      <Caret left={94} />
      {body}
    </div>
  );
}

export function AnswerCard({ lookup, onFollowUp, onEsc }: { lookup: Lookup; onFollowUp: Submit; onEsc: () => void }) {
  const ref = useAutoFocus();
  const [q, setQ] = useState("");
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") return onEsc();
    const v = verbFor(e);
    if (v) {
      e.preventDefault();
      if (q.trim()) onFollowUp(q, v, e.altKey);
    }
  };
  return (
    <div className="card">
      {lookup.thread.map((t, i) => (
        <div key={i} className="answer" style={{ marginBottom: 12, color: "var(--mute)" }}>
          <div style={{ fontFamily: "var(--sans)", fontSize: 12, marginBottom: 4 }}>{t.question}</div>
          {t.answer}
        </div>
      ))}
      {lookup.thread.length > 0 && <div style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--mute)", marginBottom: 4 }}>{lookup.question}</div>}
      {lookup.error ? (
        <div className="answer err">{lookup.error}</div>
      ) : (
        <div className={`answer${lookup.streaming ? " streaming-cursor" : ""}`}>{lookup.answer}</div>
      )}
      <input ref={ref} data-ask="1" placeholder="Follow up…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} spellCheck={false} />
      <AskVerbs onVerb={(v, alt) => q.trim() && onFollowUp(q, v, alt)} onEsc={onEsc} />
    </div>
  );
}

export function BeforeCard({ change, index, total, caretLeft, onUndo }: { change: Change; index: number; total: number; caretLeft: number; onUndo: () => void }) {
  return (
    <div className="pop-wrap" style={{ width: 400, marginLeft: 40 + Math.max(0, caretLeft - 60) }}>
      <Caret left={60} />
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
    </div>
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
    <div className="pop-wrap" style={{ width: 400, marginLeft: 40 + Math.max(0, caretLeft - 60) }}>
      <Caret left={60} />
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
    </div>
  );
}
