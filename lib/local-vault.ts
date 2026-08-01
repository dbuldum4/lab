const LOCAL_KEY = "lab.document.v1";
const DB_NAME = "lab-private-vault";
const STORE_NAME = "documents";
const OPFS_FILE = "lab.md.snapshot";

export type LocalSnapshot = {
  markdown: string;
  updatedAt: number;
  checksum: string;
  version: 1;
};

export type StorageHealth = {
  copies: number;
  labels: string[];
  persistent: boolean;
};

async function checksum(markdown: string) {
  const bytes = new TextEncoder().encode(markdown);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function isValid(snapshot: LocalSnapshot | null): Promise<boolean> {
  if (!snapshot || snapshot.version !== 1 || typeof snapshot.markdown !== "string") return false;
  return snapshot.checksum === (await checksum(snapshot.markdown));
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readIndexedDb(): Promise<LocalSnapshot | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get("current");
    request.onsuccess = () => resolve((request.result as LocalSnapshot | undefined) ?? null);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

async function writeIndexedDb(snapshot: LocalSnapshot) {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(snapshot, "current");
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

type StorageManagerWithDirectory = StorageManager & {
  getDirectory?: () => Promise<FileSystemDirectoryHandle>;
};

async function opfsRoot() {
  return (navigator.storage as StorageManagerWithDirectory).getDirectory?.();
}

async function readOpfs(): Promise<LocalSnapshot | null> {
  const root = await opfsRoot();
  if (!root) return null;
  try {
    const handle = await root.getFileHandle(OPFS_FILE);
    const file = await handle.getFile();
    return JSON.parse(await file.text()) as LocalSnapshot;
  } catch {
    return null;
  }
}

async function writeOpfs(snapshot: LocalSnapshot) {
  const root = await opfsRoot();
  if (!root) throw new Error("OPFS unavailable");
  const handle = await root.getFileHandle(OPFS_FILE, { create: true });
  const writer = await handle.createWritable();
  await writer.write(JSON.stringify(snapshot));
  await writer.close();
}

function readLocalStorage(): LocalSnapshot | null {
  try {
    const value = localStorage.getItem(LOCAL_KEY);
    return value ? (JSON.parse(value) as LocalSnapshot) : null;
  } catch {
    return null;
  }
}

function writeLocalStorage(snapshot: LocalSnapshot) {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(snapshot));
}

export async function loadLocalDocument() {
  const candidates = await Promise.allSettled([
    Promise.resolve(readLocalStorage()),
    readIndexedDb(),
    readOpfs(),
  ]);

  const valid: LocalSnapshot[] = [];
  for (const candidate of candidates) {
    if (candidate.status === "fulfilled" && candidate.value && (await isValid(candidate.value))) {
      valid.push(candidate.value);
    }
  }

  valid.sort((a, b) => b.updatedAt - a.updatedAt);
  return valid[0]?.markdown ?? "";
}

export async function saveLocalDocument(markdown: string): Promise<StorageHealth> {
  const snapshot: LocalSnapshot = {
    markdown,
    updatedAt: Date.now(),
    checksum: await checksum(markdown),
    version: 1,
  };

  const writes = await Promise.allSettled([
    Promise.resolve().then(() => writeLocalStorage(snapshot)),
    writeIndexedDb(snapshot),
    writeOpfs(snapshot),
  ]);
  const labels = ["localStorage", "IndexedDB", "private file system"].filter(
    (_, index) => writes[index].status === "fulfilled",
  );
  const persistent = (await navigator.storage.persisted?.()) ?? false;
  return { copies: labels.length, labels, persistent };
}

export async function requestPersistentStorage() {
  try {
    return (await navigator.storage.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export async function inspectLocalStorage(): Promise<StorageHealth> {
  const reads = await Promise.allSettled([
    Promise.resolve(readLocalStorage()),
    readIndexedDb(),
    readOpfs(),
  ]);
  const names = ["localStorage", "IndexedDB", "private file system"];
  const labels: string[] = [];
  for (let index = 0; index < reads.length; index += 1) {
    const result = reads[index];
    if (result.status === "fulfilled" && (await isValid(result.value))) labels.push(names[index]);
  }
  const persistent = (await navigator.storage.persisted?.()) ?? false;
  return { copies: labels.length, labels, persistent };
}
