import why from "../../examples/sleep-memory/why-the-brain-replays-the-day.md?raw";
import replay from "../../examples/sleep-memory/replay-into-cortex.md?raw";
import ripples from "../../examples/sleep-memory/sharp-wave-ripples.md?raw";
import same from "../../examples/sleep-memory/same-order.md?raw";
import other from "../../examples/sleep-memory/does-replay-run-the-other-way.md?raw";
import slow from "../../examples/sleep-memory/slow-oscillations.md?raw";
import tmr from "../../examples/targeted-reactivation/targeted-memory-reactivation.md?raw";
import odour from "../../examples/targeted-reactivation/odour-cues.md?raw";

export const SAMPLE_FOLDER = "~/notes/sleep-memory";

export const SAMPLE_FILES: Record<string, string> = {
  "why-the-brain-replays-the-day.md": why,
  "replay-into-cortex.md": replay,
  "sharp-wave-ripples.md": ripples,
  "same-order.md": same,
  "does-replay-run-the-other-way.md": other,
  "slow-oscillations.md": slow,
};

/** A second folder, which ⌘⇧O adds to the open session in the browser. */
export const EXTRA_FOLDER = "~/notes/targeted-reactivation";

export const EXTRA_FILES: Record<string, string> = {
  "targeted-memory-reactivation.md": tmr,
  "odour-cues.md": odour,
};
