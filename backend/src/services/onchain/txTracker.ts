/**
 * txTracker.ts — Transaction Lifecycle Tracker
 *
 * Tracks every on-chain transaction from broadcast to confirmation in Redis.
 * On startup (or restart after a crash), the reconciler checks all pending
 * txs against the chain — permanently eliminating ghost trades from crashes.
 *
 * ── Redis key schema ─────────────────────────────────────────────────────────
 *   pendingTx:{txHash}  → JSON TxRecord, TTL = 600s
 *
 * The 600s TTL is a safety net: if the bot crashes while a tx is in-flight
 * and never restarts, the key auto-expires. A tx taking > 10 min to confirm
 * on Arbitrum indicates a serious RPC issue — logging and alerting should
 * catch this first.
 *
 * ── Startup reconciliation ───────────────────────────────────────────────────
 * `reconcilePendingTxs()` is called once at bot startup:
 *   1. Scans all `pendingTx:*` keys
 *   2. For each, calls `provider.getTransactionReceipt(txHash)`
 *   3. Confirmed (status=1)   → clears Redis key, logs "confirmed"
 *   4. Reverted (status=0)    → clears Redis key, logs "reverted" (ghost prevented)
 *   5. Not found (null)       → logs "still pending" (bot may have crashed mid-broadcast)
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   // Before broadcasting:
 *   await recordPendingTx(redis, txHash, { symbol, userKey, action: "executeTrade" });
 *
 *   // After confirmed:
 *   await clearPendingTx(redis, txHash);
 *
 *   // On startup:
 *   await reconcilePendingTxs(redis, provider);
 */

import type { Redis }            from "ioredis";
import type { JsonRpcProvider }  from "ethers";
import { log }                   from "../../logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type TxAction = "executeTrade" | "closePosition" | "depositStable" | "withdrawStable";

export type TxRecord = {
  txHash:    string;
  symbol:    string;
  userKey:   string;
  action:    TxAction;
  timestamp: number;   // ms since epoch
};

// ── Constants ─────────────────────────────────────────────────────────────────

const TTL_SECONDS = 600;   // 10 min: auto-expire if bot never restarts

function pendingKey(txHash: string): string {
  return `pendingTx:${txHash.toLowerCase()}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Record a transaction as pending in Redis.
 * Call this BEFORE (or immediately after) calling signer.sendTransaction().
 * Using the txHash as the key means we can look it up on-chain during reconciliation.
 */
export async function recordPendingTx(
  redis:  Redis,
  record: TxRecord,
): Promise<void> {
  try {
    const key   = pendingKey(record.txHash);
    await redis.set(key, JSON.stringify(record), "EX", TTL_SECONDS);
    log.debug({ txHash: record.txHash, action: record.action, symbol: record.symbol },
      "[txTracker] pending tx recorded");
  } catch (e: any) {
    log.warn({ err: e?.message, txHash: record.txHash }, "[txTracker] recordPendingTx failed");
  }
}

/**
 * Clear a pending tx record once it has been confirmed (or definitively failed).
 * Call this after receipt.status === 1 (confirmed success).
 */
export async function clearPendingTx(redis: Redis, txHash: string): Promise<void> {
  try {
    await redis.del(pendingKey(txHash));
    log.debug({ txHash }, "[txTracker] pending tx cleared");
  } catch (e: any) {
    log.warn({ err: e?.message, txHash }, "[txTracker] clearPendingTx failed");
  }
}

/**
 * Get all currently tracked pending transactions.
 * Used by the admin dashboard / health endpoint.
 */
export async function getPendingTxs(redis: Redis): Promise<TxRecord[]> {
  try {
    const records: TxRecord[] = [];
    let cursor = "0";
    do {
      const [nextCursor, keys] = await redis.scan(cursor, "MATCH", "pendingTx:*", "COUNT", 100);
      cursor = nextCursor;
      for (const key of keys) {
        const raw = await redis.get(key);
        if (raw) {
          try { records.push(JSON.parse(raw) as TxRecord); } catch { /* skip malformed */ }
        }
      }
    } while (cursor !== "0");
    return records;
  } catch (e: any) {
    log.warn({ err: e?.message }, "[txTracker] getPendingTxs failed");
    return [];
  }
}

/**
 * Startup reconciler — run once when the bot starts.
 *
 * Resolves any transactions that were in-flight when the bot last crashed or
 * restarted. For each pending tx:
 *   - status 1 (confirmed) → log success, clear key
 *   - status 0 (reverted)  → log revert, clear key  [ghost trade prevented]
 *   - null (not found yet) → tx may still be in-flight or was dropped by mempool
 *
 * Note: this function does NOT register or unregister activeTrades —
 * that is handled by runner.recoverOpenPositions() which reads on-chain state.
 * txTracker only ensures the Redis pendingTx keys are consistent.
 */
export async function reconcilePendingTxs(
  redis:    Redis,
  provider: JsonRpcProvider,
): Promise<void> {
  log.info("[txTracker] reconciling pending transactions...");

  const pending = await getPendingTxs(redis);
  if (pending.length === 0) {
    log.info("[txTracker] no pending transactions to reconcile");
    return;
  }

  log.info({ count: pending.length }, "[txTracker] found pending transactions");

  for (const record of pending) {
    try {
      const receipt = await provider.getTransactionReceipt(record.txHash);

      if (receipt === null) {
        // TX not found on-chain — could still be in mempool, or dropped
        const ageSeconds = Math.round((Date.now() - record.timestamp) / 1000);
        log.warn(
          { txHash: record.txHash, action: record.action, symbol: record.symbol, ageSeconds },
          "[txTracker] reconcile: tx not found on-chain (still pending or dropped)",
        );
        // Leave in Redis — TTL will eventually expire it
        continue;
      }

      if (receipt.status === 1) {
        log.info(
          { txHash: record.txHash, action: record.action, symbol: record.symbol,
            blockNumber: receipt.blockNumber },
          "[txTracker] reconcile: tx confirmed ✓",
        );
        await clearPendingTx(redis, record.txHash);
        continue;
      }

      if (receipt.status === 0) {
        log.warn(
          { txHash: record.txHash, action: record.action, symbol: record.symbol,
            blockNumber: receipt.blockNumber },
          "[txTracker] reconcile: tx REVERTED on-chain — ghost trade prevented",
        );
        await clearPendingTx(redis, record.txHash);
        continue;
      }

      // Unknown status (shouldn't happen with modern ethers)
      log.warn({ txHash: record.txHash, status: receipt.status }, "[txTracker] reconcile: unexpected receipt status");
      await clearPendingTx(redis, record.txHash);
    } catch (e: any) {
      log.warn({ err: e?.message, txHash: record.txHash }, "[txTracker] reconcile: error checking tx");
    }
  }

  log.info("[txTracker] reconciliation complete");
}
