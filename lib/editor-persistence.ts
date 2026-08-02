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
  onNotice?: (notice: string | null) => void;
  onStageFailure?: () => void;
};

export type EditorPersistenceController = {
  hydrate: () => Promise<string>;
  markLoaded: (markdown: string) => void;
  onEdit: (markdown: string) => number;
  flush: () => Promise<void>;
  dispose: () => Promise<void>;
  inspect: () => Promise<StorageHealth>;
  getState: () => {
    loaded: boolean;
    editRevision: number;
    persistedRevision: number;
    saveInFlightRevision: number | null;
  };
};

function isAuthorityFailure(health: StorageHealth) {
  return health.errors.some((error) => (
    error.includes("authority")
    || error.includes("Cross-tab persistence")
    || error.includes("requires IndexedDB")
    || error.includes("could not be verified")
  ));
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
  let saveInFlight: { revision: number; promise: Promise<void> } | null = null;

  const clearTimer = () => {
    if (timer === null) return;
    cancel(timer);
    timer = null;
  };

  const reportHealth = (health: StorageHealth, revision: number) => {
    if (revision !== editRevision) return;
    dependencies.onHealth?.(health);
    if (health.saved === true) {
      dependencies.onNotice?.(health.errors.length > 0
        ? "Saved, but one or more local copies could not be updated."
        : null);
      return;
    }
    dependencies.onNotice?.(isAuthorityFailure(health)
      ? "This change could not be saved locally. Please export a copy before closing the page."
      : "A newer local revision is already stored in another tab.");
  };

  const saveRevision = async (markdown: string, revision: number) => {
    if (!loaded || revision !== editRevision || revision <= persistedRevision) return;
    if (saveInFlight?.revision === revision) return saveInFlight.promise;

    const promise = (async () => {
      try {
        const health = await save(markdown);
        reportHealth(health, revision);
        if (health.saved === true && revision === editRevision) persistedRevision = revision;
      } catch {
        if (revision === editRevision) {
          dependencies.onNotice?.("This change could not be saved locally. Please export a copy before closing the page.");
        }
      }
    })();
    saveInFlight = { revision, promise };
    try {
      await promise;
    } finally {
      if (saveInFlight?.promise === promise) saveInFlight = null;
    }
  };

  const flush = () => {
    clearTimer();
    if (!loaded || editRevision <= persistedRevision) return Promise.resolve();
    if (saveInFlight?.revision === editRevision) return saveInFlight.promise;
    return saveRevision(latestMarkdown, editRevision);
  };

  const markLoaded = (markdown: string) => {
    if (disposed) return;
    latestMarkdown = markdown;
    loaded = true;
    persistedRevision = editRevision;
  };

  return {
    async hydrate() {
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
        void saveRevision(markdown, revision);
      }, delayMs);
      return revision;
    },

    flush,

    async dispose() {
      if (disposed) return;
      const pending = flush();
      disposed = true;
      await pending;
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
