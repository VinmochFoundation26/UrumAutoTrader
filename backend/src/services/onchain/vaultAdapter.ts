import { Contract, keccak256, toUtf8Bytes } from "ethers";
import type { JsonRpcProvider, Signer, TransactionResponse, Wallet } from "ethers";
import type { Redis } from "ioredis";
import { ERC20_ABI, getFallbackProvider, getProvider } from "./contractInstance.js";
import { getNonce, syncNonceFromChain } from "./nonceManager.js";
import { getEip1559Params } from "./gasOracle.js";
import { recordPendingTx, clearPendingTx } from "./txTracker.js";
import { log } from "../../logger.js";

/**
 * waitWithFallback — awaits a transaction receipt using the primary provider.
 * If the primary provider throws a connectivity error (e.g. "connection refused",
 * "could not coalesce", "ECONNREFUSED"), automatically retries receipt polling
 * on the fallback provider using the known tx hash.
 *
 * This prevents the common failure mode where arb1.arbitrum.io routes a receipt
 * poll to a dead internal node (e.g. 10.25.x.x:8547) after a tx was already broadcast.
 */
const FALLBACK_ERROR_PATTERNS = [
  "connection refused",
  "could not coalesce",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "network error",
  "timeout",
  "missing response",
  "bad response",
];

function isNetworkError(err: any): boolean {
  const msg = String(err?.message ?? err ?? "").toLowerCase();
  return FALLBACK_ERROR_PATTERNS.some(p => msg.includes(p.toLowerCase()));
}

// ── TX Acceleration ───────────────────────────────────────────────────────────
//
// On Arbitrum, TXs normally confirm within 1-2 seconds via the sequencer.
// A TX that hasn't landed in STUCK_TX_MS is almost certainly an RPC issue or
// a rare sequencer hiccup — not a gas problem. We:
//   1. Attempt receipt via the fallback RPC first (covers most RPC dead-node cases)
//   2. If still no receipt after STUCK_TX_MS, resend with same nonce + GAS_BUMP_FACTOR
//      to replace the original TX in the sequencer's queue.
// The replacement TX is returned and awaited. If BOTH somehow confirm, the second
// fails with "position already open" — a known handled revert that is already
// classified as "abort" and does not open a ghost trade.
//
const STUCK_TX_MS      = 20_000;    // 20 seconds — very generous for Arbitrum
const GAS_BUMP_FACTOR  = 1.15;      // 15% gas bump for replacement TX

/**
 * Wait for a transaction receipt using the primary provider.
 * On RPC connectivity errors: retries on the fallback provider.
 * On stuck TX (no receipt in STUCK_TX_MS): calls `onStuck()` to get a
 * replacement TX (same nonce, bumped gas), then waits for that receipt.
 *
 * @param tx        The broadcast TransactionResponse to wait for.
 * @param retries   RPC retry count (default 3).
 * @param onStuck   Optional callback that resends with bumped gas; returns the
 *                  replacement TransactionResponse (or null to give up).
 */
