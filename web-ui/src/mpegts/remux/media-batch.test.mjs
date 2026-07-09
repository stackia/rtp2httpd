import assert from "node:assert/strict";
import test from "node:test";

import { isMediaBatchReady, normalizeMediaBatchLimit } from "./media-batch.ts";

const track = (dtsValues, length = 0) => ({
  samples: dtsValues.map((dts) => ({ dts })),
  length,
});

test("does not flush an empty or undersized steady-state batch", () => {
  assert.equal(isMediaBatchReady(null, null, 250, 512 * 1024), false);
  assert.equal(isMediaBatchReady(track([0, 249]), null, 250, 512 * 1024), false);
});

test("flushes when either track reaches the target DTS span", () => {
  assert.equal(isMediaBatchReady(track([0, 250]), track([0, 200]), 250, 512 * 1024), true);
  assert.equal(isMediaBatchReady(track([0, 200]), track([1000, 1250]), 250, 512 * 1024), true);
});

test("flushes at the combined byte limit even before the target duration", () => {
  assert.equal(isMediaBatchReady(track([0], 256 * 1024), track([0], 256 * 1024), 250, 512 * 1024), true);
  assert.equal(isMediaBatchReady(track([0], 256 * 1024 - 1), track([0], 256 * 1024), 250, 512 * 1024), false);
});

test("supports a zero duration for legacy per-callback behavior", () => {
  assert.equal(isMediaBatchReady(track([0]), null, 0, 0), true);
  assert.equal(isMediaBatchReady(null, null, 0, 0), false);
});

test("ignores invalid and backward DTS spans", () => {
  assert.equal(isMediaBatchReady(track([250, 0]), null, 250, 0), false);
  assert.equal(isMediaBatchReady(track([0, Number.NaN]), null, 250, 0), false);
});

test("normalizes invalid configured limits without creating a permanent gate", () => {
  assert.equal(normalizeMediaBatchLimit(undefined, 250), 250);
  assert.equal(normalizeMediaBatchLimit(Number.NaN, 250), 250);
  assert.equal(normalizeMediaBatchLimit(Number.POSITIVE_INFINITY, 250), 250);
  assert.equal(normalizeMediaBatchLimit(-1, 250), 0);
});
