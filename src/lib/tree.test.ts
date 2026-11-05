import { test } from "node:test";
import assert from "node:assert/strict";
import type { PageMeta, Session } from "../platform/types";
import { buildFolders, buildTree, dirOf, dotState, folderChain, growsFrom, layoutWeb, rootDirs, rootOf, sessionPages } from "./tree";

/** Pages keyed by path, as the store holds them; `[path, source?, created?]`. */
function pages(...rows: [string, string?, string?][]): Record<string, PageMeta> {
  const out: Record<string, PageMeta> = {};
  for (const [path, source, created] of rows) out[path] = { path, title: path, source, created };
  return out;
}

const DAY1 = "2026-01-01T00:00:00Z";
const DAY2 = "2026-01-02T00:00:00Z";
const DAY3 = "2026-01-03T00:00:00Z";

test("rootDirs lists each added root once and leaves out the session folder", () => {
  const roots = [{ folder: "/s" }, { folder: "/a" }, { folder: "/a" }, { folder: "/b" }] as { folder: string }[];
  assert.deepEqual(rootDirs(roots as never, "/s"), ["/a", "/b"]);
  assert.deepEqual(rootDirs(undefined, "/s"), []);
});

test("buildTree puts roots newest first and children oldest first under their source", () => {
  const p = pages(["old.md", undefined, DAY1], ["new.md", undefined, DAY3], ["kid2.md", "old.md", DAY3], ["kid1.md", "old.md", DAY2]);
  assert.deepEqual(buildTree(p), [
    { path: "new.md", depth: 0, branch: false, hasChildren: false },
    { path: "old.md", depth: 0, branch: false, hasChildren: true },
    { path: "kid1.md", depth: 1, branch: true, hasChildren: false },
    { path: "kid2.md", depth: 1, branch: true, hasChildren: false },
  ]);
});

test("buildTree keeps a page whose source is missing, itself or a cycle", () => {
  const p = pages(["orphan.md", "gone.md"], ["self.md", "self.md"], ["a.md", "b.md", DAY1], ["b.md", "a.md", DAY2]);
  const rows = buildTree(p);
  assert.deepEqual(rows.map((r) => r.path).sort(), ["a.md", "b.md", "orphan.md", "self.md"]);
  assert.equal(rows.find((r) => r.path === "orphan.md")?.depth, 0);
  assert.equal(rows.find((r) => r.path === "self.md")?.depth, 0);
});

test("dirOf and folderChain climb to the root, stopping at an added root's folder", () => {
  assert.equal(dirOf("a/b/c.md"), "a/b");
  assert.equal(dirOf("c.md"), "");
  assert.deepEqual(folderChain("a/b"), ["a/b", "a", ""]);
  assert.deepEqual(folderChain("/x/notes/sub", ["/x/notes"]), ["/x/notes/sub", "/x/notes", ""]);
});

test("buildFolders nests directories, sorts them by name with numbers in order, and hangs added roots off the top", () => {
  const p = pages(["top.md"], ["10/a.md"], ["2/b.md"], ["2/deep/c.md"], ["/ext/notes/d.md"]);
  const root = buildFolders(p, ["/ext/notes"]);
  assert.deepEqual(root.items.map((i) => i.path), ["top.md"]);
  assert.deepEqual(root.folders.map((f) => [f.path, f.name, f.root]), [
    ["2", "2", undefined],
    ["10", "10", undefined],
    ["/ext/notes", "notes", true],
  ]);
  const two = root.folders.find((f) => f.path === "2");
  assert.deepEqual(two?.folders.map((f) => f.path), ["2/deep"]);
  assert.deepEqual(two?.items.map((i) => i.path), ["2/b.md"]);
});

test("dotState prefers current, then loading, unread, pending and read", () => {
  const s = { current: "c.md", loading: ["l.md", "c.md"], unread: ["u.md", "l.md"], pending: { "p.md": 1, "u.md": 1 }, read: { "r.md": "x", "p.md": "x" } } as unknown as Session;
  assert.deepEqual(["c.md", "l.md", "u.md", "p.md", "r.md", "z.md"].map((p) => dotState(p, s)), ["current", "loading", "unread", "pending", "read", "plain"]);
});

test("rootOf and growsFrom follow sources up and stop on a cycle", () => {
  const p = pages(["root.md"], ["mid.md", "root.md"], ["leaf.md", "mid.md"], ["a.md", "b.md"], ["b.md", "a.md"]);
  assert.equal(rootOf("leaf.md", p), "root.md");
  assert.equal(growsFrom("leaf.md", "root.md", p), true);
  assert.equal(growsFrom("root.md", "leaf.md", p), false);
  assert.equal(growsFrom("a.md", "root.md", p), false);
});

test("sessionPages lists the rest of the session, ancestors nearest first", () => {
  const p = pages(["root.md"], ["mid.md", "root.md"], ["leaf.md", "mid.md"], ["other.md"]);
  assert.deepEqual(sessionPages("leaf.md", p).map((x) => x.path), ["mid.md", "root.md"]);
});

test("sessionPages returns on a page that names itself as its source", () => {
  const p = pages(["self.md", "self.md"], ["kid.md", "self.md"], ["kid2.md", "self.md"]);
  assert.deepEqual(sessionPages("self.md", p).map((x) => x.path), ["kid.md", "kid2.md"]);
});

test("sessionPages returns when the session's sources form a cycle", () => {
  const p = pages(["a.md", "b.md"], ["b.md", "a.md"], ["c.md", "a.md"], ["d.md", "a.md"]);
  assert.deepEqual(sessionPages("c.md", p).map((x) => x.path), ["a.md", "d.md"]);
});

test("layoutWeb puts the focused page's root at the centre with an edge to each child", () => {
  const p = pages(["root.md", undefined, DAY1], ["kid.md", "root.md", DAY2]);
  const { nodes, edges } = layoutWeb(p, "kid.md");
  assert.deepEqual(nodes[0], { path: "root.md", x: 0.5, y: 0.5, depth: 0 });
  assert.deepEqual(edges, [{ from: "root.md", to: "kid.md" }]);
  assert.equal(nodes.length, 2);
});

test("layoutWeb with no focus centres on a root, not on whichever path sorts first", () => {
  const p = pages(["a-kid.md", "z-root.md"], ["z-root.md"]);
  const { nodes, edges } = layoutWeb(p, undefined);
  assert.equal(nodes[0].path, "z-root.md");
  assert.deepEqual(edges, [{ from: "z-root.md", to: "a-kid.md" }]);
});

test("layoutWeb never centres on a focused page that is no longer in the folder", () => {
  const { nodes } = layoutWeb(pages(["x.md"]), "gone.md");
  assert.deepEqual(nodes.map((n) => n.path), ["x.md"]);
});

test("layoutWeb places every page once when sources loop back on themselves", () => {
  const p = pages(["a.md", "b.md"], ["b.md", "a.md"], ["c.md", "a.md"], ["self.md", "self.md"]);
  for (const focus of ["a.md", "c.md", "self.md", undefined]) {
    const { nodes } = layoutWeb(p, focus);
    assert.deepEqual(nodes.map((n) => n.path).sort(), ["a.md", "b.md", "c.md", "self.md"], `focus ${focus}`);
  }
});
