import type { StreamEvent, StreamHandle } from "./types";

/**
 * The life of an answer stream, the same on every platform. `open` starts the backend's stream, hands
 * its events to `send`, and gives back `ended`, which resolves to whether the backend sent a `done` or
 * `error`, and `cancel`. Nothing reaches `onEvent` after the last event or a cancel.
 */
export function trackStream(
  onEvent: (e: StreamEvent) => void,
  open: (send: (e: StreamEvent) => void) => { ended: Promise<boolean>; cancel(): void },
): StreamHandle {
  let finished = false;
  const send = (e: StreamEvent) => {
    if (finished) return;
    // Only `done` and `error` end the stream; `tool` lines keep arriving while the model looks things up.
    if (e.type === "done" || e.type === "error") finished = true;
    onEvent(e);
  };
  const { ended, cancel } = open(send);
  // One the backend did send may still be on its way (channel messages and the invoke result arrive
  // in either order), so it is left to arrive; a stream that ended with none, and that this side did
  // not cancel, is settled here instead.
  ended.then(
    (sent) => {
      if (!sent) send({ type: "error", message: "The stream stopped without finishing. Try again." });
    },
    (err: unknown) => send({ type: "error", message: String(err) }),
  );
  return {
    cancel() {
      finished = true;
      cancel();
    },
  };
}
