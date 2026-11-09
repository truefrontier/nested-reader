import { useEffect, useRef, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { DragBand } from "../reader/DragBand";
import { DEFAULT_SETTINGS, READING_WIDTH_RANGE, isTauri, platform, type Auth, type DefaultApp, type OpenAtLaunch, type UpdateCheck, type Placement, type Provider, type ReadingWidthUnit, type Settings } from "../platform";
import { authFor, chatModels, modelSlot, pickDefaultModel, webSearchFor } from "../lib/models";
import { AiIcon, AppearanceIcon, CheckIcon, GeneralIcon, UpDownIcon } from "../reader/Icons";
import { listStep, moveFocus, PRESS, pressOnKey } from "../lib/keys";

type Tab = "general" | "appearance" | "ai";
const TABS: [Tab, string, () => ReactNode][] = [
  ["general", "General", GeneralIcon],
  ["appearance", "Appearance", AppearanceIcon],
  ["ai", "AI", AiIcon],
];

const PLACEMENTS: { value: Placement; label: string }[] = [
  { value: "beside", label: "Beside" },
  { value: "below", label: "Below" },
  { value: "active", label: "Here" },
  { value: "background", label: "In the background, unread" },
  { value: "window", label: "In a new window" },
];

const LAUNCH: { value: OpenAtLaunch; label: string }[] = [
  { value: "last-session", label: "Last session" },
  { value: "ask", label: "Ask for a folder" },
  { value: "nothing", label: "Nothing" },
];

const PROVIDERS: { value: Provider; label: string }[] = [
  { value: "builtin", label: "Built in" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "ollama", label: "Ollama" },
  { value: "custom", label: "Custom" },
];

/** What Settings calls each provider that has no web tool (`webSearchFor` in `src/lib/models.ts`). */
const NO_WEB: Partial<Record<Provider, string>> = {
  builtin: "The built-in plan",
  openai: "An OpenAI API key",
  ollama: "Ollama",
  custom: "A Custom server",
};

function applyTheme(s: Settings) {
  const dark = s.theme === "dark" || (s.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function SettingsApp({ embedded, onClose }: { embedded?: boolean; onClose?: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tab, setTab] = useState<Tab>("ai");
  const saveTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    platform.getSettings().then((s) => {
      setSettings(s);
      if (!embedded) applyTheme(s);
    });
    if (!embedded) {
      document.body.classList.add("settings-body");
      return platform.onSettingsChanged((s) => {
        setSettings(s);
        applyTheme(s);
      });
    }
    return undefined;
  }, [embedded]);

  // A native picker (Change… folder) takes focus away from the window; that is not a click outside it.
  const dialogOpen = useRef(false);
  const close = () => {
    if (embedded) onClose?.();
    else if (isTauri) getCurrentWindow().close().catch(() => undefined);
  };

  // Esc and ⌘W close the settings, both as the embedded panel and as the Tauri window. In the Tauri app ⌘W is
  // taken by the menu first (File › Close Pane), which lib.rs turns into closing this window when it is focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Esc inside a box only leaves the box (see the subfolder and number fields); a second Esc closes.
        if ((e.target as HTMLElement)?.closest("input, textarea")) return;
        e.preventDefault();
        close();
      } else if (e.key.toLowerCase() === "w" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Clicking outside the Tauri window (the reader, another app) closes it, like the embedded panel's backdrop.
  useEffect(() => {
    if (embedded || !isTauri) return;
    let stop = false;
    const un = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused && !dialogOpen.current && !stop) close();
    });
    return () => {
      stop = true;
      un.then((f) => f()).catch(() => undefined);
    };
  }, [embedded]);

  const save = (patch: Partial<Settings>, debounce = 0) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    if (!embedded) applyTheme(next);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      platform.saveSettings(next).catch(() => undefined);
    }, debounce);
  };

  if (!settings) return <div className="settings" />;

  return (
    // The Settings window is its own document, so it needs its own main landmark; embedded (the browser
    // build's stand-in) it sits inside the reader's.
    <div className={`settings${embedded ? " embedded" : ""}`} role={embedded ? undefined : "main"}>
      <div className="settings-title">
        {embedded && (
          <div className="tl" style={{ position: "absolute" }}>
            <span style={{ background: "#ff5f57" }} {...PRESS} aria-label="Close settings" onClick={onClose} />
            <span style={{ background: "#febc2e" }} />
            <span style={{ background: "#28c840" }} />
          </div>
        )}
        {!embedded && <DragBand />}
        Settings
      </div>
      {/* Tabs: ← → (or ↑ ↓) move between them, and the one with focus is shown. */}
      <div className="tabs" role="tablist" aria-label="Settings" onKeyDown={(e) => moveFocus(e.currentTarget, "[role=tab]", e.key) && e.preventDefault()}>
        {TABS.map(([id, label, Icon]) => (
          <div key={id} className={`tab${tab === id ? " on" : ""}`} role="tab" aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} onFocus={() => setTab(id)} onClick={() => setTab(id)}>
            <Icon />
            {label}
          </div>
        ))}
      </div>
      <div className="settings-body-inner" key={tab} role="tabpanel" aria-label={TABS.find(([id]) => id === tab)?.[1]}>
        {tab === "general" && <General settings={settings} save={save} dialogOpen={dialogOpen} />}
        {tab === "appearance" && <Appearance settings={settings} save={save} />}
        {tab === "ai" && <Ai settings={settings} save={save} />}
      </div>
    </div>
  );
}