async function waitWithFallback(
  tx:       TransactionResponse,
  retries:  number = 3,
  onStuck?: () => Promise<TransactionResponse | null>,
): Promise<any> {
  // ── Phase 1: race tx.wait() against a stuck-TX timeout ──────────────────
  if (onStuck) {
    const TIMEOUT_SENTINEL = Symbol("timeout");
    const result = await Promise.race([
      tx.wait().then(r => r),
      new Promise<typeof TIMEOUT_SENTINEL>(resolve =>
        setTimeout(() => resolve(TIMEOUT_SENTINEL), STUCK_TX_MS)
      ),
    ]).catch(err => { throw err; }); // surface tx.wait() errors immediately

    if (result !== TIMEOUT_SENTINEL) {
      // TX confirmed normally — validate status
      const receipt = result as any;
      if (receipt?.status === 0) throw new Error(`tx ${tx.hash} reverted on-chain (status=0)`);
      return receipt;
    }

    // ── TX appears stuck ─────────────────────────────────────────────────
    log.warn(
      { txHash: tx.hash, stuckAfterMs: STUCK_TX_MS },
      "[vaultAdapter] TX stuck — attempting replacement with bumped gas",
    );

    // Try the fallback RPC first (covers most "stuck on dead node" cases)
    const fallback = getFallbackProvider();
    if (fallback) {
      const receipt = await fallback.getTransactionReceipt(tx.hash).catch(() => null);
      if (receipt) {
        if (receipt.status === 0) throw new Error(`tx ${tx.hash} reverted on-chain (status=0)`);
        log.info({ txHash: tx.hash }, "[vaultAdapter] TX found confirmed on fallback RPC after stuck timeout");
        return receipt;
      }
    }

    // Fallback RPC also has no receipt — trigger gas-bump replacement TX
    const replaceTx = await onStuck().catch(e => {
      log.warn({ err: e?.message }, "[vaultAdapter] gas-bump respawn failed");
      return null;
    });

    if (replaceTx) {
      log.info({ origHash: tx.hash, replaceHash: replaceTx.hash },
        "[vaultAdapter] replacement TX sent — waiting for confirmation");
      // Fall through to retried wait on the replacement TX
      return waitWithFallback(replaceTx, retries); // no onStuck: don't recurse infinitely
    }
    // If respawn failed, fall through to the standard retry loop below
  }

  // ── Phase 2: standard retry loop (no timeout guard, used on replacement TXs) ──
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // First attempt: use primary provider via tx.wait()
      if (attempt === 1) {
        const receipt = await tx.wait();
        if ((receipt as any)?.status === 0)
          throw new Error(`tx ${tx.hash} reverted on-chain (status=0)`);
        return receipt;
      }

      // Subsequent attempts: poll fallback provider directly by tx hash
      const fallback = getFallbackProvider();
      if (!fallback) {
        log.warn({ txHash: tx.hash }, "[vaultAdapter] no fallback provider — retrying primary");
        return await tx.wait();
      }
      log.warn({ txHash: tx.hash, attempt }, "[vaultAdapter] retrying receipt on fallback provider");
      // Poll until mined (up to 90s, checking every 3s)
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const receipt = await fallback.getTransactionReceipt(tx.hash);
        if (receipt) {
          // Guard: status=0 means on-chain revert — throw so caller treats it as failure
          // Without this check, a reverted tx would silently register as a successful trade
          if (receipt.status === 0) {
            throw new Error(`tx ${tx.hash} reverted on-chain (status=0)`);
          }
          return receipt;
        }
        await new Promise(r => setTimeout(r, 3_000));
      }
      throw new Error(`tx ${tx.hash} not mined within 90s on fallback provider`);
    } catch (err: any) {
      if (attempt === retries) throw err;        // exhausted all retries
      if (!isNetworkError(err)) throw err;       // non-network error — propagate immediately
      log.warn({ txHash: tx.hash, attempt, err: err?.message },
        "[vaultAdapter] RPC connectivity error — retrying with fallback");
      await new Promise(r => setTimeout(r, 1_000 * attempt)); // brief backoff
    }
  }
}
import type { Wad } from "./wad.js";

// ── Revert reason classifier ──────────────────────────────────────────────────
//
// Maps known error message patterns to one of three actions the caller should take:
//   "retry"    — transient issue (nonce, RPC hiccup) — re-attempt after resync
//   "abort"    — permanent for this tick (contract logic) — skip this trade
//   "cooldown" — vault cooldown active — wait and do not retry until it expires
//
// Pattern matching is case-insensitive and substring-based.

