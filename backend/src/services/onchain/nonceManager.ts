/**
 * nonceManager.ts — Singleton Nonce Manager
 *
 * Prevents same-nonce collisions when two symbols fire executeTrade or
 * closePosition simultaneously (e.g. BTC + ETH stop-loss at the same second).
 *
 * ── Problem ──────────────────────────────────────────────────────────────────
 * Without this, two concurrent calls to signer.sendTransaction() both read
 * the same `pendingNonce` from the RPC, produce two txs with nonce=N, and
 * the second one is silently dropped (or reverts with "nonce too low").
 *
 * ── Solution ─────────────────────────────────────────────────────────────────
 * A single in-process lock serialises nonce allocation:
 *   1. Caller acquires lock (queued if another tx is in-flight)
 *   2. Gets next nonce (local counter if in sync, else fetches from chain)
 *   3. Increments counter BEFORE returning, so the next waiter gets N+1
 *   4. Releases lock → next waiter unblocks
 *
 * The lock is per-signer-address, so if you ever add multiple signers they
 * each have their own independent queue.
 *
 * ── Resync ───────────────────────────────────────────────────────────────────
 * If a tx is dropped (RPC timeout, revert before broadcast), the local nonce
 * counter may get ahead of the chain. `syncFromChain()` re-fetches the
 * pending nonce and resets the counter — call it on any "nonce too low" error.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   const nonce = await getNonce(signer);        // inside sendTransaction call
 *   await syncNonceFromChain(signer);            // after a dropped/failed tx
 */

import type { Wallet } from "ethers";
import { log } from "../../logger.js";

// ── Per-address state ─────────────────────────────────────────────────────────

type NonceState = {
  counter:   number;          // next nonce to use
  synced:    boolean;         // true once we've fetched from chain at least once
  lockQueue: Array<() => void>; // pending waiters
  locked:    boolean;
};

const _state = new Map<string, NonceState>();

function getState(address: string): NonceState {
  const key = address.toLowerCase();
  if (!_state.has(key)) {
    _state.set(key, { counter: 0, synced: false, lockQueue: [], locked: false });
  }
  return _state.get(key)!;
}

// ── Lock helpers ─────────────────────────────────────────────────────────────

function acquireLock(state: NonceState): Promise<void> {
  if (!state.locked) {
    state.locked = true;
    return Promise.resolve();
  }
  return new Promise((resolve) => state.lockQueue.push(resolve));
}

function releaseLock(state: NonceState): void {
  if (state.lockQueue.length > 0) {
    const next = state.lockQueue.shift()!;
    next(); // next waiter takes the lock immediately
  } else {
    state.locked = false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get the next nonce for `signer`, serialised through a lock so concurrent
 * callers each receive a unique, incrementing nonce.
 *
 * On first call (or after syncNonceFromChain), fetches `eth_getTransactionCount`
 * with "pending" tag to account for in-mempool txs.
 */
export async function getNonce(signer: Wallet): Promise<number> {
  const address = signer.address;
  const state   = getState(address);

  await acquireLock(state);
  try {
    if (!state.synced) {
      const pending = await signer.getNonce("pending");
      state.counter = pending;
      state.synced  = true;
      log.debug({ address, nonce: pending }, "[nonceManager] synced from chain");
    }

    const nonce = state.counter;
    state.counter += 1;
    log.debug({ address, nonce, next: state.counter }, "[nonceManager] allocated nonce");
    return nonce;
  } finally {
    releaseLock(state);
  }
}

/**
 * Force-resync the nonce counter from the chain.
 * Call this after a tx is dropped, reverted before broadcast, or on any
 * "nonce too low" / "replacement transaction underpriced" error.
 *
 * Acquires the lock so in-flight allocations are not interrupted.
 */
export async function syncNonceFromChain(signer: Wallet): Promise<void> {
  const address = signer.address;
  const state   = getState(address);

  await acquireLock(state);
  try {
    const pending = await signer.getNonce("pending");
    const old     = state.counter;
    state.counter = pending;
    state.synced  = true;
    log.info({ address, old, synced: pending }, "[nonceManager] resynced from chain");
  } catch (e: any) {
    log.warn({ address, err: e?.message }, "[nonceManager] syncFromChain failed");
  } finally {
    releaseLock(state);
  }
}

/**
 * Reset the nonce state for a signer (e.g. on bot restart or test teardown).
 * Next call to getNonce() will fetch from chain again.
 */
export function resetNonceState(signer: Wallet): void {
  const key = signer.address.toLowerCase();
  _state.delete(key);
  log.debug({ address: signer.address }, "[nonceManager] state reset");
}
