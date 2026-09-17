import type { ReactNode } from "react";
import { useReader, type ReaderState } from "../state/store";
import { DragBand } from "./DragBand";

type TopStatus = "writing" | "refining" | "failed";

/** `mark` is the class of the dot drawn before the label. */
const STATUS: Record<TopStatus, { label: string; mark: "pulse" | "fdot" }> = {
  writing: { label: "Writing…", mark: "pulse" },
  refining: { label: "Refining…", mark: "pulse" },
  failed: { label: "Couldn't be written", mark: "fdot" },
};

/**
 * What the bar says about the pages on show — the current page and the split, since the split is
 * what a new page streams into. First match wins, so a page that failed reads as failed even while
 * it is still being taken out of `session.loading`. At rest it says nothing: a page that is simply
 * saved is the usual case, and the bar only earns its space by reporting the unusual one.
 */
export function topStatus(s: ReaderState): TopStatus | undefined {
  const { current, split, loading } = s.session;
  if (!current) return undefined;
  const shown = (split ? [current, split] : [current]).filter((p) => s.pages[p]);
  if (shown.some((p) => s.pageErrors[p])) return "failed";
  if (shown.some((p) => loading.includes(p))) return "writing";
  // A finished refine is deleted and a failed one keeps its error, so membership without one is still running.
  if (Object.values(s.ui.refines).some((r) => !r.error && r.pages.some((p) => shown.includes(p)))) return "refining";
  return undefined;
}

/** The title bar: the session's name in the middle, what the session is doing on the right. */
export function TopBar({ children }: { children?: ReactNode }) {
  const s = useReader();
  const status = topStatus(s);
  return (
    <div className="topbar">
      <DragBand />
      <div className="tb-left">{children}</div>
      <div className="tb-title">{s.folderName || "Library"}</div>
      <div className="tb-status">
        {status && (
          <>
            <span className={STATUS[status].mark} />
            {STATUS[status].label}
          </>
        )}
      </div>
    </div>
  );
}
