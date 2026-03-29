import { getSigner, getVaultContract } from "../onchain/contractInstance.js";
import {
  getUserBalancesWad,
  executeTradeVaultV2,
  closePositionVaultV2,
  symbolToMarketId,
} from "../onchain/vaultAdapter.js";
import { recordEvent } from "./state.js";
import { getRedis } from "../cache/redis.js";
import { log } from "../../logger.js";
import type { Redis } from "ioredis";

const STABLE_DECIMALS = Number(process.env.STABLE_DECIMALS ?? "6");
const PAPER_MODE = String(process.env.PAPER_MODE ?? "false") === "true";

// ── Public type — lets botWorker import the deps shape without circular deps ──

export type EngineDeps = ReturnType<typeof makeEngineDeps>;

export function makeEngineDeps() {
  const vault  = getVaultContract();
  const signer = getSigner();
  const redis: Redis = getRedis();   // ← injected Redis — activates all botWorker Redis calls

  return {
    redis,

    getVaultBalanceWad: async ({
      userKey,
      isLong,
    }: {
      userKey: string;
      symbol: string;
      isLong: boolean;
    }) => {
      const { stableWad } = await getUserBalancesWad(vault, userKey, STABLE_DECIMALS);

      log.debug({ userKey, isLong, stableWad: stableWad.toString() }, "[deps] vault balance");

      // V2 is USDC-only: collateral is always stable (USDC) regardless of direction.
      return stableWad;
    },

    executeTrade: async ({
      userKey,
      symbol,
      isLong,
      leverage,
      sizeWad,
      entryPriceWad,
    }: {
      userKey: string;
      symbol: string;
      timeframe: string;
      isLong: boolean;
      leverage: number;
      sizeWad: bigint;
      entryPriceWad: bigint;
    }) => {
      if (PAPER_MODE) return { paper: true, action: "executeTrade" };

      // ── Pre-check: contract-level cooldown (prevents on-chain revert) ────────
      // The vault has its own cooldown that may outlast the bot's Redis cooldown.
      // Calling cooldownRemaining() costs one RPC read but prevents a wasted tx.
      try {
        const remaining = await (vault as any).cooldownRemaining(userKey) as bigint;
        if (remaining > 0n) {
          log.debug({ symbol, remainingSeconds: remaining.toString() }, "[deps] contract cooldown active, skipping entry");
          return { skipped: true, reason: "contract_cooldown", remainingSeconds: Number(remaining) };
        }
      } catch {
        // If the view call fails, proceed optimistically (don't block entry)
      }

      const marketId = symbolToMarketId(symbol);
      // ── Pre-check: skip if this exact market is already open on-chain ───────
      // openCount alone is not enough; we need to guard per-symbol duplicate entry
      // so the UI does not surface a revert like "pos already open".
      try {
        const pos = await (vault as any).positionOf(userKey, marketId);
        if (pos?.isOpen) {
          log.debug({ symbol, userKey }, "[deps] market already open on-chain, skipping entry");
          return { skipped: true, reason: "position_already_open" };
        }
      } catch {
        // If the view call fails, proceed optimistically (don't block entry)
      }

      // sizeWad is x18; divide by leverage → collateralX18; divide by 10^12 → raw 6-dec USDC
      const collateralRaw = sizeWad / BigInt(leverage) / (10n ** 12n);

      return executeTradeVaultV2(vault, signer, {
        user: userKey,
        marketId,
        isLong,
        sizeX18: sizeWad,
        entryPriceX18: entryPriceWad,
        collateralRaw,
      }, { redis, symbol });
    },

    closePosition: async ({
      userKey,
      symbol,
      exitPriceWad,
    }: {
      userKey: string;
      symbol: string;
      timeframe: string;
      exitPriceWad: bigint;
    }) => {
      if (PAPER_MODE) return { paper: true, action: "closePosition" };

      const marketId = symbolToMarketId(symbol);
      return closePositionVaultV2(vault, signer, {
        user: userKey,
        marketId,
        exitPriceX18: exitPriceWad,
      }, { redis, symbol });
    },

    emit: (e: Record<string, any>) => {
      recordEvent(e);
      log.info(e, `[bot] ${e?.type ?? "EVENT"}`);
    },
  };
}
