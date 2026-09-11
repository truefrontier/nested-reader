import { useEffect, useRef, type KeyboardEvent } from "react";
import { store, useReader } from "../state/store";
import { ChevronLeft, ChevronRight, CloseIcon } from "./Icons";

/** The in-page find box. Matching and highlighting are the page's job; this shows the query and the count. ↵ selects the match. */
export function FindBar({ count, current }: { count: number; current: number }) {
  const s = useReader();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, [s.ui.findFocus]);
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      store.closeFind();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) store.findStep(-1);
      else store.findSelectCurrent();
    }
  };
  const q = s.ui.findQuery;
  const searching = q.trim().length > 0;
  const label = !searching ? "" : count ? `${current + 1} of ${count}` : "No matches";
  return (
    <div className="strip find">
      <input ref={ref} placeholder="Find in page" value={q} onChange={(e) => store.setFindQuery(e.target.value)} onKeyDown={onKey} spellCheck={false} />
      <span className={`count${searching && !count ? " none" : ""}`}>{label}</span>
      <span className="nav" title="Previous ⌘⇧G" onClick={() => store.findStep(-1)}>
        <ChevronLeft />
      </span>
      <span className="nav" title="Next ⌘G" onClick={() => store.findStep(1)}>
        <ChevronRight />
      </span>
      <span className="nav" title="Close Esc" onClick={() => store.closeFind()}>
        <CloseIcon />
      </span>
    </div>
  );
}
