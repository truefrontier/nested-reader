import mermaid from "mermaid";
import DOMPurify from "dompurify";

type Theme = "light" | "dark";

let initedAs: Theme | undefined;

function ensureInit(theme: Theme) {
  if (initedAs === theme) return;
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: theme === "dark" ? "dark" : "default" });
  initedAs = theme;
}

let counter = 0;

/** Renders mermaid source to sanitized SVG markup, or null when the source is invalid. */
export async function renderMermaid(source: string): Promise<string | null> {
  const theme: Theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  ensureInit(theme);
  try {
    const { svg } = await mermaid.render(`mermaid-diagram-${counter++}`, source);
    return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
  } catch {
    return null;
  }
}
