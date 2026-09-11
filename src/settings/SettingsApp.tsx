import { useEffect, useRef, useState, type ReactNode } from "react";
import { DEFAULT_SETTINGS, isTauri, platform, type OpenAtLaunch, type Placement, type Provider, type Settings } from "../platform";
import { AiIcon, AppearanceIcon, CheckIcon, GeneralIcon, UpDownIcon } from "../reader/Icons";

type Tab = "general" | "appearance" | "ai";

const PLACEMENTS: { value: Placement; label: string }[] = [
  { value: "beside", label: "Beside" },
  { value: "below", label: "Below" },
  { value: "active", label: "Active pane" },
  { value: "background", label: "In background" },
  { value: "window", label: "New window" },
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
  { value: "custom", label: "Custom" },
];

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

  useEffect(() => {
    if (!embedded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [embedded, onClose]);

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
    <div className={`settings${embedded ? " embedded" : ""}`}>
      <div className="settings-title">
        {embedded && (
          <div className="tl" style={{ position: "absolute" }}>
            <span style={{ background: "#ff5f57" }} onClick={onClose} />
            <span style={{ background: "#febc2e" }} />
            <span style={{ background: "#28c840" }} />
          </div>
        )}
        {!embedded && <div className="titlebar" />}
        Settings
      </div>
      <div className="tabs">
        <div className={`tab${tab === "general" ? " on" : ""}`} onClick={() => setTab("general")}>
          <GeneralIcon />
          General
        </div>
        <div className={`tab${tab === "appearance" ? " on" : ""}`} onClick={() => setTab("appearance")}>
          <AppearanceIcon />
          Appearance
        </div>
        <div className={`tab${tab === "ai" ? " on" : ""}`} onClick={() => setTab("ai")}>
          <AiIcon />
          AI
        </div>
      </div>
      <div className="settings-body-inner" key={tab}>
        {tab === "general" && <General settings={settings} save={save} />}
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
      <div className="val">{children}</div>
    </>
  );
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string; className?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <span key={o.value} className={`${o.value === value ? "on" : ""} ${o.className ?? ""}`.trim()} onClick={() => onChange(o.value)}>
          {o.label}
        </span>
      ))}
    </div>
  );
}

function Dropdown<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const current = options.find((o) => o.value === value)?.label ?? value;
  return (
    <div className="dd-wrap" onMouseDown={(e) => e.stopPropagation()}>
      <div className={`dd${open ? " open" : ""}`} onClick={() => setOpen(!open)}>
        {current}
        <UpDownIcon />
      </div>
      {open && (
        <div className="dd-menu">
          {options.map((o) => (
            <div
              key={o.value}
              className={o.value === value ? "on" : ""}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
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

function General({ settings, save }: SectionProps) {
  const [sub, setSub] = useState<string | null>(null);
  const pick = async () => {
    const folder = await platform.pickFolder();
    if (folder) save({ folder });
  };
  const folderLabel = settings.folder ? settings.folder.replace(/^\/Users\/[^/]+/, "~") : "No folder chosen";
  return (
    <div className="grid">
      <Row label="Folder">
        <span className="spread">
          <span className="ell" title={settings.folder}>
            {folderLabel}
          </span>
          <span className="act" onClick={() => void pick()}>
            Change…
          </span>
        </span>
      </Row>
      <Row label="New pages">
        {sub === null ? (
          <span className="spread">
            <span>{settings.newPagesSubfolder ? `Saved in ${settings.newPagesSubfolder}/ as .md` : "Saved next to their source as .md"}</span>
            <span className="act" onClick={() => setSub(settings.newPagesSubfolder)}>
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
    </div>
  );
}

function Appearance({ settings, save }: SectionProps) {
  const min = 13;
  const max = 22;
  const pct = ((settings.textSize - min) / (max - min)) * 100;
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
      <div className="divider" />
      <Row label="New Page opens">
        <Dropdown value={settings.newPageOpens} options={PLACEMENTS} onChange={(v) => save({ newPageOpens: v })} />
      </Row>
      <Row label="Deep Dive opens">
        <Dropdown value={settings.deepDiveOpens} options={PLACEMENTS} onChange={(v) => save({ deepDiveOpens: v })} />
      </Row>
      <div className="hint">Hold ⌥ while pressing a shortcut to use the other placement.</div>
    </div>
  );
}

type Ping = { status: "idle" | "checking" | "ok" | "err"; ms?: number; error?: string };

function Ai({ settings, save }: SectionProps) {
  const p = settings.provider;
  const external = p !== "builtin";
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [keyEditing, setKeyEditing] = useState(false);
  const [ping, setPing] = useState<Ping>({ status: "idle" });
  const [model, setModel] = useState(settings.models[p]);
  const pingTimer = useRef<number | undefined>(undefined);
  const pingSeq = useRef(0);

  useEffect(() => {
    setModel(settings.models[p]);
    setKeyDraft("");
    setKeyEditing(false);
    if (p === "builtin") {
      setHasKey(null);
      return;
    }
    platform.hasApiKey(p).then(setHasKey, () => setHasKey(false));
  }, [p, settings.models]);

  const check = (delay = 0) => {
    window.clearTimeout(pingTimer.current);
    if (!external) return;
    const seq = ++pingSeq.current;
    pingTimer.current = window.setTimeout(() => {
      setPing({ status: "checking" });
      platform.aiPing(p, settings.baseUrl, model).then(
        (r) => {
          if (seq !== pingSeq.current) return;
          setPing(r.ok ? { status: "ok", ms: r.ms } : { status: "err", error: r.error });
        },
        (e) => seq === pingSeq.current && setPing({ status: "err", error: String(e) }),
      );
    }, delay);
  };

  useEffect(() => {
    if (external && hasKey !== null) check(100);
    return () => window.clearTimeout(pingTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p, hasKey, settings.baseUrl]);

  const commitKey = async () => {
    if (!external) return;
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

  const commitModel = () => {
    const m = model.trim();
    if (m !== settings.models[p]) save({ models: { ...settings.models, [p]: m } });
    check(0);
  };

  return (
    <div className="grid">
      <Row label="Provider">
        <Seg value={p} options={PROVIDERS} onChange={(v) => save({ provider: v })} />
      </Row>
      {!external && (
        <Row label="Plan">
          <span className="spread">
            <span className="mute">Not available in this build. Choose OpenAI, Anthropic or Custom.</span>
          </span>
        </Row>
      )}
      {external && p === "custom" && (
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
      {external && (
        <>
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
          <Row label="Model">
            <span className="with-note">
              <input className="field" value={model} onChange={(e) => setModel(e.target.value)} onBlur={commitModel} onKeyDown={(e) => e.key === "Enter" && commitModel()} spellCheck={false} />
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
                {ping.status === "idle" && (hasKey ? "" : "Add a key to connect")}
              </span>
            </span>
          </Row>
        </>
      )}
      <Row label="Context sent" top>
        <div className="checks">
          <Check on={settings.context.highlight} label="Highlight and its paragraph" onChange={(v) => save({ context: { ...settings.context, highlight: v } })} />
          <Check on={settings.context.session} label="Pages in this session" onChange={(v) => save({ context: { ...settings.context, session: v } })} />
          <Check on={settings.context.folder} label="Whole folder" onChange={(v) => save({ context: { ...settings.context, folder: v } })} />
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
    <label className={`check${on ? " on" : ""}`} onClick={() => onChange(!on)}>
      <span className="box">{on && <CheckIcon />}</span>
      {label}
    </label>
  );
}

export { DEFAULT_SETTINGS };