const REVERT_MAP: Array<[string, RevertAction]> = [
  // Vault-specific reverts
  ["cooldown",                    "cooldown"],
  ["position already open",       "abort"],
  ["max open positions",          "abort"],
  ["market not enabled",          "abort"],
  ["market disabled",             "abort"],
  ["paused",                      "abort"],
  ["insufficient collateral",     "abort"],
  ["insufficient balance",        "abort"],
  ["not enough",                  "abort"],
  ["no open position",            "abort"],
  ["position not open",           "abort"],
  // EVM / ethers nonce errors
  ["nonce too low",               "retry"],
  ["replacement transaction",     "retry"],
  ["already known",               "retry"],
  ["transaction underpriced",     "retry"],
  // status=0 catch-all (shouldn't reach here — waitWithFallback throws on status=0)
  ["status=0",                    "abort"],
  ["reverted on-chain",           "abort"],
];

export type RevertAction = "retry" | "abort" | "cooldown";

/**
 * Classify an on-chain (or pre-flight) error into a RevertAction.
 * Unknown errors default to "retry" (conservative — don't silently discard).
 */
export function classifyRevert(err: any): RevertAction {
  const msg = String(err?.message ?? err ?? "").toLowerCase();
  for (const [pattern, action] of REVERT_MAP) {
    if (msg.includes(pattern.toLowerCase())) return action;
  }
  return "retry";
}

/** Convert a symbol string (e.g. "ETHUSDT") to the bytes32 marketId used by the vault. */
export function symbolToMarketId(symbol: string): string {
  return keccak256(toUtf8Bytes(symbol));
}

/**
 * Returns the user's vault USDC balance already in x18 (wad) format.
 * V2 is USDC-only — no ETH balance.
 */
export async function getUserBalancesWad(vault: Contract, user: string, _stableDecimals: number) {
  // stableBalanceX18 already returns an x18 value — no scaling needed.
  const stableX18 = (await (vault as any).stableBalanceX18(user)) as bigint;
  return { stableWad: stableX18 as Wad };
}

export async function executeTradeVaultV2(
  vault: Contract,
  signer: Signer | null,
  args: {
    user: string;
    marketId: string;
    isLong: boolean;
    sizeX18: Wad;
    entryPriceX18: Wad;
    collateralRaw: bigint;
  },
  opts?: { redis?: Redis; symbol?: string },
) {
  const c = signer ? vault.connect(signer) : vault;
  const { user, marketId, isLong, sizeX18, entryPriceX18, collateralRaw } = args;

  // ── Nonce + Gas overrides ────────────────────────────────────────────────
  // Allocate a unique nonce through the serialised lock — prevents same-nonce
  // collisions when two symbols fire executeTrade in the same scan tick.
  // Compute EIP-1559 gas params (cached 3s) for safe inclusion on Arbitrum.
  const wallet = signer as Wallet;
  const [nonce, gasParams] = await Promise.all([
    wallet ? getNonce(wallet) : Promise.resolve(undefined),
    getEip1559Params(getProvider()),
  ]);

  const overrides: Record<string, any> = { ...gasParams };
  if (nonce !== undefined) overrides.nonce = nonce;

  try {
    const tx: TransactionResponse = await (c as any).executeTrade(
      user, marketId, isLong, sizeX18, entryPriceX18, collateralRaw,
      overrides,
    );

    // ── Record pending tx immediately after broadcast ────────────────────
    // If the bot crashes during waitWithFallback, startup reconcilePendingTxs()
    // will find this key and resolve it against the chain on next restart.
    if (opts?.redis) {
      await recordPendingTx(opts.redis, {
        txHash:    tx.hash,
        symbol:    opts.symbol ?? "unknown",
        userKey:   user,
        action:    "executeTrade",
        timestamp: Date.now(),
      });
    }

    // ── TX Acceleration: if TX is stuck for > STUCK_TX_MS, resend with bumped gas ──
    // Uses the same nonce so the replacement replaces the original in the sequencer.
    const onStuck = wallet ? async (): Promise<TransactionResponse | null> => {
      try {
        const bumpedGas = {
          maxFeePerGas:         BigInt(Math.ceil(Number(gasParams.maxFeePerGas)         * GAS_BUMP_FACTOR)),
          maxPriorityFeePerGas: BigInt(Math.ceil(Number(gasParams.maxPriorityFeePerGas) * GAS_BUMP_FACTOR)),
          nonce: overrides.nonce, // same nonce — replaces stuck TX
        };
        log.warn(
          { symbol: opts?.symbol, nonce: overrides.nonce,
            maxFeeGwei: (Number(bumpedGas.maxFeePerGas) / 1e9).toFixed(4) },
          "[vaultAdapter] executeTrade: sending gas-bump replacement TX",
        );
        const replaceTx: TransactionResponse = await (c as any).executeTrade(
          user, marketId, isLong, sizeX18, entryPriceX18, collateralRaw, bumpedGas,
        );
        if (opts?.redis) {
          await recordPendingTx(opts.redis, {
            txHash: replaceTx.hash, symbol: opts.symbol ?? "unknown",
            userKey: user, action: "executeTrade", timestamp: Date.now(),
          });
        }
        return replaceTx;
      } catch (e: any) {
        log.warn({ err: e?.message }, "[vaultAdapter] executeTrade gas-bump failed");
        return null;
      }
    } : undefined;

    // ethers v6: receipt.hash (not receipt.transactionHash)
    const receipt = await waitWithFallback(tx, 3, onStuck);

    // Clear the pending record now that we have a confirmed receipt
    if (opts?.redis) {
      await clearPendingTx(opts.redis, tx.hash);
    }

    return { txHash: receipt.hash, receipt };
  } catch (err: any) {
    // On nonce collision — resync from chain so next attempt gets a fresh nonce
    if (wallet && classifyRevert(err) === "retry") {
      await syncNonceFromChain(wallet).catch(() => {/* non-critical */});
    }
    throw err;
  }
}

