import { test } from "node:test";
import assert from "node:assert/strict";
import { relTime } from "./time";

// Pinned so the clock arithmetic below means the same thing on every machine.
process.env.TZ = "America/Chicago";

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const weekday = (d: Date) => d.toLocaleDateString(undefined, { weekday: "short" });

test("relTime is empty for a missing or broken time", () => {
  assert.equal(relTime(undefined), "");
  assert.equal(relTime("not a date"), "");
});

test("relTime counts minutes and hours within the day", () => {
  const now = at(2026, 6, 10, 12, 0);
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  assert.equal(relTime(ago(30_000), now), "now");
  assert.equal(relTime(ago(30_000), now, "long"), "just now");
  assert.equal(relTime(ago(5 * 60_000), now), "5m");
  assert.equal(relTime(ago(5 * 60_000), now, "long"), "5m ago");
  assert.equal(relTime(ago(3 * 3_600_000), now), "3h");
});

test("relTime names yesterday, then the weekday, then the date", () => {
  const now = at(2026, 6, 10, 12, 0);
  assert.equal(relTime(at(2026, 6, 9, 9, 0).toISOString(), now), "yesterday");
  const three = at(2026, 6, 7, 21, 5);
  assert.equal(relTime(three.toISOString(), now), `${weekday(three)} 9:05`);
  assert.equal(relTime(three.toISOString(), now, "long"), weekday(three));
  const old = at(2026, 5, 1, 8, 0);
  assert.equal(relTime(old.toISOString(), now), old.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
});

test("relTime does not call the day before yesterday 'yesterday' just after the clocks go forward", () => {
  // 8 March 2026 has 23 hours here, so 24 hours before 00:30 on the 9th is still the 7th.
  const now = at(2026, 3, 9, 0, 30);
  const sat = at(2026, 3, 7, 23, 0);
  assert.equal(relTime(sat.toISOString(), now), `${weekday(sat)} 11:00`);
});
