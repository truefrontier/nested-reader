import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// mermaid itself needs a browser, so it is swapped for a stand-in that records how it was set up.
// What the reader shows was checked in a browser; this keeps the setting from quietly going away.
const STUB = "data:text/javascript,export default { initialize(c) { globalThis.mermaidConfig = c; }, async render() { return { svg: '<svg></svg>' }; } };";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "mermaid") return { url: STUB, shortCircuit: true };
    return next(specifier, context);
  },
});
Object.assign(globalThis, { document: { documentElement: { dataset: { theme: "dark" } } } });
const { renderMermaid } = await import("./mermaid");

test("diagrams are drawn with SVG text labels, which survive the sanitizer", async () => {
  // HTML labels sit in <foreignObject>, which DOMPurify's SVG profile drops: a flowchart then shows
  // empty boxes. SVG text needs no HTML inside the SVG at all.
  assert.equal(await renderMermaid("flowchart LR\n  A --> B"), "<svg></svg>");
  const config = (globalThis as { mermaidConfig?: Record<string, unknown> }).mermaidConfig;
  assert.equal(config?.htmlLabels, false);
  assert.equal(config?.securityLevel, "strict");
  assert.equal(config?.theme, "dark");
});