export async function closePositionVaultV2(
  vault: Contract,
  signer: Signer | null,
  args: { user: string; marketId: string; exitPriceX18: Wad },
  opts?: { redis?: Redis; symbol?: string },
) {
  const c = signer ? vault.connect(signer) : vault;
  const { user, marketId, exitPriceX18 } = args;

  const wallet = signer as Wallet;
  const [nonce, gasParams] = await Promise.all([
    wallet ? getNonce(wallet) : Promise.resolve(undefined),
    getEip1559Params(getProvider()),
  ]);

  const overrides: Record<string, any> = { ...gasParams };
  if (nonce !== undefined) overrides.nonce = nonce;

  try {
    const tx: TransactionResponse = await (c as any).closePosition(user, marketId, exitPriceX18, overrides);

    if (opts?.redis) {
      await recordPendingTx(opts.redis, {
        txHash:    tx.hash,
        symbol:    opts.symbol ?? "unknown",
        userKey:   user,
        action:    "closePosition",
        timestamp: Date.now(),
      });
    }

    const closeOnStuck = wallet ? async (): Promise<TransactionResponse | null> => {
      try {
        const bumpedGas = {
          maxFeePerGas:         BigInt(Math.ceil(Number(gasParams.maxFeePerGas)         * GAS_BUMP_FACTOR)),
          maxPriorityFeePerGas: BigInt(Math.ceil(Number(gasParams.maxPriorityFeePerGas) * GAS_BUMP_FACTOR)),
          nonce: overrides.nonce,
        };
        log.warn(
          { symbol: opts?.symbol, nonce: overrides.nonce,
            maxFeeGwei: (Number(bumpedGas.maxFeePerGas) / 1e9).toFixed(4) },
          "[vaultAdapter] closePosition: sending gas-bump replacement TX",
        );
        const replaceTx: TransactionResponse = await (c as any).closePosition(
          user, marketId, exitPriceX18, bumpedGas,
        );
        if (opts?.redis) {
          await recordPendingTx(opts.redis, {
            txHash: replaceTx.hash, symbol: opts.symbol ?? "unknown",
            userKey: user, action: "closePosition", timestamp: Date.now(),
          });
        }
        return replaceTx;
      } catch (e: any) {
        log.warn({ err: e?.message }, "[vaultAdapter] closePosition gas-bump failed");
        return null;
      }
    } : undefined;

    const receipt = await waitWithFallback(tx, 3, closeOnStuck);

    if (opts?.redis) {
      await clearPendingTx(opts.redis, tx.hash);
    }

    return { txHash: receipt.hash, receipt };
  } catch (err: any) {
    if (wallet && classifyRevert(err) === "retry") {
      await syncNonceFromChain(wallet).catch(() => {/* non-critical */});
    }
    throw err;
  }
}

