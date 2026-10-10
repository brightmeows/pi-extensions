/**
 * Unit tests for the situational availability module (availability.ts).
 * All I/O goes through injected temp paths.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  availabilityFilePath,
  availabilityMessage,
  isEntryActive,
  loadAvailability,
  parseDuration,
  parseOffArgs,
  saveAvailability,
  type AvailabilityState,
  type DisabledEntry,
} from "./availability.ts";

function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "avail-test-"));
  return path.join(dir, name);
}

function entry(overrides: Partial<DisabledEntry> = {}): DisabledEntry {
  return { reason: "quota exhausted", at: "2026-06-14T12:00:00.000Z", ...overrides };
}

const NOW = new Date("2026-06-14T13:00:00.000Z");

// ── parseDuration / parseOffArgs ───────────────────────────────────────────

test("parseDuration accepts unit suffixes", () => {
  assert.equal(parseDuration("30m"), 30 * 60_000);
  assert.equal(parseDuration("6h"), 6 * 3_600_000);
  assert.equal(parseDuration("1.5d"), 1.5 * 86_400_000);
  assert.equal(parseDuration("2w"), 2 * 604_800_000);
  assert.equal(parseDuration("45s"), 45_000);
  assert.equal(parseDuration("500ms"), 500);
  assert.equal(parseDuration("6"), undefined);
  assert.equal(parseDuration("hours"), undefined);
  assert.equal(parseDuration(""), undefined);
});

test("parseOffArgs splits leading duration from reason", () => {
  assert.deepEqual(parseOffArgs("6h quota used up"), {
    durationMs: 6 * 3_600_000,
    reason: "quota used up",
  });
  assert.deepEqual(parseOffArgs("6h"), { durationMs: 6 * 3_600_000, reason: "" });
  assert.deepEqual(parseOffArgs("quota used up"), {
    durationMs: undefined,
    reason: "quota used up",
  });
  assert.deepEqual(parseOffArgs(""), { durationMs: undefined, reason: "" });
  // A duration-looking fragment stays reason text once not leading.
  assert.deepEqual(parseOffArgs("wait 6h"), { durationMs: undefined, reason: "wait 6h" });
});

// ── persistence ────────────────────────────────────────────────────────────

test("loadAvailability returns empty state for missing or corrupt files", () => {
  const missing = tmpFile("missing.json");
  assert.deepEqual(loadAvailability(missing).disabled, {});

  const corrupt = tmpFile("corrupt.json");
  fs.writeFileSync(corrupt, "{not json");
  assert.deepEqual(loadAvailability(corrupt).disabled, {});
});

test("save/load round-trips entries", () => {
  const file = tmpFile("state.json");
  const state: AvailabilityState = {
    version: 1,
    disabled: {
      reviewer: entry(),
      explorer: entry({ until: "2099-01-01T00:00:00.000Z" }),
    },
  };
  saveAvailability(file, state);
  assert.deepEqual(loadAvailability(file), state);
});

test("loadAvailability drops lapsed entries and rewrites the file", () => {
  const file = tmpFile("ttl.json");
  saveAvailability(file, {
    version: 1,
    disabled: {
      reviewer: entry({ until: "2000-01-01T00:00:00.000Z" }), // long past
      explorer: entry(),
    },
  });
  const loaded = loadAvailability(file, NOW);
  assert.equal(Object.keys(loaded.disabled).join(","), "explorer");
  // The rewrite persisted the cleanup.
  assert.equal(Object.keys(loadAvailability(file, NOW).disabled).join(","), "explorer");
});

test("availabilityFilePath lives under ~/.pi/subagent", () => {
  const p = availabilityFilePath();
  assert.ok(p.includes(path.join(".pi", "subagent")));
  assert.ok(p.endsWith("availability.json"));
});

// ── TTL activity ───────────────────────────────────────────────────────────

test("isEntryActive honors until", () => {
  assert.equal(isEntryActive(entry(), NOW), true);
  assert.equal(isEntryActive(entry({ until: "2026-06-14T14:00:00.000Z" }), NOW), true);
  assert.equal(isEntryActive(entry({ until: "2026-06-14T12:00:00.000Z" }), NOW), false);
});

// ── model-visible announcement ────────────────────────────────────────────

test("availabilityMessage lists active disables in sorted order", () => {
  const state: AvailabilityState = {
    version: 1,
    disabled: {
      reviewer: entry(),
      explorer: entry({ reason: "" }),
      stale: entry({ until: "2000-01-01T00:00:00.000Z" }),
    },
  };
  const text = availabilityMessage(state, NOW);
  const lines = text.split("\n");
  // Sorted: explorer before reviewer; lapsed entry absent.
  assert.ok(lines[1].startsWith("- explorer"));
  assert.ok(lines[2].startsWith("- reviewer — quota exhausted"));
  assert.ok(!text.includes("stale"));
  assert.ok(text.includes("do not delegate to them"));
});

test("availabilityMessage is byte-stable across calls", () => {
  const state: AvailabilityState = {
    version: 1,
    disabled: { reviewer: entry({ until: "2026-06-15T00:00:00.000Z" }) },
  };
  assert.equal(
    availabilityMessage(state, NOW),
    availabilityMessage(state, NOW),
  );
  // Absolute timestamps only — nothing relative that would drift
  // in a persisted message.
  assert.ok(!availabilityMessage(state, NOW).includes("in "));
});

test("availabilityMessage announces all-online when nothing is disabled", () => {
  assert.match(availabilityMessage({ version: 1, disabled: {} }, NOW), /back online/);
  const lapsed: AvailabilityState = {
    version: 1,
    disabled: { reviewer: entry({ until: "2000-01-01T00:00:00.000Z" }) },
  };
  assert.match(availabilityMessage(lapsed, NOW), /back online/);
});
