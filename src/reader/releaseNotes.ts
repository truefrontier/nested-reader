import { version as APP_VERSION } from "../../package.json";

export type ReleaseNote = { version: string; highlights: string[] };

/**
 * A small hand-maintained list, newest first, shown from the Send feedback popover (⌘R).
 * Add an entry here when a release has something worth telling people about.
 */
export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: "0.2.12",
    highlights: ["Send feedback: ⌘R now toggles this popover to show what's new, instead of doing nothing."],
  },
];

/** The current build's notes, falling back to the newest entry if this exact version isn't listed. */
export const CURRENT_RELEASE_NOTES: ReleaseNote = RELEASE_NOTES.find((n) => n.version === APP_VERSION) ?? RELEASE_NOTES[0];
