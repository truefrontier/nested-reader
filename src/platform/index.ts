import type { Platform } from "./types";
import { mockPlatform } from "./mock";
import { tauriPlatform } from "./tauri";

declare global {
  interface Window {
    isTauri?: boolean;
    __TAURI_INTERNALS__?: unknown;
  }
}

export const isTauri = typeof window !== "undefined" && (Boolean(window.isTauri) || "__TAURI_INTERNALS__" in window);

export const platform: Platform = isTauri ? tauriPlatform : mockPlatform;

export * from "./types";
