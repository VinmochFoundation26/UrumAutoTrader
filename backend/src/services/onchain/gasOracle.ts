/**
 * gasOracle.ts — EIP-1559 Dynamic Gas Oracle
 *
 * Reads the latest block's baseFeePerGas and computes safe EIP-1559 gas
 * parameters for Arbitrum One.
 *
 * ── Why dynamic gas matters ──────────────────────────────────────────────────
 * Hardcoded `gasPrice` or `maxFeePerGas` fails in two ways:
 *   - Too low  → tx stuck in mempool, position not opened/closed on time
 *   - Too high → unnecessary fee burn (minor on Arbitrum but still wasteful)
 *
 * ── Arbitrum L2 gas characteristics ─────────────────────────────────────────
 * Arbitrum uses EIP-1559 but with very low base fees (~0.01–0.1 gwei).
 * The tip (maxPriorityFeePerGas) also needs to be non-zero to be included.
 * Safe defaults: maxPriorityFee = 0.01 gwei, maxFee = baseFee × 1.25 + tip.
 *
 * ── Cache ─────────────────────────────────────────────────────────────────────
 * Results are cached for 3 seconds to avoid one RPC call per tx when multiple
 * trades fire in the same scan tick. After 3s the next call re-fetches.
 *
 * ── Fallback ─────────────────────────────────────────────────────────────────
 * If the RPC call fails or the block has no baseFeePerGas (pre-London chain),
 * the oracle falls back to safe static values and logs a warning.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   const gas = await getEip1559Params(provider);
 *   await contract.executeTrade(..., { nonce, ...gas });
 */

import type { JsonRpcProvider } from "ethers";
import { log } from "../../logger.js";

// ── Config ────────────────────────────────────────────────────────────────────

/** Multiplier applied to the latest baseFee. 1.25 = 25% headroom. */
const BASE_FEE_MULTIPLIER = 1.25;

/**
 * Arbitrum tip: 0.01 gwei. Arbitrum sequencer doesn't auction on tip, but a
 * small non-zero tip prevents some edge-case rejections.
 */
const DEFAULT_TIP_GWEI = 0.01;

/**
 * Static fallback if block.baseFeePerGas is unavailable.
 * 0.1 gwei is safely above the Arbitrum minimum under normal conditions.
 */
const FALLBACK_BASE_FEE_GWEI = 0.1;

/** Cache TTL in milliseconds. */
const CACHE_TTL_MS = 3_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export type Eip1559Params = {
  maxFeePerGas:         bigint;   // wei
  maxPriorityFeePerGas: bigint;   // wei
};

// ── Cache ─────────────────────────────────────────────────────────────────────

let _cached: Eip1559Params | null = null;
let _cachedAt = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function gweiToWei(gwei: number): bigint {
  // 1 gwei = 1e9 wei. Use integer math to avoid float rounding.
  return BigInt(Math.ceil(gwei * 1e9));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get EIP-1559 gas parameters for the next transaction.
 * Cached for CACHE_TTL_MS milliseconds.
 *
 * @param provider  ethers JsonRpcProvider (read provider is sufficient)
 */
export async function getEip1559Params(
  provider: JsonRpcProvider,
): Promise<Eip1559Params> {
  const now = Date.now();
  if (_cached && now - _cachedAt < CACHE_TTL_MS) {
    return _cached;
  }

  try {
    const block = await provider.getBlock("latest");

    let baseFeeWei: bigint;
    if (block?.baseFeePerGas != null && block.baseFeePerGas > 0n) {
      baseFeeWei = block.baseFeePerGas;
    } else {
      // Pre-London or chain without EIP-1559 baseFee field
      log.warn("[gasOracle] block.baseFeePerGas unavailable, using static fallback");
      baseFeeWei = gweiToWei(FALLBACK_BASE_FEE_GWEI);
    }

    const tipWei = gweiToWei(DEFAULT_TIP_GWEI);

    // maxFeePerGas = baseFee × 1.25 + tip
    // The 1.25× buffer absorbs a single doubling of baseFee between block submission
    // and inclusion without making the tx stuck.
    const maxFeeWei = BigInt(Math.ceil(Number(baseFeeWei) * BASE_FEE_MULTIPLIER)) + tipWei;

    const params: Eip1559Params = {
      maxFeePerGas:         maxFeeWei,
      maxPriorityFeePerGas: tipWei,
    };

    _cached   = params;
    _cachedAt = now;

    log.debug(
      {
        baseFeeGwei:  (Number(baseFeeWei)  / 1e9).toFixed(4),
        maxFeeGwei:   (Number(maxFeeWei)   / 1e9).toFixed(4),
        tipGwei:      (Number(tipWei)      / 1e9).toFixed(4),
      },
      "[gasOracle] EIP-1559 params computed",
    );

    return params;
  } catch (e: any) {
    log.warn({ err: e?.message }, "[gasOracle] getBlock failed — using static fallback");

    const tipWei    = gweiToWei(DEFAULT_TIP_GWEI);
    const maxFeeWei = gweiToWei(FALLBACK_BASE_FEE_GWEI * BASE_FEE_MULTIPLIER) + tipWei;

    return {
      maxFeePerGas:         maxFeeWei,
      maxPriorityFeePerGas: tipWei,
    };
  }
}

/** Invalidate the cache (e.g. after a tx is submitted with stale gas params). */
export function invalidateGasCache(): void {
  _cached   = null;
  _cachedAt = 0;
}
