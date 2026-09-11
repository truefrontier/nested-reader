import type { ReactElement, ReactNode } from "react";
import { store, useReader, type PaneRole } from "../state/store";
import type { PageDiff } from "../lib/diff";
import { relTime } from "../lib/time";
import { ChevronDown } from "./Icons";

/** Review strip, version history and viewing for either pane. Children (the find bar) stack under it. */
export function TopStrip({ path, role, diff, children }: { path: string; role: PaneRole; diff: PageDiff | null; children?: ReactNode }) {
  const s = useReader();
  const view = s.ui.versionView[role];
  const versions = s.versions[path] ?? [];
  const currentN = versions.length ? versions[versions.length - 1].n + 1 : 1;
  const review = !!diff && diff.changes.length > 0 && view.viewing === undefined;
  const viewing = view.viewing !== undefined ? versions.find((v) => v.n === view.viewing) : undefined;
  const hasHistory = versions.length > 0;
  if (!review && !viewing && !hasHistory && !children) return null;
  const modified = s.pages[path]?.modified;

  let content: ReactElement | null = null;
  if (review && diff) {
    const n = diff.changes.length;
    content = (
      <div className="strip">
        <span className="st">
          <span className="sdot" />
          {n} {n === 1 ? "change" : "changes"}
        </span>
        <span className="quiet" onClick={() => void store.undoAll(path)}>
          Undo all
        </span>
        <span className="loud" onClick={() => store.done(path)}>
          Done
        </span>
      </div>
    );
  } else if (viewing) {
    content = (
      <>
        <div className="strip">
          <span className="st">
            <span className="sdot warn" />
            Viewing Version {viewing.n} · {relTime(viewing.at, new Date(), "long")}
          </span>
          <span className="quiet" onClick={() => store.askRestore(role)}>
            Restore
          </span>
          <span className="loud" onClick={() => store.backToCurrent(role)}>
            Back to current
          </span>
        </div>
        {view.confirmRestore && (
          <div className="confirm">
            <div>Restore Version {viewing.n}?</div>
            <div className="sub">Version {currentN} won't be kept.</div>
            <div className="acts">
              <span className="c" onClick={() => store.cancelRestore(role)}>
                Cancel
              </span>
              <span onClick={() => void store.restore(role)}>Restore</span>
            </div>
          </div>
        )}
      </>
    );
  } else if (hasHistory) {
    content = (
      <>
        <div className={`pill${view.history ? " open" : ""}`} onClick={() => store.toggleHistory(role)}>
          Version {currentN} · edited {relTime(modified, new Date(), "long") || "just now"}
          <ChevronDown />
        </div>
        {view.history && (
          <div className="menu">
            <div className="item cur">
              <span>Version {currentN} · current</span>
              <span className="t">{relTime(modified, new Date(), "long") || "just now"}</span>
            </div>
            {[...versions].reverse().map((v) => (
              <div key={v.n} className="item" onClick={() => void store.viewVersion(v.n, role)}>
                <span>
                  Version {v.n}
                  {v.n === 1 ? " · original" : ""}
                </span>
                <span className="t">{relTime(v.at, new Date(), "long")}</span>
              </div>
            ))}
          </div>
        )}
      </>
    );
  }
  return (
    <div className="top">
      <div className="top-inner">
        {content}
        {children}
      </div>
    </div>
  );
}
