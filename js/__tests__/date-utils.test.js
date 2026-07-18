// Deterministic tests for js/date-utils.js — the real browser module (not a duplicate), loaded
// as an ES module because js/package.json scopes this directory to "type":"module" for Node.
// Run with: node js/__tests__/date-utils.test.js
import assert from "node:assert";
import { localDateString, localDateParts, DEFAULT_TIME_ZONE } from "../date-utils.js";

let pass = 0;
let fail = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    fail++;
    failures.push({ name, err });
    console.log(`FAIL  - ${name}`);
    console.log(`        ${err.message}`);
  }
}

await test("DEFAULT_TIME_ZONE is Asia/Kuala_Lumpur", () => {
  assert.strictEqual(DEFAULT_TIME_ZONE, "Asia/Kuala_Lumpur");
});

await test("ordinary midday UTC instant matches the same calendar day in MYT", () => {
  // 2026-07-19T06:00:00Z -> 2026-07-19T14:00:00+08:00 (still the same day)
  const d = new Date("2026-07-19T06:00:00.000Z");
  assert.strictEqual(localDateString(d, DEFAULT_TIME_ZONE), "2026-07-19");
});

await test("Malaysia midnight rollover: a UTC instant just before UTC midnight is already the NEXT day in MYT (UTC+8)", () => {
  // 2026-07-18T16:30:00Z (still July 18 in UTC) -> 2026-07-19T00:30:00+08:00 (already July 19 in MYT)
  const d = new Date("2026-07-18T16:30:00.000Z");
  assert.strictEqual(localDateString(d, DEFAULT_TIME_ZONE), "2026-07-19");
});

await test("Malaysia midnight rollover: a UTC instant just before that boundary is still the PRIOR day in MYT", () => {
  // 2026-07-18T15:59:59.999Z -> 2026-07-18T23:59:59.999+08:00 (still July 18 in MYT)
  const d = new Date("2026-07-18T15:59:59.999Z");
  assert.strictEqual(localDateString(d, DEFAULT_TIME_ZONE), "2026-07-18");
});

await test("year rollover: New Year's Eve UTC afternoon is already New Year's Day in MYT", () => {
  // 2025-12-31T16:05:00Z -> 2026-01-01T00:05:00+08:00
  const d = new Date("2025-12-31T16:05:00.000Z");
  const parts = localDateParts(d, DEFAULT_TIME_ZONE);
  assert.deepStrictEqual(parts, { year: 2026, month: 1, day: 1 });
  assert.strictEqual(localDateString(d, DEFAULT_TIME_ZONE), "2026-01-01");
});

await test("year rollover: shortly before that boundary is still the old year in MYT", () => {
  // 2025-12-31T15:59:00Z -> 2025-12-31T23:59:00+08:00
  const d = new Date("2025-12-31T15:59:00.000Z");
  assert.strictEqual(localDateString(d, DEFAULT_TIME_ZONE), "2025-12-31");
});

await test("leap-day boundary (2028-02-29) resolves correctly in MYT", () => {
  const d = new Date("2028-02-29T20:00:00.000Z"); // -> 2028-03-01T04:00+08:00
  assert.strictEqual(localDateString(d, DEFAULT_TIME_ZONE), "2028-03-01");
});

await test("localDateString defaults to Asia/Kuala_Lumpur when no timeZone is passed", () => {
  const d = new Date("2026-07-18T16:30:00.000Z");
  assert.strictEqual(localDateString(d), "2026-07-19");
});

await test("a different IANA zone genuinely produces a different calendar day for the same instant", () => {
  const d = new Date("2026-07-18T16:30:00.000Z"); // 00:30 MYT (Jul 19) vs 16:30 UTC (Jul 18)
  assert.strictEqual(localDateString(d, "Asia/Kuala_Lumpur"), "2026-07-19");
  assert.strictEqual(localDateString(d, "UTC"), "2026-07-18");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nFailures:");
  failures.forEach(({ name, err }) => console.log(`  - ${name}: ${err.message}`));
  process.exit(1);
}
