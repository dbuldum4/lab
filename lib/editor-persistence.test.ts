import assert from "node:assert/strict";
import test from "node:test";
import {
  createEditorPersistenceController,
  type EditorPersistenceDependencies,
} from "./editor-persistence.ts";
import type { StorageHealth } from "./local-vault.ts";

function health(saved: boolean, errors: string[] = [], conflicts = 0): StorageHealth {
  return { copies: saved ? 1 : 0, labels: saved ? ["localStorage"] : [], persistent: false, errors, conflicts, saved };
}

class ManualScheduler {
  private nextId = 0;
  private callbacks = new Map<number, () => void>();

  schedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    void delayMs;
    const id = ++this.nextId;
    this.callbacks.set(id, callback);
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  cancel(handle: ReturnType<typeof setTimeout>) {
    this.callbacks.delete(handle as unknown as number);
  }

  fireNext() {
    const next = this.callbacks.entries().next().value as [number, () => void] | undefined;
    if (!next) return false;
    this.callbacks.delete(next[0]);
    next[1]();
    return true;
  }

  get pending() {
    return this.callbacks.size;
  }
}

function dependencies(overrides: Partial<EditorPersistenceDependencies> = {}) {
  const scheduler = new ManualScheduler();
  const staged: string[] = [];
  const saved: string[] = [];
  const notices: Array<string | null> = [];
  const options: EditorPersistenceDependencies = {
    schedule: scheduler.schedule.bind(scheduler),
    cancel: scheduler.cancel.bind(scheduler),
    stage: (markdown) => {
      staged.push(markdown);
      return true;
    },
    save: async (markdown) => {
      saved.push(markdown);
      return health(true);
    },
    onNotice: (notice) => notices.push(notice),
    ...overrides,
  };
  return { options, scheduler, staged, saved, notices };
}

test("hydration resolves before content is applied and pre-hydration edits are ignored", async () => {
  let resolveLoad: ((markdown: string) => void) | undefined;
  const state = dependencies({
    load: () => new Promise<string>((resolve) => { resolveLoad = resolve; }),
  });
  const controller = createEditorPersistenceController(state.options);
  let editorContent = "";
  const hydration = controller.hydrate().then((markdown) => {
    editorContent = markdown;
  });

  assert.equal(controller.getState().loaded, false);
  assert.equal(controller.onEdit("typed too early"), 0);
  assert.deepEqual(state.staged, []);
  assert.equal(editorContent, "");

  resolveLoad?.("saved note");
  await hydration;
  assert.equal(editorContent, "saved note");
  assert.equal(controller.getState().loaded, true);
});

test("edits stage synchronously and durable save is debounced", async () => {
  const state = dependencies();
  const controller = createEditorPersistenceController(state.options);
  controller.markLoaded("");

  assert.equal(controller.onEdit("first"), 1);
  assert.deepEqual(state.staged, ["first"]);
  assert.deepEqual(state.saved, []);
  assert.equal(state.scheduler.pending, 1);

  assert.equal(controller.onEdit("latest"), 2);
  assert.deepEqual(state.staged, ["first", "latest"]);
  assert.equal(state.scheduler.pending, 1);
  state.scheduler.fireNext();
  await controller.flush();

  assert.deepEqual(state.saved, ["latest"]);
  assert.equal(controller.getState().persistedRevision, 2);
});

test("flush cancels debounce and persists the latest content", async () => {
  const state = dependencies();
  const controller = createEditorPersistenceController(state.options);
  controller.markLoaded("");
  controller.onEdit("page-hidden note");
  assert.equal(state.scheduler.pending, 1);

  await controller.flush();
  assert.deepEqual(state.saved, ["page-hidden note"]);
  assert.equal(state.scheduler.pending, 0);
});