/**
 * Approve the vault to spend `amountRaw` of the stable token, then call depositStable().
 * amountRaw is in native token decimals (6 for USDC: 100 USDC = 100_000_000n).
 * Deposit fee (depositFeeBps) is taken by the vault — net credited = amountRaw × (10000 - fee) / 10000.
 */
export async function depositStableToVault(
  vault: Contract,
  signer: Signer,
  stableAddr: string,
  vaultAddr: string,
  amountRaw: bigint
) {
  const stable = new Contract(stableAddr, ERC20_ABI, signer);
  // 1. Approve vault to spend tokens
  const approveTx = await (stable as any).approve(vaultAddr, amountRaw);
  await waitWithFallback(approveTx);
  // 2. Deposit into vault
  const vaultConnected = vault.connect(signer);
  const depositTx = await (vaultConnected as any).depositStable(amountRaw);
  const receipt = await waitWithFallback(depositTx);
  return { txHash: receipt.hash, receipt };
}

/**
 * Normal two-step withdrawal (bot acts as both user + WITHDRAW_APPROVER_ROLE).
 *
 * Step 1: initiateWithdrawStable(amountRaw) — user locks withdrawal intent.
 * Step 2: approveWithdrawStable(user, amountRaw) — approver releases funds minus withdrawFeeBps.
 *
 * amountRaw is in native token decimals (6 for USDC: 100 USDC = 100_000_000n).
 * Net received = amountRaw × (10000 − withdrawFeeBps) / 10000  (e.g. 10% fee → 90% received).
 */
export async function withdrawStableFromVault(
  vault: Contract,
  signer: Signer,
  userAddress: string,
  amountRaw: bigint
) {
  const c = vault.connect(signer);
  // Step 1 — initiate
  const initTx = await (c as any).initiateWithdrawStable(amountRaw);
  const initReceipt = await waitWithFallback(initTx);
  // Step 2 — approve (bot is WITHDRAW_APPROVER_ROLE — completes immediately)
  const approveTx = await (c as any).approveWithdrawStable(userAddress, amountRaw);
  const approveReceipt = await waitWithFallback(approveTx);
  return { initTxHash: initReceipt.hash, txHash: approveReceipt.hash, receipt: approveReceipt };
}

/**
 * Emergency withdrawal — bypasses approval, costs emergencyFeeBps (15%).
 *
 * amountGrossRaw is in native token decimals (6 for USDC).
 * Net received = amountGrossRaw × (10000 − emergencyFeeBps) / 10000.
 */
export async function emergencyWithdrawFromVault(
  vault: Contract,
  signer: Signer,
  amountGrossRaw: bigint
) {
  const c = vault.connect(signer);
  const tx = await (c as any).emergencyWithdrawStable(amountGrossRaw);
  const receipt = await waitWithFallback(tx);
  return { txHash: receipt.hash, receipt };
}

/**
 * Returns the signer/wallet's stable token balance in raw units and formatted.
 * decimals is typically 6 for USDC.
 */
export async function getWalletStableBalance(
  provider: JsonRpcProvider,
  stableAddr: string,
  walletAddr: string,
  decimals: number = 6
) {
  const stable = new Contract(stableAddr, ERC20_ABI, provider);
  const raw = (await (stable as any).balanceOf(walletAddr)) as bigint;
  const formatted = Number(raw) / 10 ** decimals;
  return { raw: raw.toString(), formatted: +formatted.toFixed(2), decimals };
}
