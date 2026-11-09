import type { KeyboardEvent, MouseEvent } from "react";
import { useRef } from "react";

const stop = (e: MouseEvent | KeyboardEvent) => e.stopPropagation();

/**
 * A row's label while it is being renamed, on Home, in the tree and in a pane's page menu. Enter
 * keeps the new name, Esc drops it, and clicking away keeps it, so a rename never needs a second
 * confirmation. `label` names the box for a screen reader where no row text sits beside it.
 */
export function RenameInput({ value, label, onDone }: { value: string; label?: string; onDone: (name: string | null) => void }) {
  const cancelled = useRef(false);
  return (
    <input
      className="rename"
      aria-label={label}
      autoFocus
      defaultValue={value}
      spellCheck={false}
      onMouseDown={stop}
      onClick={stop}
      onFocus={(e) => {
        e.target.select();
        // Selecting a long title would otherwise leave the box showing its tail; start at the front.
        e.target.scrollLeft = 0;
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") {
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
      onBlur={(e) => onDone(cancelled.current ? null : e.target.value)}
    />
  );
}
