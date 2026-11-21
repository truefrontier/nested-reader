/** Opt-in webview error reporting. No destination means a harmless no-op. */
import * as Sentry from "@sentry/browser";

const DSN = import.meta.env.VITE_CRASH_DSN?.trim() ?? "";
let enabled = false;
let initialized = false;
let hooksInstalled = false;

export function crashReportingConfigured(): boolean { return DSN.length > 0; }
export function configureCrashReporting(nextEnabled: boolean): void {
  enabled = nextEnabled;
  if (!enabled) return;
  installCrashHooks();
  if (!crashReportingConfigured() || initialized) return;
  Sentry.init({ dsn: DSN, sendClientReports: false, sendDefaultPii: false, tracesSampleRate: 0, defaultIntegrations: false, integrations: [Sentry.dedupeIntegration()], beforeSend(event) { if (!enabled) return null; delete event.user; delete event.request; return event; } });
  initialized = true;
}
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!enabled || !initialized) return;
  try { Sentry.withScope((scope) => { if (context) scope.setContext("nested", context); Sentry.captureException(error instanceof Error ? error : new Error(typeof error === "string" ? error : "Unhandled non-Error rejection")); }); } catch { /* reporting never affects the reader */ }
}
export function installCrashHooks(): void {
  if (hooksInstalled || typeof window === "undefined") return;
  hooksInstalled = true;
  window.addEventListener("error", (event) => captureException(event.error ?? new Error(event.message || "Unhandled window error"), { mechanism: "window.error" }));
  window.addEventListener("unhandledrejection", (event) => captureException(event.reason, { mechanism: "window.unhandledrejection" }));
}