test("flush reports failed persistence so destructive navigation can be blocked", async () => {
  const state = dependencies({
    save: async () => health(false, ["IndexedDB authority is unavailable; the candidate was not written."]),
  });
  const controller = createEditorPersistenceController(state.options);
  controller.markLoaded("");
  controller.onEdit("must not be lost");

  assert.equal(await controller.flush(), false);
  assert.equal(controller.getState().persistedRevision, 0);
});

test("a stale save result cannot mark a newer revision persisted", async () => {
  let resolveFirst: ((result: StorageHealth) => void) | undefined;
  let resolveSecond: ((result: StorageHealth) => void) | undefined;
  let call = 0;
  const state = dependencies({
    save: () => {
      call += 1;
      return new Promise<StorageHealth>((resolve) => {
        if (call === 1) resolveFirst = resolve;
        else resolveSecond = resolve;
      });
    },
  });
  const controller = createEditorPersistenceController(state.options);
  controller.markLoaded("");
  controller.onEdit("old");
  state.scheduler.fireNext();
  await Promise.resolve();
  assert.equal(controller.getState().saveInFlightRevision, 1);

  controller.onEdit("new");
  resolveFirst?.(health(true));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(controller.getState().persistedRevision, 0);

  state.scheduler.fireNext();
  await Promise.resolve();
  resolveSecond?.(health(true));
  await controller.flush();
  assert.equal(controller.getState().persistedRevision, 2);
});

test("abandon cancels debounced saves without writing and ignores later edits", async () => {
  const state = dependencies();
  const controller = createEditorPersistenceController(state.options);
  controller.markLoaded("");
  controller.onEdit("do not keep");
  assert.equal(state.scheduler.pending, 1);
  assert.deepEqual(state.staged, ["do not keep"]);

  await controller.abandon();
  assert.equal(state.scheduler.pending, 0);
  assert.deepEqual(state.saved, []);
  assert.equal(controller.getState().loaded, false);

  assert.equal(controller.onEdit("after abandon"), 1);
  assert.deepEqual(state.staged, ["do not keep"]);
  assert.equal(state.scheduler.pending, 0);
  assert.deepEqual(state.saved, []);
});

test("abandon waits for an in-flight save then blocks further durable writes", async () => {
  let resolveSave: ((result: StorageHealth) => void) | undefined;
  let saveCalls = 0;
  let abandonResolved = false;
  const state = dependencies({
    save: () => {
      saveCalls += 1;
      return new Promise<StorageHealth>((resolve) => { resolveSave = resolve; });
    },
  });
  const controller = createEditorPersistenceController(state.options);
  controller.markLoaded("");
  controller.onEdit("in flight");
  state.scheduler.fireNext();
  await Promise.resolve();
  assert.equal(controller.getState().saveInFlightRevision, 1);
  assert.equal(saveCalls, 1);

  const abandoned = controller.abandon().then(() => { abandonResolved = true; });
  assert.equal(state.scheduler.pending, 0);
  await Promise.resolve();
  assert.equal(abandonResolved, false);

  resolveSave?.(health(true));
  await abandoned;
  assert.equal(abandonResolved, true);
  assert.equal(controller.getState().loaded, false);
  assert.equal(controller.getState().saveInFlightRevision, null);
  assert.equal(controller.onEdit("too late"), 1);
  assert.equal(state.scheduler.pending, 0);
  assert.equal(saveCalls, 1);
});

test("dispose flushes pending edits then stops accepting work without hanging", async () => {
  let resolveSave: ((result: StorageHealth) => void) | undefined;
  let saveCalls = 0;
  let savedMarkdown: string | undefined;
  const state = dependencies({
    save: (markdown) => {
      saveCalls += 1;
      savedMarkdown = markdown;
      return new Promise<StorageHealth>((resolve) => { resolveSave = resolve; });
    },
  });
  const controller = createEditorPersistenceController(state.options);
  controller.markLoaded("");
  controller.onEdit("keep me");
  state.scheduler.fireNext();
  await Promise.resolve();
  assert.equal(controller.getState().saveInFlightRevision, 1);
  assert.equal(saveCalls, 1);

  let disposeResolved = false;
  const disposed = controller.dispose().then((flushed) => {
    disposeResolved = true;
    return flushed;
  });
  await Promise.resolve();
  assert.equal(disposeResolved, false);

  resolveSave?.(health(true));
  assert.equal(await disposed, true);
  assert.equal(disposeResolved, true);
  assert.equal(controller.getState().loaded, false);
  assert.equal(controller.getState().persistedRevision, 1);
  assert.equal(savedMarkdown, "keep me");
  assert.equal(controller.onEdit("after dispose"), 1);
  assert.equal(state.scheduler.pending, 0);
  assert.equal(saveCalls, 1);
});

