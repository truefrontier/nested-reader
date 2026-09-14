import type { KeyboardEvent, MouseEvent } from "react";
import { useRef } from "react";

const stop = (e: MouseEvent | KeyboardEvent) => e.stopPropagation();

/**
 * A row's label while it is being renamed, on Home and in the tree. Enter keeps the new name,
 * Esc drops it, and clicking away keeps it, so a rename never needs a second confirmation.
 */
export function RenameInput({ value, onDone }: { value: string; onDone: (name: string | null) => void }) {
  const cancelled = useRef(false);
  return (
    <input
      className="rename"
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
