import type { PageMeta, Session } from "../platform/types";

export type TreeItem = {
  path: string;
  depth: number;
  /** True when this row hangs off the row above it (a background branch). */
  branch: boolean;
  /** Whether the row after this one at the same or deeper depth is a child. */
  hasChildren: boolean;
};

function stamp(p: PageMeta): number {
  const t = Date.parse(p.created ?? p.modified ?? "");
  return Number.isNaN(t) ? 0 : t;
}

/**
 * The sidebar list: trail pages newest-first, each followed by its
 * background branches (deep dives), indented and oldest-first.
 */
export function buildTree(pages: Record<string, PageMeta>): TreeItem[] {
  const all = Object.values(pages);
  const byParent = new Map<string, PageMeta[]>();
  for (const p of all) {
    if (p.mode === "deep-dive" && p.source && pages[p.source]) {
      const list = byParent.get(p.source) ?? [];
      list.push(p);
      byParent.set(p.source, list);
    }
  }
  for (const list of byParent.values()) list.sort((a, b) => stamp(a) - stamp(b));
  const trail = all.filter((p) => !(p.mode === "deep-dive" && p.source && pages[p.source]));
  trail.sort((a, b) => stamp(b) - stamp(a));
  const out: TreeItem[] = [];
  const walk = (p: PageMeta, depth: number, branch: boolean) => {
    const kids = byParent.get(p.path) ?? [];
    out.push({ path: p.path, depth, branch, hasChildren: kids.length > 0 });
    for (const k of kids) walk(k, depth + 1, true);
  };
  for (const p of trail) walk(p, 0, false);
  return out;
}

export type DotState = "current" | "loading" | "unread" | "pending" | "read" | "plain";

export function dotState(path: string, session: Session): DotState {
  if (session.current === path) return "current";
  if (session.loading.includes(path)) return "loading";
  if (session.unread.includes(path)) return "unread";
  if (session.pending[path]) return "pending";
  if (session.read[path]) return "read";
  return "plain";
}

/** Root of the session a page belongs to (follows `source` links up). */
export function rootOf(path: string, pages: Record<string, PageMeta>): string {
  let cur = path;
  const seen = new Set<string>();
  while (pages[cur]?.source && pages[pages[cur].source as string] && !seen.has(cur)) {
    seen.add(cur);
    cur = pages[cur].source as string;
  }
  return cur;
}

/** Every page that shares a root with `path`, excluding `path` itself, nearest first. */
export function sessionPages(path: string, pages: Record<string, PageMeta>): PageMeta[] {
  const root = rootOf(path, pages);
  const out: PageMeta[] = [];
  for (const p of Object.values(pages)) {
    if (p.path === path) continue;
    if (rootOf(p.path, pages) === root) out.push(p);
  }
  const dist = (p: PageMeta) => {
    let d = 0;
    let cur: string | undefined = path;
    while (cur && cur !== p.path && pages[cur]?.source) {
      cur = pages[cur].source;
      d++;
    }
    return cur === p.path ? d : 99;
  };
  out.sort((a, b) => dist(a) - dist(b));
  return out;
}

/** Layout for the web map: root at the centre, depth as radius. */
export type MapNode = { path: string; x: number; y: number; depth: number };
export type MapEdge = { from: string; to: string };

export function layoutWeb(pages: Record<string, PageMeta>, focus: string | undefined): { nodes: MapNode[]; edges: MapEdge[] } {
  const all = Object.values(pages);
  if (!all.length) return { nodes: [], edges: [] };
  const root = focus ? rootOf(focus, pages) : all.map((p) => p.path).sort()[0];
  const children = new Map<string, PageMeta[]>();
  for (const p of all) {
    if (p.source && pages[p.source]) {
      const list = children.get(p.source) ?? [];
      list.push(p);
      children.set(p.source, list);
    }
  }
  for (const list of children.values()) list.sort((a, b) => stamp(a) - stamp(b));
  const size = new Map<string, number>();
  const measure = (path: string): number => {
    const kids = children.get(path) ?? [];
    const s = 1 + kids.reduce((acc, k) => acc + measure(k.path), 0);
    size.set(path, s);
    return s;
  };
  measure(root);
  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const depthOf = (path: string): number => {
    const kids = children.get(path) ?? [];
    return kids.length ? 1 + Math.max(...kids.map((k) => depthOf(k.path))) : 0;
  };
  const maxDepth = Math.max(1, depthOf(root));
  const step = 0.3 / maxDepth;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const place = (path: string, depth: number, a0: number, a1: number) => {
    const angle = (a0 + a1) / 2;
    const r = depth === 0 ? 0 : 0.08 + depth * step;
    nodes.push({
      path,
      x: clamp(0.5 + Math.cos(angle) * r * 1.4, 0.12, 0.88),
      y: clamp(0.5 + Math.sin(angle) * r * 1.05, 0.14, 0.9),
      depth,
    });
    const kids = children.get(path) ?? [];
    const total = kids.reduce((acc, k) => acc + (size.get(k.path) ?? 1), 0);
    let a = a0;
    const span = a1 - a0;
    for (const k of kids) {
      const w = (span * (size.get(k.path) ?? 1)) / Math.max(total, 1);
      edges.push({ from: path, to: k.path });
      place(k.path, depth + 1, a, a + w);
      a += w;
    }
  };
  place(root, 0, Math.PI * 0.75, Math.PI * 0.75 + Math.PI * 2);
  // Pages not connected to this root still get a spot along the bottom.
  const placed = new Set(nodes.map((n) => n.path));
  let k = 0;
  for (const p of all) {
    if (placed.has(p.path)) continue;
    nodes.push({ path: p.path, x: 0.15 + (k++ % 5) * 0.17, y: 0.9, depth: 9 });
  }
  return { nodes, edges };
}

/** True when `path` is `root` or was grown from it, however many steps down. */
export function growsFrom(path: string, root: string, pages: Record<string, PageMeta>): boolean {
  let cur: string | undefined = path;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    if (cur === root) return true;
    seen.add(cur);
    cur = pages[cur]?.source;
  }
  return false;
}
