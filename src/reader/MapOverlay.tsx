import { useMemo, type MouseEvent } from "react";
import { store, useReader } from "../state/store";
import { buildTree, dotState, layoutWeb } from "../lib/tree";
import { relTime } from "../lib/time";
import { CloseIcon } from "./Icons";

export function MapOverlay() {
  const s = useReader();
  const kind = s.ui.map;
  if (!kind) return null;
  const open = (path: string) => (e: MouseEvent) => {
    e.preventDefault();
    const placement = store.placementFor(e);
    if (placement === "active") store.closeMap();
    void store.openPage(path, placement);
  };
  return (
    <div className="map">
      <div className="map-tabs">
        <span className={kind === "web" ? "on" : ""} onClick={() => store.openMap("web")}>
          Web
        </span>
        <span className={kind === "timeline" ? "on" : ""} onClick={() => store.openMap("timeline")}>
          Timeline
        </span>
      </div>
      <button className="tbtn close" title="Close" onClick={() => store.closeMap()}>
        <CloseIcon />
      </button>
      {kind === "web" ? <Web open={open} /> : <Timeline open={open} />}
    </div>
  );
}

type Opener = (path: string) => (e: MouseEvent) => void;

function Web({ open }: { open: Opener }) {
  const s = useReader();
  const layout = useMemo(() => layoutWeb(s.pages, s.session.current), [s.pages, s.session.current]);
  const pos = new Map(layout.nodes.map((n) => [n.path, n]));
  return (
    <div className="web">
      <svg fill="none" stroke="var(--hair)" strokeWidth="1">
        {layout.edges.map((e) => {
          const a = pos.get(e.from);
          const b = pos.get(e.to);
          if (!a || !b) return null;
          return <line key={`${e.from}>${e.to}`} x1={`${a.x * 100}%`} y1={`${a.y * 100}%`} x2={`${b.x * 100}%`} y2={`${b.y * 100}%`} />;
        })}
      </svg>
      {layout.nodes.map((n) => {
        const d = dotState(n.path, s.session);
        const cls = ["node"];
        if (d === "current") cls.push("current");
        if (d === "loading") cls.push("loading");
        if (d === "unread") cls.push("unread");
        return (
          <div key={n.path} className={cls.join(" ")} style={{ left: `${n.x * 100}%`, top: `${n.y * 100}%` }} onClick={open(n.path)} title={s.pages[n.path]?.title}>
            <span className="label">{s.pages[n.path]?.title}</span>
            {d === "unread" && <span className="udot" />}
            {!!s.session.pending[n.path] && <span className="cdot" />}
          </div>
        );
      })}
    </div>
  );
}

function Timeline({ open }: { open: Opener }) {
  const s = useReader();
  const items = useMemo(() => buildTree(s.pages), [s.pages]);
  const childCount = (path: string) => Object.values(s.pages).filter((p) => p.source === path).length;
  return (
    <div className="timeline">
      <div className="timeline-inner">
        {items.length > 1 && <div className="tl-line" />}
        {items.map((it) => {
          const p = s.pages[it.path];
          const d = dotState(it.path, s.session);
          const cls = ["trow", `d${Math.min(it.depth, 3)}`];
          if (d === "current") cls.push("current");
          if (d === "loading" || d === "unread") cls.push("muted");
          const src = p.source ? s.pages[p.source] : undefined;
          const kids = childCount(it.path);
          let sub: string | null = null;
          if (d === "current" && src) sub = `from ${src.title}`;
          else if (!p.source && kids) sub = `source · ${kids} ${kids === 1 ? "highlight" : "highlights"}`;
          return (
            <div key={it.path} className={cls.join(" ")} onClick={open(it.path)}>
              {it.branch && <span className="tick" />}
              <span className={`tdot${d === "current" ? " current" : d === "loading" ? " loading" : ""}`} />
              <div className="body">
                <div className="line1">
                  <span className="name">
                    {p.title}
                    {d === "unread" && <span className="udot" />}
                    {d === "pending" && <span className="cdot" />}
                  </span>
                  <span className="when">{d === "loading" ? "loading" : relTime(p.created ?? p.modified)}</span>
                </div>
                {sub && <div className="sub">{sub}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
