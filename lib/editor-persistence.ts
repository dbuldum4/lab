import {
  inspectLocalStorage,
  loadLocalDocument,
  saveLocalDocument,
  stageLocalDocument,
  type StorageHealth,
} from "./local-vault.ts";

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

export type EditorPersistenceDependencies = {
  load?: () => Promise<string>;
  inspect?: () => Promise<StorageHealth>;
  save?: (markdown: string) => Promise<StorageHealth>;
  stage?: (markdown: string) => boolean;
  delayMs?: number;
  schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  cancel?: (handle: TimerHandle) => void;
  onHealth?: (health: StorageHealth) => void;
  onPersisted?: (markdown: string, health: StorageHealth) => void;
  onNotice?: (notice: string | null) => void;
  onStageFailure?: () => void;
};

export type EditorPersistenceController = {
  hydrate: () => Promise<string>;
  markLoaded: (markdown: string) => void;
  onEdit: (markdown: string) => number;
  /** Persist the latest edit; false means a session switch would lose data. */
  flush: () => Promise<boolean>;
  /**
   * Stop accepting edits and cancel the debounce timer without writing.
   * Waits for an in-flight save so vault work finishes before a purge.
   * Use before deleting the active document; prefer dispose() when leaving with data intact.
   */
  abandon: () => Promise<void>;
  /**
   * Flush pending work, then stop accepting edits.
   * Returns false when the final flush failed (data may be incomplete before navigation).
   * Always becomes disposed, even on flush failure.
   */
  dispose: () => Promise<boolean>;
  inspect: () => Promise<StorageHealth>;
  getState: () => {
    loaded: boolean;
    editRevision: number;
    persistedRevision: number;
    saveInFlightRevision: number | null;
  };
};

function isDeletedSessionFailure(health: StorageHealth) {
  return health.errors.some((error) => error.includes("deleted in another tab"));
}

function isAuthorityFailure(health: StorageHealth) {
  return health.errors.some((error) => (
    error.includes("authority")
    || error.includes("Cross-tab persistence")
    || error.includes("requires IndexedDB")
    || error.includes("could not be verified")
  ));
}

function savedHealthNotice(health: StorageHealth) {
  const notices: string[] = [];
  if (health.errors.length > 0) notices.push("Saved, but one or more local copies could not be updated.");
  if (health.conflicts > 0) {
    notices.push(`${health.conflicts} conflicting local ${health.conflicts === 1 ? "draft is" : "drafts are"} available. Use /recover to export.`);
  }
  return notices.length > 0 ? notices.join(" ") : null;
}

/**
 * Owns only editor persistence timing and revision semantics. Storage policy
 * remains in local-vault; the injected boundary makes lifecycle behavior
 * deterministic without mounting the full Tiptap editor in unit tests.
 */
export function createEditorPersistenceController(
  dependencies: EditorPersistenceDependencies = {},
): EditorPersistenceController {
  const load = dependencies.load ?? loadLocalDocument;
  const inspect = dependencies.inspect ?? inspectLocalStorage;
  const save = dependencies.save ?? saveLocalDocument;
  const stage = dependencies.stage ?? stageLocalDocument;
  const delayMs = dependencies.delayMs ?? 180;
  const schedule = dependencies.schedule ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
  const cancel = dependencies.cancel ?? ((handle) => globalThis.clearTimeout(handle));

  let loaded = false;
  let disposed = false;
  let editRevision = 0;
  let persistedRevision = 0;
  let latestMarkdown = "";
  let timer: TimerHandle | null = null;
  let saveInFlight: { revision: number; promise: Promise<boolean> } | null = null;

  const clearTimer = () => {
    if (timer === null) return;
    cancel(timer);
    timer = null;
  };

  const reportHealth = (health: StorageHealth, revision: number) => {
    if (disposed || revision !== editRevision) return;
    dependencies.onHealth?.(health);
    if (health.saved === true) {
      dependencies.onNotice?.(savedHealthNotice(health));
      return;
    }
    if (isDeletedSessionFailure(health)) {
      dependencies.onNotice?.("This session was deleted in another tab. Export a copy if you still need this text.");
      return;
    }
    dependencies.onNotice?.(isAuthorityFailure(health)
      ? "This change could not be saved locally. Please export a copy before closing the page."
      : "A newer local revision is already stored in another tab.");
  };

  const saveRevision = async (markdown: string, revision: number): Promise<boolean> => {
    if (disposed || !loaded || revision !== editRevision || revision <= persistedRevision) return true;
    if (saveInFlight?.revision === revision) return saveInFlight.promise;

    const promise = (async () => {
      try {
        const health = await save(markdown);
        if (health.saved === true) dependencies.onPersisted?.(markdown, health);
        reportHealth(health, revision);
        if (!disposed && health.saved === true && revision === editRevision) persistedRevision = revision;
        return health.saved === true;
      } catch {
        if (!disposed && revision === editRevision) {
          dependencies.onNotice?.("This change could not be saved locally. Please export a copy before closing the page.");
        }
        return false;
      }
    })();
    saveInFlight = { revision, promise };
    try {
      return await promise;
    } finally {
      if (saveInFlight?.promise === promise) saveInFlight = null;
    }
  };

  const flush = async () => {
    if (disposed) return true;
    clearTimer();
    if (!loaded) return true;

    // An edit can arrive while an async save is in flight. Keep flushing until
    // the revision observed at the end is the revision that was persisted.
    while (!disposed && editRevision > persistedRevision) {
      const revision = editRevision;
      const saved = saveInFlight?.revision === revision
        ? await saveInFlight.promise
        : await saveRevision(latestMarkdown, revision);
      if (disposed) return true;
      if (!saved) return false;
    }
    return true;
  };

  const markLoaded = (markdown: string) => {
    if (disposed) return;
    latestMarkdown = markdown;
    loaded = true;
    persistedRevision = editRevision;
  };

  return {
    async hydrate() {
      if (disposed) return latestMarkdown;
      const markdown = await load();
      markLoaded(markdown);
      return markdown;
    },

    markLoaded,

    onEdit(markdown) {
      if (disposed || !loaded) return editRevision;
      latestMarkdown = markdown;
      editRevision += 1;
      if (!stage(markdown)) dependencies.onStageFailure?.();
      clearTimer();
      const revision = editRevision;
      timer = schedule(() => {
        timer = null;
        if (disposed) return;
        void saveRevision(markdown, revision);
      }, delayMs);
      return revision;
    },

    flush,

    async abandon() {
      if (disposed) return;
      clearTimer();
      disposed = true;
      loaded = false;
      const inFlight = saveInFlight?.promise;
      if (inFlight) await inFlight;
    },

    async dispose() {
      if (disposed) return true;
      // Await flush while still accepting in-flight completion so saveRevision can
      // advance persistedRevision. Setting disposed first made flush hang forever:
      // saveRevision returned true without updating persistedRevision while the
      // loop kept waiting for editRevision > persistedRevision.
      let flushed = true;
      try {
        flushed = await flush();
      } finally {
        clearTimer();
        disposed = true;
        loaded = false;
      }
      return flushed;
    },

    inspect,

    getState() {
      return {
        loaded,
        editRevision,
        persistedRevision,
        saveInFlightRevision: saveInFlight?.revision ?? null,
      };
    },
  };
}
