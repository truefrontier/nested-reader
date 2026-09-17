import type { ReactNode } from "react";
import { useReader, type ReaderState } from "../state/store";
import { DragBand } from "./DragBand";
import { CheckIcon } from "./Icons";

type StatusMark = "check" | "pulse" | "warn";

type TopStatus = "saved" | "writing" | "refining" | "failed";

const STATUS: Record<TopStatus, { label: string; mark: StatusMark }> = {
  saved: { label: "Saved locally", mark: "check" },
  writing: { label: "Writing…", mark: "pulse" },
  refining: { label: "Refining…", mark: "pulse" },
  failed: { label: "Couldn't be written", mark: "warn" },
};

/**
 * What the bar says about the pages on show — the current page and the split, since the split is
 * what a new page streams into. First match wins, so a page that failed reads as failed even while
 * it is still being taken out of `session.loading`.
 */
export function topStatus(s: ReaderState): TopStatus | undefined {
  const { current, split, loading } = s.session;
  if (!current) return undefined;
  const shown = (split ? [current, split] : [current]).filter((p) => s.pages[p]);
  if (shown.some((p) => s.pageErrors[p])) return "failed";
  if (shown.some((p) => loading.includes(p))) return "writing";
  // A finished refine is deleted and a failed one keeps its error, so membership without one is still running.
  if (Object.values(s.ui.refines).some((r) => !r.error && r.pages.some((p) => shown.includes(p)))) return "refining";
  return "saved";
}

function Mark({ mark }: { mark: StatusMark }) {
  if (mark === "check") {
    return (
      <span className="tb-check">
        <CheckIcon />
      </span>
    );
  }
  return <span className={mark === "pulse" ? "pulse" : "fdot"} />;
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
            <Mark mark={STATUS[status].mark} />
            {STATUS[status].label}
          </>
        )}
      </div>
    </div>
  );
}
