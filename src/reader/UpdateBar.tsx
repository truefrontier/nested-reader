import { store, useReader } from "../state/store";

/** Whole megabytes, one decimal under ten. */
function mb(bytes: number): string {
  const m = bytes / 1_000_000;
  return m < 10 ? m.toFixed(1) : Math.round(m).toString();
}

/**
 * The offer to install a newer version, at the foot of the window. It appears once a check finds
 * one (quietly, a few seconds after launch), follows the download, and goes away with Later or
 * when the app relaunches. Check for Updates… in the menu brings it back after Later.
 */
export function UpdateBar() {
  const s = useReader();
  const u = s.update;
  if (u.dismissed) return null;
  if (u.phase === "idle" || u.phase === "checking") return null;
  if (u.phase === "error" && !u.version) {
    // A failed check from the menu: say why, and offer another try.
    return (
      <div className="update-bar" role="status">
        <span className="what">{u.message ?? "Couldn't check for updates."}</span>
        <span className="acts" key="acts">
          <button onClick={() => void store.checkForUpdate(true)}>Try again</button>
          <button className="quiet" onClick={() => store.dismissUpdate()}>
            Later
          </button>
        </span>
      </div>
    );
  }
  const name = <b>Nested {u.version}</b>;
  if (u.phase === "downloading") {
    const pct = u.total ? Math.min(100, Math.round(((u.downloaded ?? 0) / u.total) * 100)) : undefined;
    return (
      <div className="update-bar" role="status">
        <span className="what">
          Downloading {name}… {pct !== undefined ? `${pct}%` : `${mb(u.downloaded ?? 0)} MB`}
        </span>
        <span className={`meter${pct === undefined ? " busy" : ""}`} key="meter">
          <i style={{ width: `${pct ?? 0}%` }} />
        </span>
      </div>
    );
  }
  if (u.phase === "installing") {
    return (
      <div className="update-bar" role="status">
        <span className="what">Installing {name}… it will relaunch in a moment.</span>
        <span className="meter busy" key="meter">
          <i />
        </span>
      </div>
    );
  }
  return (
    <div className="update-bar" role="status">
      <span className="what">
        {u.phase === "error" ? (
          <>
            {u.message ?? "The update didn't install."} {name} is still ready.
          </>
        ) : (
          <>
            {name} is ready{u.current ? `; you're on ${u.current}` : ""}. It takes a moment and relaunches the app.
          </>
        )}
      </span>
      <span className="acts" key="acts">
        <button onClick={() => void store.installUpdate()}>{u.phase === "error" ? "Try again" : "Update and relaunch"}</button>
        <button className="quiet" onClick={() => store.dismissUpdate()}>
          Later
        </button>
      </span>
    </div>
  );
}
