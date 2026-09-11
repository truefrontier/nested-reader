const DAY = 86_400_000;

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function hhmm(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m}`;
}

/** Short relative label in the register of the design: "now", "9:20", "yesterday", "Tue 9:12", "Sep 3". */
export function relTime(iso: string | undefined, now = new Date(), style: "short" | "long" = "short"): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return style === "long" ? "just now" : "now";
  if (sameDay(d, now)) return hhmm(d);
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
