// Web Push fan-out: lets the server buzz a *closed* phone (or any installed PWA)
// via the Web Push protocol — the piece tab-open Notifications can't do. Keeps a
// file-backed subscription store + a persistent VAPID keypair under config.dataDir
// so subscriptions survive a server restart (a closed phone subscribes once).
//
// Split into PushSubscriptionStore (the file-backed sub set — add/remove/count/
// persist + prune-dead, injectable file path so it's unit-testable like ArchiveStore
// / WorktreeStore) and PushService (the VAPID-bound wrapper that owns a store +
// sendToAll). The store is the regression-prone state logic; PushService stays the
// thin VAPID/crypto + web-push-lib shell.
//
// iOS caveat (the spike's real risk): Web Push only works for a PWA the user has
// installed to the home screen, on iOS 16.4+. The library crypto path is validated
// under Bun; on-device delivery is validated on the owner's actual iPhone.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import webpush, { type PushSubscription } from "web-push";
import { config } from "./config.js";

export interface PushNotification {
  title: string;
  body: string;
  tag?: string;
  url?: string;
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/**
 * File-backed subscription store: the set of push endpoints pilot will fan out to.
 * Extracted from PushService so the add/remove/count/persist/prune logic is unit-
 * testable without VAPID keypair generation or the global web-push lib — same
 * tmpdir-injectable ctor pattern as ArchiveStore / WorktreeStore (file path param).
 * The store is keyed by endpoint (so re-subscribing a device is a no-op), and the
 * payload-shape sendToAll needs (the `endpoint` to identify dead ones) lives on
 * the subscription itself.
 */
export class PushSubscriptionStore {
  private subs = new Map<string, PushSubscription>();

  constructor(
    private readonly file: string = join(
      config.dataDir,
      "push-subscriptions.json",
    ),
  ) {
    mkdirSync(dirname(file), { recursive: true });
    this.load();
  }

  get count(): number {
    return this.subs.size;
  }

  /** All subscriptions (for fan-out). */
  values(): PushSubscription[] {
    return [...this.subs.values()];
  }

  /** Idempotent — keyed by endpoint, so re-subscribing the same device is a no-op. */
  add(sub: PushSubscription): void {
    this.subs.set(sub.endpoint, sub);
    this.persist();
    console.log(`[push] subscription added (${this.subs.size} total)`);
  }

  /** Drop a subscription by endpoint. No-op (no persist) if it wasn't present. */
  remove(endpoint: string): void {
    if (this.subs.delete(endpoint)) this.persist();
  }

  /** Drop a set of endpoints at once (the dead ones from a sendToAll sweep) and
   *  persist once. No-op if the list is empty. */
  prune(dead: string[]): void {
    if (dead.length === 0) return;
    for (const ep of dead) this.subs.delete(ep);
    this.persist();
    console.log(`[push] pruned ${dead.length} dead subscription(s)`);
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const arr = JSON.parse(
        readFileSync(this.file, "utf8"),
      ) as PushSubscription[];
      for (const s of arr) this.subs.set(s.endpoint, s);
      if (arr.length)
        console.log(`[push] loaded ${arr.length} subscription(s)`);
    } catch (e) {
      console.error("[push] failed to load subscriptions", e);
    }
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify([...this.subs.values()], null, 2));
  }
}

export class PushService {
  private readonly store: PushSubscriptionStore;
  private readonly vapid: VapidKeys;

  constructor() {
    mkdirSync(config.dataDir, { recursive: true });
    this.vapid = loadOrCreateVapid(join(config.dataDir, "vapid.json"));
    this.store = new PushSubscriptionStore(
      join(config.dataDir, "push-subscriptions.json"),
    );
    webpush.setVapidDetails(
      config.vapidSubject,
      this.vapid.publicKey,
      this.vapid.privateKey,
    );
    // Apple rejects placeholder subjects with 403 BadJwtToken — warn loudly rather
    // than fail silently on the first real send.
    if (/localhost|example\.com/.test(config.vapidSubject))
      console.warn(
        `[push] VAPID subject is a placeholder (${config.vapidSubject}). iOS push will fail with BadJwtToken — set PILOT_VAPID_SUBJECT to your real https: host or mailto:.`,
      );
  }

  get publicKey(): string {
    return this.vapid.publicKey;
  }
  get count(): number {
    return this.store.count;
  }

  /** Idempotent — keyed by endpoint, so re-subscribing the same device is a no-op. */
  add(sub: PushSubscription): void {
    this.store.add(sub);
  }

  remove(endpoint: string): void {
    this.store.remove(endpoint);
  }

  /** Send to every stored subscription; prune the ones the push service reports gone. */
  async sendToAll(n: PushNotification): Promise<number> {
    const subs = this.store.values();
    if (subs.length === 0) return 0;
    const payload = JSON.stringify(n);
    const dead: string[] = [];
    let sent = 0;
    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(sub, payload);
          sent++;
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          // 404/410 = subscription expired or was revoked -> drop it.
          if (code === 404 || code === 410) dead.push(sub.endpoint);
          else
            console.error(
              `[push] send failed (${code ?? "?"})`,
              (e as { body?: string }).body ?? String(e),
            );
        }
      }),
    );
    this.store.prune(dead);
    return sent;
  }
}

function loadOrCreateVapid(path: string): VapidKeys {
  if (existsSync(path))
    return JSON.parse(readFileSync(path, "utf8")) as VapidKeys;
  const keys = webpush.generateVAPIDKeys();
  writeFileSync(path, JSON.stringify(keys, null, 2));
  console.log(`[push] generated a new VAPID keypair at ${path}`);
  return keys;
}