test("dispose with only a debounced edit persists it before becoming inert", async () => {
  const state = dependencies();
  const controller = createEditorPersistenceController(state.options);
  controller.markLoaded("");
  controller.onEdit("debounced");
  assert.equal(state.scheduler.pending, 1);

  assert.equal(await controller.dispose(), true);
  assert.deepEqual(state.saved, ["debounced"]);
  assert.equal(controller.getState().loaded, false);
  assert.equal(controller.getState().persistedRevision, 1);
  assert.equal(controller.onEdit("too late"), 1);
  assert.equal(state.scheduler.pending, 0);
});

test("dispose returns false when the final flush fails but still becomes inert", async () => {
  const state = dependencies({
    save: async () => health(false),
  });
  const controller = createEditorPersistenceController(state.options);
  controller.markLoaded("");
  controller.onEdit("unsaved");
  assert.equal(await controller.dispose(), false);
  assert.equal(controller.getState().loaded, false);
  assert.equal(controller.onEdit("too late"), 1);
  assert.equal(state.scheduler.pending, 0);
});

test("save outcomes distinguish conflict, degraded replicas, recovery drafts, and authority failure", async () => {
  const notices: string[] = [];
  let result: StorageHealth = health(false);
  const state = dependencies({
    save: async () => result,
    onNotice: (notice) => { if (notice) notices.push(notice); },
  });
  const controller = createEditorPersistenceController(state.options);
  controller.markLoaded("");

  controller.onEdit("conflict");
  state.scheduler.fireNext();
  await Promise.resolve();
  result = health(false, ["IndexedDB authority is unavailable; the candidate was not written."]);
  controller.onEdit("authority failure");
  state.scheduler.fireNext();
  await Promise.resolve();
  result = health(true, ["browser file system could not be updated"]);
  controller.onEdit("degraded");
  state.scheduler.fireNext();
  await Promise.resolve();
  result = health(true, [], 2);
  controller.onEdit("recoverable conflicts");
  state.scheduler.fireNext();
  await Promise.resolve();

  assert.equal(notices[0], "A newer local revision is already stored in another tab.");
  assert.equal(notices[1], "This change could not be saved locally. Please export a copy before closing the page.");
  assert.equal(notices[2], "Saved, but one or more local copies could not be updated.");
  assert.equal(notices[3], "2 conflicting local drafts are available. Use /recover to export.");
});


test("onPersisted reports the exact Markdown accepted by durable storage", async () => {
  const persisted: string[] = [];
  const state = dependencies({
    onPersisted: (markdown) => persisted.push(markdown),
  });
  const controller = createEditorPersistenceController(state.options);
  controller.markLoaded("");
  controller.onEdit("saved checkpoint");
  assert.equal(await controller.flush(), true);
  assert.deepEqual(persisted, ["saved checkpoint"]);

  const failedPersisted: string[] = [];
  const failed = dependencies({
    save: async () => health(false, ["IndexedDB authority is unavailable; the candidate was not written."]),
    onPersisted: (markdown) => failedPersisted.push(markdown),
  });
  const failedController = createEditorPersistenceController(failed.options);
  failedController.markLoaded("");
  failedController.onEdit("not durable");
  assert.equal(await failedController.flush(), false);
  assert.deepEqual(failedPersisted, []);
});
