import assert from "node:assert/strict";
import test from "node:test";
import {
  formatApproximateBytes,
  formatStorageEstimate,
  parseStorageEstimate,
} from "./storage-estimate.ts";

test("storage estimate parsing keeps finite, non-negative byte values", () => {
  assert.deepEqual(parseStorageEstimate({ usage: 1_500, quota: 12_000 }), {
    usage: 1_500,
    quota: 12_000,
  });
  assert.deepEqual(parseStorageEstimate({ usage: Number.NaN, quota: 12_000 }), {
    usage: null,
    quota: 12_000,
  });
  assert.equal(parseStorageEstimate({ usage: -1, quota: Number.POSITIVE_INFINITY }), null);
  assert.equal(parseStorageEstimate(undefined), null);
  assert.deepEqual(parseStorageEstimate({ usage: "1500", quota: 12_000 }), parseStorageEstimate({ quota: 12_000 }));
});

test("storage estimate byte formatting is readable and explicitly approximate", () => {
  assert.equal(formatApproximateBytes(0), "about 0 B");
  assert.equal(formatApproximateBytes(1024), "about 1 KB");
  assert.equal(formatApproximateBytes(1_572_864), "about 1.5 MB");
  assert.equal(formatApproximateBytes(Number.NaN), null);
  assert.equal(formatApproximateBytes(Number.POSITIVE_INFINITY), null);
  assert.equal(formatApproximateBytes(-1), null);
});

test("storage estimate formatting degrades when one side is unavailable", () => {
  assert.equal(
    formatStorageEstimate({ usage: 2_048, quota: 10_485_760 }),
    "about 2 KB used of about 10 MB quota",
  );
  assert.equal(
    formatStorageEstimate({ usage: 2_048, quota: null }),
    "about 2 KB used (quota unavailable)",
  );
  assert.equal(
    formatStorageEstimate({ usage: null, quota: 10_485_760 }),
    "about 10 MB quota (usage unavailable)",
  );
  assert.equal(formatStorageEstimate(null), null);
  assert.equal(formatStorageEstimate({ usage: null, quota: null }), null);
});
