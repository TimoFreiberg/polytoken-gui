import type { ImageContent } from "@pilot/protocol";

export interface PendingPrompt {
  promptId: string;
  serverId: string;
  kind: "prompt" | "newSession";
  text: string;
  images?: readonly ImageContent[];
  deliverAs?: "steer" | "followUp";
  sessionId?: string;
  newSession?: {
    cwd?: string;
    worktree?: boolean;
    model?: { provider: string; modelId: string };
    thinking?: string;
  };
  createdAt: string;
  state: "queued" | "sending" | "rejected";
  error?: string;
}

const DB_NAME = "pilot-client";
const STORE_NAME = "prompt-outbox";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME))
        db.createObjectStore(STORE_NAME, { keyPath: "promptId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open the prompt outbox"));
  });
  return dbPromise;
}

function transaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const request = run(tx.objectStore(STORE_NAME));
        let result!: T;
        request.onsuccess = () => {
          result = request.result;
        };
        request.onerror = () =>
          reject(request.error ?? new Error("Prompt outbox operation failed"));
        tx.oncomplete = () => resolve(result);
        tx.onabort = () =>
          reject(tx.error ?? new Error("Prompt outbox transaction aborted"));
      }),
  );
}

export async function savePendingPrompt(prompt: PendingPrompt): Promise<void> {
  await transaction("readwrite", (store) => store.put(prompt));
}

export async function deletePendingPrompt(promptId: string): Promise<void> {
  await transaction("readwrite", (store) => store.delete(promptId));
}

export async function loadPendingPrompts(
  serverId: string,
): Promise<PendingPrompt[]> {
  const all = await transaction<PendingPrompt[]>("readonly", (store) =>
    store.getAll(),
  );
  return all
    .filter((prompt) => prompt.serverId === serverId)
    .map((prompt) => ({
      ...prompt,
      // A page/socket can disappear after send but before ACK. Resend on the next
      // authenticated connection; the server deduplicates by promptId.
      state: prompt.state === "sending" ? "queued" : prompt.state,
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
