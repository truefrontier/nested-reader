/**
 * Calls `close` on Esc, listening in the capture phase on `target` (the window), and stops the key there.
 * A menu or box open over the page then closes before the window's own Esc handler (App.tsx, which runs
 * store.escape and would also close the find bar or cancel a refine) can see the same press.
 * Returns the function that stops listening.
 */
export function onEscapeFirst(target: Pick<EventTarget, "addEventListener" | "removeEventListener">, close: () => void): () => void {
  const onKey = (e: Event) => {
    if ((e as KeyboardEvent).key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  target.addEventListener("keydown", onKey, true);
  return () => target.removeEventListener("keydown", onKey, true);
}
