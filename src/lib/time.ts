const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function hhmm(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m}`;
}

/** Short relative label in the register of the design: "now", "2m", "3h", "yesterday", "Tue 9:12", "Sep 3". */
export function relTime(iso: string | undefined, now = new Date(), style: "short" | "long" = "short"): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = now.getTime() - d.getTime();
  if (diff < MINUTE) return style === "long" ? "just now" : "now";
  if (diff < HOUR) {
    const m = Math.floor(diff / MINUTE);
    return style === "long" ? `${m}m ago` : `${m}m`;
  }
  if (diff < DAY) {
    const h = Math.floor(diff / HOUR);
    return style === "long" ? `${h}h ago` : `${h}h`;
  }
  const yesterday = new Date(now.getTime() - DAY);
  if (sameDay(d, yesterday)) return "yesterday";
  if (diff < 6 * DAY) {
    const wd = d.toLocaleDateString(undefined, { weekday: "short" });
    return style === "long" ? wd : `${wd} ${hhmm(d)}`;
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function nowIso(): string {
  return new Date().toISOString();
}
