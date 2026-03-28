/**
 * workerPool.ts — Multi-User Worker Pool
 *
 * Singleton that manages one BotWorkerInstance per user wallet address.
 * Enforces:
 *   - Pool capacity (max 50 concurrent workers)
 *   - Subscription check before starting a worker
 *   - Clean start/stop/status API used by index.ts routes
 *
 * ── Redis key interaction ─────────────────────────────────────────────────────
 * Each worker uses the existing Redis namespace (`trade:{userKey}:*`, etc.)
 * No additional keys needed — all worker state is already per-userKey.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   import { workerPool } from "./workerPool.js";
 *
 *   // Start a user's bot:
 *   await workerPool.startUser({ userKey: "0xABC...", symbols: ["BTCUSDT"], userId: "uuid" });
 *
 *   // Stop a user's bot:
 *   workerPool.stopUser("0xABC...");
 *
 *   // List all running workers:
 *   workerPool.getStatus();
 */

import { BotWorkerInstance }              from "./botWorkerInstance.js";
import type { TriggerConfig, StrategyMode } from "./botWorkerInstance.js";
import { makeEngineDeps }       from "./deps.js";
import { checkSubscription }    from "../fees/feeEngine.js";
import { getUserById }          from "../users/userStore.js";
import { getRedis }             from "../cache/redis.js";
import { log }                  from "../../logger.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_WORKERS = 50;

// ── Types ─────────────────────────────────────────────────────────────────────

export type StartWorkerArgs = {
  /** On-chain wallet address used as userKey for all vault operations. */
  userKey:           string;
  /** Symbols to trade, e.g. ["BTCUSDT", "ETHUSDT"]. */
  symbols:           string[];
  /** Optional strategy tuning overrides. */
  trigger?:          TriggerConfig;
  /** Strategy mode — defaults to "trend_range_fork". */
  strategy?:         StrategyMode;
  /** Redis user ID (UUID from userStore) — used for subscription check. */
  userId?:           string;
  /** ISO timestamp of trial expiry from user record. */
  trialExpiresAt?:   string | null;
  /** If true, skip subscription check (used by admin-started workers). */
  skipSubCheck?:     boolean;
};

export type WorkerStatus = ReturnType<BotWorkerInstance["getStatus"]>;

// ── WorkerPool ────────────────────────────────────────────────────────────────

class WorkerPool {
  private readonly pool = new Map<string, BotWorkerInstance>();

  // ── startUser ───────────────────────────────────────────────────────────────

  async startUser(args: StartWorkerArgs): Promise<{
    ok:                   boolean;
    running?:             boolean;
    symbols?:             string[];
    dropped?:             string[];
    error?:               string;
    subscriptionRequired?: boolean;
  }> {
    const { userKey, symbols, trigger = {}, strategy = "trend_range_fork", userId, trialExpiresAt, skipSubCheck = false } = args;

    // ── Pool capacity guard ────────────────────────────────────────────────
    if (this.pool.size >= MAX_WORKERS && !this.pool.has(userKey)) {
      log.warn({ userKey, poolSize: this.pool.size }, "[workerPool] pool at capacity — refusing to start");
      return { ok: false, error: `Worker pool at capacity (max ${MAX_WORKERS} users)` };
    }

    // ── Subscription enforcement ───────────────────────────────────────────
    if (!skipSubCheck && userId) {
      try {
        const redis  = getRedis();
        const user   = await getUserById(redis, userId);
        const sub    = await checkSubscription(redis, userId, user?.trialExpiresAt ?? trialExpiresAt ?? null);

        if (!sub.active) {
          log.warn({ userKey, userId, status: sub.status }, "[workerPool] subscription inactive — worker not started");
          return {
            ok:                   false,
            error:                `Subscription required: subscription ${sub.status}`,
            subscriptionRequired: true,
          };
        }

        log.info({ userKey, userId, status: sub.status, daysLeft: sub.daysLeft }, "[workerPool] subscription check passed");
      } catch (e: any) {
        // Non-blocking: Redis/subscription errors should not prevent trading
        log.warn({ err: e?.message, userKey }, "[workerPool] subscription check error (non-blocking — allowing start)");
      }
    }

    // ── Create or reuse instance ───────────────────────────────────────────
    let instance = this.pool.get(userKey);

    if (!instance) {
      const deps = makeEngineDeps();
      instance   = new BotWorkerInstance(userKey, symbols, trigger, deps, strategy);
      this.pool.set(userKey, instance);
    } else if (instance.isRunning()) {
      // Already running — return current status without restarting
      log.debug({ userKey }, "[workerPool] worker already running — returning current status");
      return { ok: true, ...instance.getStatus() };
    }

    // ── Start the instance ─────────────────────────────────────────────────
    try {
      const result = await instance.start();
      log.info({ userKey, symbols: result.symbols }, "[workerPool] worker started successfully");
      return result;
    } catch (e: any) {
      // Clean up the dead instance so a retry creates a fresh one
      this.pool.delete(userKey);
      log.error({ err: e?.message, userKey }, "[workerPool] worker start failed — instance removed");
      return { ok: false, error: e?.message ?? String(e) };
    }
  }

  // ── stopUser ────────────────────────────────────────────────────────────────

  stopUser(userKey: string): { ok: boolean; running?: boolean; error?: string } {
    const instance = this.pool.get(userKey);
    if (!instance) {
      return { ok: false, error: `No worker found for ${userKey}` };
    }

    const result = instance.stop();
    this.pool.delete(userKey);
    log.info({ userKey }, "[workerPool] worker stopped and removed from pool");
    return result;
  }

  // ── stopAll ─────────────────────────────────────────────────────────────────

  stopAll(): { ok: boolean; stopped: number } {
    let stopped = 0;
    for (const [, instance] of this.pool) {
      instance.stop();
      stopped++;
    }
    this.pool.clear();
    log.info({ stopped }, "[workerPool] all workers stopped");
    return { ok: true, stopped };
  }

  // ── status ──────────────────────────────────────────────────────────────────

  /** Full status of all active workers. */
  getStatus(): WorkerStatus[] {
    return Array.from(this.pool.values()).map(w => w.getStatus());
  }

  /** Status of a single user's worker, or null if not in pool. */
  getUserStatus(userKey: string): WorkerStatus | null {
    return this.pool.get(userKey)?.getStatus() ?? null;
  }

  /** Returns true if the user's worker is running. */
  isRunning(userKey: string): boolean {
    return this.pool.get(userKey)?.isRunning() ?? false;
  }

  /** Direct access to an instance (advanced use). */
  getWorker(userKey: string): BotWorkerInstance | undefined {
    return this.pool.get(userKey);
  }

  /** Number of active workers. */
  get size(): number {
    return this.pool.size;
  }
}

// ── Singleton export ──────────────────────────────────────────────────────────

export const workerPool = new WorkerPool();