type SectionProps = { settings: Settings; save: (patch: Partial<Settings>, debounce?: number) => void };

function Row({ label, children, top }: { label: string; children: ReactNode; top?: boolean }) {
  return (
    <>
      <div className={`lab${top ? " top" : ""}`}>{label}</div>
      <div className="val" role="group" aria-label={label}>
        {children}
      </div>
    </>
  );
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string; className?: string }[]; onChange: (v: T) => void }) {
  const at = options.findIndex((o) => o.value === value);
  return (
    // A radio group: one Tab stop, and the arrow keys pick the next or previous choice.
    <div
      className="seg"
      role="radiogroup"
      onKeyDown={(e) => {
        const next = listStep(e.key, options.length, at);
        if (next === null) return;
        e.preventDefault();
        onChange(options[next].value);
        (e.currentTarget.children[next] as HTMLElement | undefined)?.focus();
      }}
    >
      {options.map((o, i) => (
        <span
          key={o.value}
          className={`${o.value === value ? "on" : ""} ${o.className ?? ""}`.trim()}
          role="radio"
          aria-checked={o.value === value}
          tabIndex={i === Math.max(at, 0) ? 0 : -1}
          onKeyDown={pressOnKey}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </span>
      ))}
    </div>
  );
}

function Dropdown<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // Opened from the keyboard, the chosen option takes the focus, and closing hands it back to the box.
  const kb = useRef(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("mousedown", close);
    if (kb.current) (menu.current?.querySelector<HTMLElement>("[aria-selected=true]") ?? menu.current?.querySelector<HTMLElement>("[role=option]"))?.focus();
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const shut = () => {
    setOpen(false);
    if (kb.current) button.current?.focus();
  };
  const current = options.find((o) => o.value === value)?.label ?? value;
  return (
    <div className="dd-wrap" onMouseDown={(e) => e.stopPropagation()}>
      <div
        ref={button}
        className={`dd${open ? " open" : ""}`}
        {...PRESS}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={(e) => {
          // A press from Enter or Space has no mouse clicks behind it.
          kb.current = e.detail === 0;
          setOpen(!open);
        }}
      >
        {current}
        <UpDownIcon />
      </div>
      {open && (
        <div
          ref={menu}
          className="dd-menu"
          role="listbox"
          onKeyDown={(e) => {
            e.stopPropagation();
            kb.current = true;
            if (e.key === "Escape" || e.key === "Tab") {
              e.preventDefault();
              shut();
            } else if (moveFocus(e.currentTarget, "[role=option]", e.key)) e.preventDefault();
          }}
        >
          {options.map((o) => (
            <div
              key={o.value}
              className={o.value === value ? "on" : ""}
              role="option"
              aria-selected={o.value === value}
              tabIndex={-1}
              onKeyDown={pressOnKey}
              onClick={() => {
                onChange(o.value);
                shut();
              }}
            >
              {o.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function General({ settings, save, dialogOpen }: SectionProps & { dialogOpen: { current: boolean } }) {
  const [sub, setSub] = useState<string | null>(null);
  const pick = async () => {
    dialogOpen.current = true;
    try {
      const folder = await platform.pickFolder();
      if (folder) save({ folder });
    } finally {
      dialogOpen.current = false;
    }
  };
  const folderLabel = settings.folder ? settings.folder.replace(/^\/Users\/[^/]+/, "~") : "No folder chosen";
  return (
    <div className="grid">
      <Row label="Folder">
        <span className="spread">
          <span className="ell" title={settings.folder}>
            {folderLabel}
          </span>
          <span className="act" {...PRESS} onClick={() => void pick()}>
            Change…
          </span>
        </span>
      </Row>
      <Row label="New pages">
        {sub === null ? (
          <span className="spread">
            <span>{settings.newPagesSubfolder ? `Saved in ${settings.newPagesSubfolder}/ as .md` : "Saved next to their source as .md"}</span>
            <span className="act" {...PRESS} onClick={() => setSub(settings.newPagesSubfolder)}>
              Subfolder…
            </span>
          </span>
        ) : (
          <input
            className="field"
            autoFocus
            placeholder="Subfolder name, or empty for next to source"
            value={sub}
            onChange={(e) => setSub(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                save({ newPagesSubfolder: sub.trim().replace(/^\/+|\/+$/g, "") });
                setSub(null);
              }
              if (e.key === "Escape") setSub(null);
            }}
            onBlur={() => {
              save({ newPagesSubfolder: sub.trim().replace(/^\/+|\/+$/g, "") });
              setSub(null);
            }}
          />
        )}
      </Row>
      <Row label="Open at launch">
        <Dropdown value={settings.openAtLaunch} options={LAUNCH} onChange={(v) => save({ openAtLaunch: v })} />
      </Row>
      <Row label="Markdown files" top>
        <DefaultAppRow save={save} dialogOpen={dialogOpen} />
      </Row>
      <Row label="Deleting a page" top>
        <span className="stack">
          <span className="with-note">
            <Seg
              value={settings.confirmDelete ? "ask" : "go"}
              options={[
                { value: "ask", label: "Ask first" },
                { value: "go", label: "Delete right away" },
              ]}
              onChange={(v) => save({ confirmDelete: v === "ask" })}
            />
            <span className="note">Into .reader/trash</span>
          </span>
          {settings.folder && <TrashRow folder={settings.folder} dialogOpen={dialogOpen} />}
        </span>
      </Row>
      <Row label="Updates" top>
        <UpdateRow />
      </Row>
      <div className="divider" />
      <Row label="⌘‑click opens">
        <span className="with-note">
          <Dropdown value={settings.newPageOpens} options={PLACEMENTS} onChange={(v) => save({ newPageOpens: v })} />
          <span className="note">Also New Page (⌘↵)</span>
        </span>
      </Row>
      <Row label="⌘⇧‑click opens">
        <span className="with-note">
          <Dropdown value={settings.deepDiveOpens} options={PLACEMENTS} onChange={(v) => save({ deepDiveOpens: v })} />
          <span className="note">Also Deep Dive (⌘⇧↵)</span>
        </span>
      </Row>
      <div className="hint lines">
        <div>Links and tree rows. A plain click opens here; hold ⌥ for the other placement.</div>
        <div>In the background marks a page unread. ⌘⇧‑click it again to mark it read.</div>
      </div>
    </div>
  );
}

/**
 * Which Mac app opens .md files, with the switch to Nested. Re-read whenever the window comes
 * back, since Finder's Get Info can change it too. While macOS asks the user to confirm, its
 * prompt takes the focus; `dialogOpen` keeps that from counting as a click outside the window.
 */
function DefaultAppRow({ save, dialogOpen }: { save: (patch: Partial<Settings>) => void; dialogOpen: { current: boolean } }) {
  const [app, setApp] = useState<DefaultApp | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const load = () => {
      platform
        .defaultMarkdownApp()
        .then(setApp)
        .catch(() => setApp({ isNested: false, available: false }));
    };
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, []);
  const use = async () => {
    setBusy(true);
    setError(null);
    dialogOpen.current = true;
    try {
      const next = await platform.setDefaultMarkdownApp();
      setApp(next);
      if (next.isNested) save({ offerDefaultApp: false });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      platform.defaultMarkdownApp().then(setApp).catch(() => undefined);
    } finally {
      dialogOpen.current = false;
      setBusy(false);
    }
  };
  if (!app) return <span className="mute">…</span>;
  if (!app.available) return <span className="mute">Available in the built app</span>;
  const status = app.isNested ? "Open in Nested" : app.app ? `Open in ${app.app}` : "No app opens them";
  return (
    <span className="stack">
      <span className="spread">
        <span>{status}</span>
        {!app.isNested && (
          <span className={`act${busy ? " busy" : ""}`} {...PRESS} aria-disabled={busy || undefined} onClick={() => !busy && void use()}>
            {busy ? "Waiting for macOS…" : "Use Nested"}
          </span>
        )}
      </span>
      <span className="note wrap">{error ?? (app.isNested ? "A double‑click in Finder opens the file here." : "Also Open With in Finder. macOS may ask you to confirm.")}</span>
    </span>
  );
}

/** The folder's `.reader/trash`: how many deleted pages it holds, and a way to remove them for good. */
function TrashRow({ folder, dialogOpen }: { folder: string; dialogOpen: { current: boolean } }) {
  const [count, setCount] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // Pages can be deleted in the reader while Settings stays open, so it counts again on focus.
    const load = () => {
      platform
        .trashCount(folder)
        .then((n) => {
          setCount(n);
          setNote(null);
        })
        .catch((e) => setNote(e instanceof Error ? e.message : String(e)));
    };
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [folder]);
  const empty = async (n: number) => {
    dialogOpen.current = true;
    try {
      const ok = await platform.confirm(
        "Empty the trash?",
        `The ${n === 1 ? "deleted page" : `${n} deleted pages`} in .reader/trash, and ${n === 1 ? "its" : "their"} snapshots, will be removed for good. An Undo still on screen can't bring ${n === 1 ? "it" : "them"} back.`,
        "Empty Trash",
      );
      if (!ok) return;
      setBusy(true);
      const removed = await platform.emptyTrash(folder);
      setNote(`Removed ${removed === 1 ? "1 page" : `${removed} pages`} for good.`);
      setCount(await platform.trashCount(folder));
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      dialogOpen.current = false;
      setBusy(false);
    }
  };
  if (count === null && !note) return null;
  return (
    <span className="with-note">
      <span className="note">{note ?? (count ? `${count === 1 ? "1 page" : `${count} pages`} there now` : "The trash is empty")}</span>
      {!!count && (
        <button type="button" className={`act note${busy ? " busy" : ""}`} disabled={busy} onClick={() => void empty(count)}>
          {busy ? "Emptying…" : "Empty trash…"}
        </button>
      )}
    </span>
  );
}

type UpdateRowState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest" }
  | { kind: "found"; version: string }
  | { kind: "installing"; version: string; pct?: number }
  | { kind: "error"; message: string; version?: string };

/**
 * The running version with Check for updates, and the install when one is found. The reader
 * window checks by itself a few seconds after launch; this row is for looking now.
 */
function UpdateRow() {
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [state, setState] = useState<UpdateRowState>({ kind: "idle" });
  useEffect(() => {
    platform
      .checkForUpdate()
      .then((c) => {
        setCheck(c);
        if (c.update) setState({ kind: "found", version: c.update.version });
      })
      .catch(() => setCheck({ current: "", supported: true }));
  }, []);
  const look = async () => {
    setState({ kind: "checking" });
    try {
      const c = await platform.checkForUpdate();
      setCheck(c);
      setState(c.update ? { kind: "found", version: c.update.version } : { kind: "latest" });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };
  const install = async (version: string) => {
    setState({ kind: "installing", version });
    try {
      await platform.installUpdate((p) => {
        if (p.type === "progress") setState({ kind: "installing", version, pct: p.total ? Math.min(100, Math.round((p.downloaded / p.total) * 100)) : undefined });
      });
      await platform.relaunch();
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e), version });
    }
  };
  if (!check) return <span className="mute">…</span>;
  if (!check.supported) return <span className="mute">Available in the built app</span>;
  const current = check.current ? `Nested ${check.current}` : "Nested";
  const busy = state.kind === "checking" || state.kind === "installing";
  const version = state.kind === "found" || state.kind === "installing" ? state.version : state.kind === "error" ? state.version : undefined;
  const status =
    state.kind === "installing"
      ? state.pct === undefined
        ? `Installing ${state.version}…`
        : `Downloading ${state.version}… ${state.pct}%`
      : version
        ? `${version} is ready`
        : current;
  const note =
    state.kind === "error"
      ? state.message
      : state.kind === "latest"
        ? "You're on the latest version."
        : state.kind === "installing"
          ? "The app relaunches when it is in place."
          : version
            ? `You're on ${check.current || "an older version"}. The update takes a moment and relaunches the app.`
            : "The app looks for a newer version a few seconds after it opens, and every few hours after that.";
  return (
    <span className="stack">
      <span className="spread">
        <span>{status}</span>
        {busy ? (
          <span className="act busy">{state.kind === "checking" ? "Checking…" : "Working…"}</span>
        ) : version ? (
          <span className="act" {...PRESS} onClick={() => void install(version)}>
            {state.kind === "error" ? "Try again" : "Update and relaunch"}
          </span>
        ) : (
          <span className="act" {...PRESS} onClick={() => void look()}>
            Check for updates
          </span>
        )}
      </span>
      <span className="note wrap">{note}</span>
    </span>
  );
}

const WIDTH_UNITS: { value: ReadingWidthUnit; label: string }[] = [
  { value: "em", label: "em" },
  { value: "percent", label: "%" },
];

/** A small number box that follows `value` until it is being typed in, and hands back what was typed. */
function NumberField({ value, min, max, onChange, onCommit }: { value: number; min: number; max: number; onChange: (v: number) => void; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  // blur() fires synchronously, before a state update lands, so the commit reads the draft through this ref.
  const draftRef = useRef(draft);
  const [editing, setEditing] = useState(false);
  const update = (text: string) => {
    draftRef.current = text;
    setDraft(text);
  };
  useEffect(() => {
    if (!editing) update(String(value));
  }, [value, editing]);
  const parse = (text: string) => (text.trim() === "" ? NaN : Number(text));
  return (
    <input
      className="field num"
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step={1}
      value={draft}
      onFocus={() => setEditing(true)}
      onChange={(e) => {
        update(e.target.value);
        const n = parse(e.target.value);
        // Arrow keys and in-range typing apply as you go; anything else waits for ↵ or blur to be clamped.
        if (Number.isFinite(n) && n >= min && n <= max) onChange(n);
      }}
      onBlur={() => {
        setEditing(false);
        onCommit(parse(draftRef.current));
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          // Esc throws the typed text away; the blur then commits what was set.
          update(String(value));
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function Appearance({ settings, save }: SectionProps) {
  const min = 13;
  const max = 22;
  const pct = ((settings.textSize - min) / (max - min)) * 100;
  const width = settings.readingWidth;
  const range = READING_WIDTH_RANGE[width.unit];
  const widthValue = Math.min(range.max, Math.max(range.min, width[width.unit]));
  const widthPct = ((widthValue - range.min) / (range.max - range.min)) * 100;
  const setWidth = (v: number, debounce = 0) => {
    // NaN (an emptied box) falls back to what is set, so the box never commits nothing.
    const n = Number.isFinite(v) ? Math.min(range.max, Math.max(range.min, Math.round(v))) : widthValue;
    save({ readingWidth: { ...width, [width.unit]: n } }, debounce);
  };
  return (
    <div className="grid">
      <Row label="Theme">
        <Seg
          value={settings.theme}
          options={[
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
          onChange={(v) => save({ theme: v })}
        />
      </Row>
      <Row label="Text size">
        <div className="slider">
          <span className="a small">A</span>
          <div className="track">
            <div className="fill" style={{ width: `${pct}%` }} />
            <div className="thumb" style={{ left: `${pct}%` }} />
            <input type="range" min={min} max={max} step={1} value={settings.textSize} onChange={(e) => save({ textSize: Number(e.target.value) }, 150)} />
          </div>
          <span className="a big">A</span>
        </div>
      </Row>
      <Row label="Reading font">
        <Seg
          value={settings.readingFont}
          options={[
            { value: "serif", label: "Serif", className: "serif" },
            { value: "sans", label: "Sans" },
          ]}
          onChange={(v) => save({ readingFont: v })}
        />
      </Row>
      <Row label="Page width">
        <div className="width-row">
          <div className="slider">
            <span className="wbar narrow" />
            <div className="track">
              <div className="fill" style={{ width: `${widthPct}%` }} />
              <div className="thumb" style={{ left: `${widthPct}%` }} />
              <input type="range" min={range.min} max={range.max} step={1} value={widthValue} onChange={(e) => setWidth(Number(e.target.value), 150)} />
            </div>
            <span className="wbar wide" />
          </div>
          <NumberField value={widthValue} min={range.min} max={range.max} onChange={(v) => setWidth(v, 150)} onCommit={setWidth} />
          <Seg value={width.unit} options={WIDTH_UNITS} onChange={(unit) => save({ readingWidth: { ...width, unit } })} />
        </div>
      </Row>
      <Row label="Page position">
        <Seg
          value={settings.pageAlign}
          options={[
            { value: "left", label: "Left" },
            { value: "center", label: "Centred" },
          ]}
          onChange={(v) => save({ pageAlign: v })}
        />
      </Row>
      <div className="hint lines">
        <div>Width is how far the page reaches across the pane. Position puts it against the left edge or in the middle.</div>
        <div>em follows the text size, so a line keeps about the same number of characters. % follows the width of the pane.</div>
      </div>
    </div>
  );
}

type Ping = { status: "idle" | "checking" | "ok" | "err"; ms?: number; error?: string };

const ACCOUNTS: Record<"openai" | "anthropic", { value: Auth; label: string }[]> = {
  openai: [
    { value: "key", label: "API key" },
    { value: "subscription", label: "ChatGPT plan" },
  ],
  anthropic: [
    { value: "key", label: "API key" },
    { value: "subscription", label: "Claude plan" },
  ],
};

function Ai({ settings, save }: SectionProps) {
  const p = settings.provider;
  const external = p !== "builtin";
  const account = p === "openai" || p === "anthropic" ? p : undefined;
  const auth = authFor(settings, p);
  const subscription = auth === "subscription";
  const slot = modelSlot(p, auth);
  const needsKey = external && p !== "ollama" && !subscription;
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [keyEditing, setKeyEditing] = useState(false);
  const [ping, setPing] = useState<Ping>({ status: "idle" });
  const [model, setModel] = useState(settings.models[slot]);
  const [available, setAvailable] = useState<string[]>([]);
  const pingTimer = useRef<number | undefined>(undefined);
  const pingSeq = useRef(0);
  // `check` fires from timers and effects; the ref always holds what the field shows now.
  const modelRef = useRef(model);
  modelRef.current = model;

  useEffect(() => {
    setModel(settings.models[slot]);
  }, [settings.models, slot]);

  useEffect(() => {
    setKeyDraft("");
    setKeyEditing(false);
    setAvailable([]);
    setPing({ status: "idle" });
    if (!external) {
      setHasKey(null);
      return;
    }
    if (!needsKey) {
      // Ollama and the CLI plans store nothing here; "has key" just means ready to check.
      setHasKey(true);
      return;
    }
    platform.hasApiKey(p).then(setHasKey, () => setHasKey(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p, auth]);

  const choose = (m: string) => {
    setModel(m);
    if (m !== settings.models[slot]) save({ models: { ...settings.models, [slot]: m } });
  };

  const check = (delay = 0, override?: string) => {
    window.clearTimeout(pingTimer.current);
    if (!external) return;
    const seq = ++pingSeq.current;
    pingTimer.current = window.setTimeout(() => {
      const m = override ?? modelRef.current;
      setPing({ status: "checking" });
      platform.aiPing(p, auth, p === "ollama" ? settings.ollamaUrl : settings.baseUrl, m).then(
        (r) => {
          if (seq !== pingSeq.current) return;
          const list = r.models ?? [];
          setAvailable(list);
          const usable = chatModels(p, auth, list);
          const stale = !m || (!r.ok && !usable.includes(m));
          if (usable.length && stale) {
            // Nothing chosen yet, or the stored model is gone: start with the fastest, cheapest one.
            const pick = pickDefaultModel(p, auth, list);
            if (pick) {
              choose(pick);
              check(0, pick);
              return;
            }
          }
          setPing(r.ok ? { status: "ok", ms: r.ms } : { status: "err", error: r.error });
        },
        (e) => seq === pingSeq.current && setPing({ status: "err", error: String(e) }),
      );
    }, delay);
  };

  useEffect(() => {
    if (external && hasKey !== null) check(100, settings.models[slot]);
    return () => window.clearTimeout(pingTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p, auth, hasKey, settings.baseUrl, settings.ollamaUrl]);

  const commitKey = async () => {
    if (!needsKey) return;
    const k = keyDraft.trim();
    setKeyEditing(false);
    if (!k) return;
    try {
      await platform.setApiKey(p, k);
      setHasKey(true);
      setKeyDraft("");
      check(0);
    } catch (e) {
      setPing({ status: "err", error: String(e) });
    }
  };

  const pickModel = (m: string) => {
    choose(m.trim());
    check(0, m.trim());
  };

  const options = chatModels(p, auth, available);
  const listed = model && !options.includes(model) ? [model, ...options] : options;
  const modelOptions = listed.map((m) => ({ value: m, label: m }));
  const cli = account === "anthropic" ? "claude" : "codex";

  return (
    <div className="grid">
      <Row label="Provider">
        <Seg value={p} options={PROVIDERS} onChange={(v) => save({ provider: v })} />
      </Row>
      {!external && (
        <Row label="Plan">
          <span className="spread">
            <span className="mute">Not available in this build. Choose OpenAI, Anthropic, Ollama or Custom.</span>
          </span>
        </Row>
      )}
      {account && (
        <Row label="Account">
          <Seg value={auth ?? "key"} options={ACCOUNTS[account]} onChange={(v) => save({ auth: { ...settings.auth, [account]: v } })} />
        </Row>
      )}
      {account && subscription && <div className="hint">Runs the {cli} command-line tool signed in on this Mac, so questions count against that plan.</div>}
      {p === "ollama" && (
        <Row label="Server">
          <input
            className="field"
            placeholder={DEFAULT_SETTINGS.ollamaUrl}
            value={settings.ollamaUrl}
            onChange={(e) => save({ ollamaUrl: e.target.value }, 400)}
            onBlur={() => check(0)}
            spellCheck={false}
          />
        </Row>
      )}
      {p === "custom" && (
        <Row label="Base URL">
          <input
            className="field"
            placeholder="https://api.example.com/v1"
            value={settings.baseUrl}
            onChange={(e) => save({ baseUrl: e.target.value }, 400)}
            onBlur={() => check(0)}
            spellCheck={false}
          />
        </Row>
      )}
      {needsKey && (
        <Row label="API key">
          <span className="with-note">
            <input
              className="field"
              type="password"
              placeholder={hasKey ? "••••••••••••••••••••••••" : p === "anthropic" ? "sk-ant-…" : "sk-…"}
              value={keyDraft}
              onFocus={() => setKeyEditing(true)}
              onChange={(e) => setKeyDraft(e.target.value)}
              onBlur={() => void commitKey()}
              onKeyDown={(e) => e.key === "Enter" && void commitKey()}
              spellCheck={false}
            />
            <span className="note">{keyEditing && keyDraft ? "Press ↵ to store" : hasKey ? (isTauri ? "Stored in Keychain" : "Stored for this session") : "Not set"}</span>
          </span>
        </Row>
      )}
      {external && (
        <Row label="Model">
          <span className="with-note">
            {modelOptions.length ? (
              <Dropdown value={model} options={modelOptions} onChange={pickModel} />
            ) : (
              <input
                className="field"
                placeholder={needsKey && !hasKey ? "Add a key to list models" : "Model"}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                onBlur={() => pickModel(model)}
                onKeyDown={(e) => e.key === "Enter" && pickModel(model)}
                spellCheck={false}
              />
            )}
            <span className="note status">
              {ping.status === "ok" && (
                <>
                  <span className="gdot" />
                  Connected · {ping.ms} ms
                </>
              )}
              {ping.status === "checking" && "Checking…"}
              {ping.status === "err" && (
                <span className="warn" title={ping.error}>
                  <span className="wdot" />
                  {shortError(ping.error)}
                </span>
              )}
              {ping.status === "idle" && (needsKey && !hasKey ? "Add a key to connect" : "")}
            </span>
          </span>
        </Row>
      )}
      <Row label="Context sent" top>
        <div className="checks">
          <Check on={settings.context.highlight} label="Highlight and its paragraph" onChange={(v) => save({ context: { ...settings.context, highlight: v } })} />
          <Check on={settings.context.session} label="Pages in this session" onChange={(v) => save({ context: { ...settings.context, session: v } })} />
          <Check on={settings.context.folder} label="Whole folder" onChange={(v) => save({ context: { ...settings.context, folder: v } })} />
          <Check on={settings.context.map} label="Session map (an index of every page)" onChange={(v) => save({ context: { ...settings.context, map: v } })} />
        </div>
      </Row>
      <Row label="Tools" top>
        <div className="checks">
          <Check on={settings.tools} label="Let the model read the folder itself" onChange={(v) => save({ tools: v })} />
          <span className="note wrap">It can list, read and search the pages in the open folder while it answers.</span>
          <Check on={settings.webAccess} label="Let the model search the web" onChange={(v) => save({ webAccess: v })} />
          <span className="note wrap">
            {webSearchFor(p, auth)
              ? "Search queries can include text from your pages."
              : `${NO_WEB[p]} can't search the web. Anthropic and the ChatGPT plan can.`}
          </span>
        </div>
      </Row>
    </div>
  );
}

function shortError(e?: string): string {
  if (!e) return "Not connected";
  const s = e.replace(/\s+/g, " ").trim();
  return s.length > 42 ? s.slice(0, 40) + "…" : s;
}

function Check({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    // A span, not a label: a label may not take a role, and there is no input here for it to label.
    <span className={`check${on ? " on" : ""}`} role="checkbox" aria-checked={on} tabIndex={0} onKeyDown={pressOnKey} onClick={() => onChange(!on)}>
      <span className="box" aria-hidden="true">
        {on && <CheckIcon />}
      </span>
      {label}
    </span>
  );
}

export { DEFAULT_SETTINGS };
