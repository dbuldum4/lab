import assert from "node:assert/strict";
import test from "node:test";
import { SessionTouchBarrier } from "./session-touch-barrier.ts";

test("a touch enqueued synchronously by flush is included in the following backup wait", async () => {
  const barrier = new SessionTouchBarrier();
  let release!: () => void;
  const touch = new Promise<void>((resolve) => { release = resolve; });

  // Models persistence.flush(): onHealth enqueues before flush resolves.
  barrier.enqueue(() => touch);
  let finished = false;
  const waiting = barrier.wait().then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  release();
  await waiting;
  assert.equal(finished, true);
});
