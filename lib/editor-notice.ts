export const NOTICE_AUTO_DISMISS_MS = 4_000;

export type EditorNoticeKind = "info" | "warning" | "error";

export type EditorNotice = {
  id: number;
  message: string;
  kind: EditorNoticeKind;
};

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

export type EditorNoticeDependencies = {
  schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  cancel?: (handle: TimerHandle) => void;
  onChange?: (notice: EditorNotice | null) => void;
  autoDismissMs?: number;
};

export type EditorNoticeController = {
  set: (message: string | null, kind?: EditorNoticeKind) => EditorNotice | null;
  dismiss: (id?: number) => boolean;
  get: () => EditorNotice | null;
  activate: () => void;
  dispose: () => void;
};

const DATA_SAFETY_WARNING_PATTERNS = [
  /export (?:a|an|the) copy/i,
  /conflicting local/i,
  /note changed while/i,
  /not fully saved/i,
  /was deleted/i,
  /restore cancelled/i,
  /import was cancelled/i,
  /newer local revision/i,
  /another tab/i,
];

const ERROR_PATTERNS = [
  /could not/i,
  /failed/i,
  /unavailable/i,
  /invalid/i,
  /too large/i,
  /cannot/i,
  /no longer (?:available|selected)/i,
];

/**
 * Keep the existing string-only notice call sites safe by default. New callers
 * can pass an explicit kind when the message is not self-describing.
 */
export function classifyEditorNotice(message: string): EditorNoticeKind {
  if (DATA_SAFETY_WARNING_PATTERNS.some((pattern) => pattern.test(message))) return "warning";
  if (ERROR_PATTERNS.some((pattern) => pattern.test(message))) return "error";
  return "info";
}

/**
 * Owns notice timing independently from React so replacement, dismissal, and
 * unmount behavior can be tested without mounting the editor.
 */
export function createEditorNoticeController(
  dependencies: EditorNoticeDependencies = {},
): EditorNoticeController {
  const schedule = dependencies.schedule ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
  const cancel = dependencies.cancel ?? ((handle) => globalThis.clearTimeout(handle));
  const autoDismissMs = dependencies.autoDismissMs ?? NOTICE_AUTO_DISMISS_MS;

  let current: EditorNotice | null = null;
  let nextId = 0;
  let timer: TimerHandle | null = null;
  let disposed = false;

  const clearTimer = () => {
    if (timer === null) return;
    cancel(timer);
    timer = null;
  };

  const publish = (notice: EditorNotice | null) => {
    current = notice;
    dependencies.onChange?.(notice);
  };

  const set = (message: string | null, kind: EditorNoticeKind = message ? classifyEditorNotice(message) : "info") => {
    if (disposed) return current;
    clearTimer();

    if (message === null) {
      publish(null);
      return null;
    }

    const notice: EditorNotice = { id: ++nextId, message, kind };
    publish(notice);

    if (kind === "info") {
      const noticeId = notice.id;
      const scheduledTimer = schedule(() => {
        if (timer !== scheduledTimer) return;
        timer = null;
        if (disposed || current?.id !== noticeId) return;
        publish(null);
      }, autoDismissMs);
      timer = scheduledTimer;
    }

    return notice;
  };

  const dismiss = (id?: number) => {
    if (!current || (id !== undefined && current.id !== id)) return false;
    clearTimer();
    publish(null);
    return true;
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimer();
    current = null;
  };

  const activate = () => {
    disposed = false;
  };

  return {
    set,
    dismiss,
    get: () => current,
    activate,
    dispose,
  };
}
