import type { ImageContent } from "@pantoken/protocol";

export interface PendingPrompt {
  promptId: string;
  serverId: string;
  kind: "prompt" | "newSession";
  text: string;
  images?: readonly ImageContent[];
  deliverAs?: "steer" | "followUp";
  /** True when the prompt was sent while a turn was active (the daemon queues it
   *  via queueTurnInput). These prompts should NOT render as transcript bubbles —
   *  they show in the QueueTray instead, and join the transcript only when the
   *  daemon actually processes them (userMessage event). */
  midTurn?: boolean;
  sessionId?: string;
  newSession?: {
    cwd?: string;
    worktree?: boolean;
    model?: { provider: string; modelId: string };
    thinking?: string;
    facet?: string;
    permissionMonitor?: import("@pantoken/protocol").PermissionMonitorMode;
  };
  createdAt: string;
  state: "queued" | "sending" | "rejected";
  error?: string;
}

const DB_NAME = "pantoken-client";
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

/** The structured-clone boundary for the outbox. Callers routinely hand us a
 *  `PendingPrompt` read back out of Svelte `$state` (`store.pendingPrompts`), whose
 *  entries are deep reactive Proxies — and IndexedDB refuses to clone a proxy
 *  (`DataCloneError: The object can not be cloned`). A shallow `{...prompt}` at the
 *  call site does NOT help: the nested `images` / `newSession` survive as proxies.
 *  Rebuild every nested field as plain data here so all callers — including future
 *  ones — are safe regardless of how their argument was constructed. */
function toPlainPrompt(prompt: PendingPrompt): PendingPrompt {
  return {
    promptId: prompt.promptId,
    serverId: prompt.serverId,
    kind: prompt.kind,
    text: prompt.text,
    images: prompt.images?.map(({ type, data, mimeType }) => ({
      type,
      data,
      mimeType,
    })),
    deliverAs: prompt.deliverAs,
    sessionId: prompt.sessionId,
    newSession: prompt.newSession
      ? {
          cwd: prompt.newSession.cwd,
          worktree: prompt.newSession.worktree,
          model: prompt.newSession.model
            ? {
                provider: prompt.newSession.model.provider,
                modelId: prompt.newSession.model.modelId,
              }
            : undefined,
          thinking: prompt.newSession.thinking,
        }
      : undefined,
    createdAt: prompt.createdAt,
    state: prompt.state,
    error: prompt.error,
  };
}

export async function savePendingPrompt(prompt: PendingPrompt): Promise<void> {
  await transaction("readwrite", (store) => store.put(toPlainPrompt(prompt)));
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
