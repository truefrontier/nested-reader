/** One registry for the help sheet; native accelerators remain owned by `src-tauri/src/lib.rs`. */
export type ShortcutDef = { id: string; label: string; keys: string };

export const DEFAULT_SHORTCUTS: ShortcutDef[] = [
  { id: "new-page", label: "New page", keys: "⌘N" },
  { id: "open", label: "Open", keys: "⌘O" },
  { id: "add-root", label: "Add to session", keys: "⌘⇧O" },
  { id: "find", label: "Find", keys: "⌘F" },
  { id: "filter", label: "Filter files", keys: "⌘/" },
  { id: "settings", label: "Settings", keys: "⌘," },
  { id: "feedback", label: "Send feedback", keys: "⌘⇧F" },
  { id: "shortcuts", label: "Keyboard shortcuts", keys: "⌘/" },
];
