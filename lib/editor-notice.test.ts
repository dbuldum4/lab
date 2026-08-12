import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyEditorNotice,
  createEditorNoticeController,
  type EditorNotice,
  type EditorNoticeDependencies,
} from "./editor-notice.ts";

class ManualScheduler {
  private nextId = 0;
  private callbacks = new Map<number, () => void>();
  readonly cancelled = new Set<number>();

  schedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    void delayMs;
    const id = ++this.nextId;
    this.callbacks.set(id, callback);
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  cancel(handle: ReturnType<typeof setTimeout>) {
    this.cancelled.add(handle as unknown as number);
  }

  fire(handle: ReturnType<typeof setTimeout>) {
    this.callbacks.get(handle as unknown as number)?.();
  }

  get lastHandle() {
    return (this.nextId || 0) as unknown as ReturnType<typeof setTimeout>;
  }

  get pending() {
    return this.callbacks.size;
  }
}

function dependencies(
  scheduler: ManualScheduler,
  notices: Array<EditorNotice | null>,
  overrides: Partial<EditorNoticeDependencies> = {},
): EditorNoticeDependencies {
  return {
    schedule: scheduler.schedule.bind(scheduler),
    cancel: scheduler.cancel.bind(scheduler),
    onChange: (notice) => notices.push(notice),
    autoDismissMs: 100,
    ...overrides,
  };
}

test("classifies ordinary notices separately from failures and data-safety warnings", () => {
  assert.equal(classifyEditorNotice("Exported 1 session."), "info");
  assert.equal(classifyEditorNotice("Could not inspect local storage."), "error");
  assert.equal(classifyEditorNotice("The note changed while the file was loading. Import was cancelled."), "warning");
  assert.equal(classifyEditorNotice("2 conflicting local drafts are available."), "warning");
  assert.equal(classifyEditorNotice("A newer local revision is already stored in another tab."), "warning");
  assert.equal(classifyEditorNotice("That linking session is no longer available."), "error");
  assert.equal(classifyEditorNotice("The original session cannot be deleted."), "error");
});

test("routine notices auto-dismiss after the configured interval", () => {
  const scheduler = new ManualScheduler();
  const notices: Array<EditorNotice | null> = [];
  const controller = createEditorNoticeController(dependencies(scheduler, notices));

  const notice = controller.set("Updated image alt text and title.");
  assert.equal(notice?.kind, "info");
  assert.equal(controller.get(), notice);
  assert.equal(scheduler.pending, 1);

  scheduler.fire(scheduler.lastHandle);
  assert.equal(controller.get(), null);
  assert.deepEqual(notices, [notice, null]);
});

test("a stale timer cannot clear a newer notice", () => {
  const scheduler = new ManualScheduler();
  const notices: Array<EditorNotice | null> = [];
  const controller = createEditorNoticeController(dependencies(scheduler, notices));

  const first = controller.set("Changed the theme to Light.");
  const firstTimer = scheduler.lastHandle;
  const second = controller.set("This note could not be saved before switching sessions.");

  assert.equal(scheduler.cancelled.has(firstTimer as unknown as number), true);
  scheduler.fire(firstTimer);
  assert.equal(controller.get(), second);
  assert.deepEqual(notices, [first, second]);
});

test("a late old timer cannot prevent cleanup of a newer timer", () => {
  const scheduler = new ManualScheduler();
  const notices: Array<EditorNotice | null> = [];
  const controller = createEditorNoticeController(dependencies(scheduler, notices));

  controller.set("Pinned this session.");
  const firstTimer = scheduler.lastHandle;
  const second = controller.set("Unpinned this session.");
  const secondTimer = scheduler.lastHandle;

  scheduler.fire(firstTimer);
  assert.equal(controller.get(), second);
  assert.equal(controller.dismiss(second?.id), true);
  assert.equal(scheduler.cancelled.has(secondTimer as unknown as number), true);
});

test("warnings and errors remain until explicitly dismissed", () => {
  const scheduler = new ManualScheduler();
  const notices: Array<EditorNotice | null> = [];
  const controller = createEditorNoticeController(dependencies(scheduler, notices));

  const notice = controller.set("Some local storage locations are unavailable.");
  assert.equal(notice?.kind, "error");
  assert.equal(scheduler.pending, 0);
  assert.equal(controller.dismiss((notice?.id ?? 0) + 1), false);
  assert.equal(controller.get(), notice);
  assert.equal(controller.dismiss(notice?.id), true);
  assert.equal(controller.get(), null);
});

test("clearing a notice cancels its pending auto-dismiss", () => {
  const scheduler = new ManualScheduler();
  const notices: Array<EditorNotice | null> = [];
  const controller = createEditorNoticeController(dependencies(scheduler, notices));

  const notice = controller.set("Changed the theme to Light.");
  const timer = scheduler.lastHandle;
  assert.equal(controller.set(null), null);
  scheduler.fire(timer);

  assert.equal(scheduler.cancelled.has(timer as unknown as number), true);
  assert.deepEqual(notices, [notice, null]);
});

test("dispose cancels an active timer and suppresses late callbacks", () => {
  const scheduler = new ManualScheduler();
  const notices: Array<EditorNotice | null> = [];
  const controller = createEditorNoticeController(dependencies(scheduler, notices));

  controller.set("Pinned this session.");
  const timer = scheduler.lastHandle;
  controller.dispose();
  scheduler.fire(timer);

  assert.equal(scheduler.cancelled.has(timer as unknown as number), true);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.message, "Pinned this session.");
  assert.equal(controller.get(), null);
  assert.equal(controller.set("A later notice."), null);
});

test("activation resumes a controller after an effect-style cleanup", () => {
  const scheduler = new ManualScheduler();
  const notices: Array<EditorNotice | null> = [];
  const controller = createEditorNoticeController(dependencies(scheduler, notices));

  controller.dispose();
  controller.activate();
  const notice = controller.set("A later notice.");

  assert.equal(notice?.message, "A later notice.");
  assert.equal(controller.get(), notice);
});

test("callers can override classification for messages that need to remain visible", () => {
  const scheduler = new ManualScheduler();
  const notices: Array<EditorNotice | null> = [];
  const controller = createEditorNoticeController(dependencies(scheduler, notices));

  const notice = controller.set("Saved the note.", "warning");
  assert.equal(notice?.kind, "warning");
  assert.equal(scheduler.pending, 0);
});
