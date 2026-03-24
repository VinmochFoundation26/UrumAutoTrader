/**
 * botWorker.scalping.ts — High-Frequency Scalping Strategy
 *
 * Entry logic:
 *   - EMA(3) × EMA(8) crossover on 1m/3m candles
 *   - RSI(7) in valid zone (30–70 for LONG, 30–70 for SHORT)
 *   - Volume spike: latest bar > 1.5× 20-period average
 *   - Price relative to VWAP (above = LONG bias, below = SHORT bias)
 *
 * Exit logic:
 *   - Hard stop:   0.4% raw (4% lev loss at 10×)
 *   - Profit trail: arms at 0.3% raw, trail step 0.2% raw
 *   - Max hold:    15 minutes (900 seconds) — fast strategy, stale positions killed
 */

import { toWad, divWad, type Wad } from "./services/onchain/wad.js";
import { fetchBinanceOHLCV }       from "./services/market/binanceCandles.js";
import { log }                     from "./logger.js";
import {
  saveActiveTrade,
  deleteActiveTrade,
  appendClosedTrade,
  type CachedTrade,
} from "./services/cache/tradeCache.js";
import { recordDailyReturn } from "./services/bot/drawdownGuard.js";

// ── Re-export shared types ────────────────────────────────────────────────────

export type UserKey = string;

export type EngineDeps = {
  redis?: any;
  getVaultBalanceWad: (args: { userKey: UserKey; symbol: string; isLong: boolean }) => Promise<Wad>;
  executeTrade: (args: { userKey: UserKey; symbol: string; timeframe: string; isLong: boolean; leverage: number; sizeWad: Wad; entryPriceWad: Wad }) => Promise<any>;
  closePosition: (args: { userKey: UserKey; symbol: string; timeframe: string; exitPriceWad: Wad }) => Promise<any>;
  emit?: (event: Record<string, any>) => void;
  strategy?: string;
  trigger?: Record<string, any>;
};

// ── Config ────────────────────────────────────────────────────────────────────

export type ScalpConfig = {
  STOP_LOSS_PCT:       number;  // 0.004 = 0.4% raw
  PROFIT_TRAIL_ARM:    number;  // 0.003 = 0.3% raw — arms trailing stop
  PROFIT_TRAIL_STEP:   number;  // 0.002 = 0.2% raw — give-back allowed
  DEFAULT_LEVERAGE:    number;  // 10
  MAX_LEVERAGE:        number;  // 20 (scalping caps lower for safety)
  COOLDOWN_SECONDS:    number;  // 120 — 2 minutes between trades per symbol
  MAX_HOLD_SECONDS:    number;  // 900 — 15 minutes max
  VOLUME_MULT:         number;  // 1.5 — volume spike threshold
  EMA_FAST:            number;  // 3
  EMA_SLOW:            number;  // 8
  RSI_PERIOD:          number;  // 7
  RSI_OVERSOLD:        number;  // 35
  RSI_OVERBOUGHT:      number;  // 65
  MANUAL_SIZE_PCT:     number;  // 0 = auto
};

const DEFAULT_CFG: ScalpConfig = {
  STOP_LOSS_PCT:       0.004,
  PROFIT_TRAIL_ARM:    0.003,
  PROFIT_TRAIL_STEP:   0.002,
  DEFAULT_LEVERAGE:    10,
  MAX_LEVERAGE:        20,
  COOLDOWN_SECONDS:    120,
  MAX_HOLD_SECONDS:    900,
  VOLUME_MULT:         1.5,
  EMA_FAST:            3,
  EMA_SLOW:            8,
  RSI_PERIOD:          7,
  RSI_OVERSOLD:        35,
  RSI_OVERBOUGHT:      65,
  MANUAL_SIZE_PCT:     0,
};

// ── In-module state ───────────────────────────────────────────────────────────

type ActiveTrade = {
  userKey:       string;
  symbol:        string;
  timeframe:     string;
  isLong:        boolean;
  leverage:      number;
  entryPriceWad: Wad;
  bestPriceWad:  Wad;
  sizeWad:       Wad;
  openedAtMs:    number;
  closing:       boolean;
};

const activeTrades   = new Map<string, ActiveTrade>();
const lastActionAt   = new Map<string, number>();
const lastCandleAt   = new Map<string, number>();

function posKey(userKey: string, symbol: string) { return `${userKey}:${symbol}`; }
function candleKey(userKey: string, symbol: string, tf: string) { return `${userKey}:${symbol}:${tf}`; }

function emit(deps: EngineDeps, e: Record<string, any>) {
  deps.emit?.({ ts: Date.now(), strategy: "scalping", ...e });
}

// ── Indicators ────────────────────────────────────────────────────────────────

function ema(v: number[], p: number): number | null {
  if (v.length < p) return null;
  const k = 2 / (p + 1);
  let e = v[0]!;
  for (let i = 1; i < v.length; i++) e = v[i]! * k + e * (1 - k);
  return Number.isFinite(e) ? e : null;
}

function rsi(v: number[], p = 14): number | null {
  if (v.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = v.length - (p + 1); i < v.length - 1; i++) {
    const d = v[i + 1]! - v[i]!;
    if (d >= 0) g += d; else l += -d;
  }
  const ag = g / p, al = l / p;
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

function vwap(highs: number[], lows: number[], closes: number[], vols: number[]): number | null {
  const n = Math.min(highs.length, lows.length, closes.length, vols.length);
  if (n === 0) return null;
  let cumTPV = 0, cumVol = 0;
  for (let i = 0; i < n; i++) {
    const tp = (highs[i]! + lows[i]! + closes[i]!) / 3;
    cumTPV += tp * vols[i]!;
    cumVol += vols[i]!;
  }
  if (cumVol === 0) return null;
  return cumTPV / cumVol;
}

function volumeSpike(vols: number[], period = 20, mult = 1.5): boolean {
  if (vols.length < period + 1) return true; // not enough data — don't block
  const avg = vols.slice(-period - 1, -1).reduce((a, b) => a + b, 0) / period;
  return vols[vols.length - 1]! >= avg * mult;
}

// ── Exit logic ────────────────────────────────────────────────────────────────

function movePct(t: ActiveTrade, priceWad: Wad): number {
  const rawPct = t.isLong
    ? Number(divWad(priceWad - t.entryPriceWad, t.entryPriceWad))
    : Number(divWad(t.entryPriceWad - priceWad, t.entryPriceWad));
  return rawPct;
}

function shouldExit(
  t: ActiveTrade,
  priceWad: Wad,
  cfg: ScalpConfig,
  advanceBest = true,
): boolean {
  const rawMove = movePct(t, priceWad);
  const stopWad = toWad(cfg.STOP_LOSS_PCT);

  // Hard stop
  if (rawMove <= -Number(stopWad) / 1e18) return true;

  // Max hold gate
  if (Date.now() - t.openedAtMs > cfg.MAX_HOLD_SECONDS * 1000) return true;

  // Trailing stop (arms after PROFIT_TRAIL_ARM)
  if (advanceBest) {
    if (t.isLong && priceWad > t.bestPriceWad) t.bestPriceWad = priceWad;
    if (!t.isLong && priceWad < t.bestPriceWad) t.bestPriceWad = priceWad;
  }

  if (rawMove >= cfg.PROFIT_TRAIL_ARM) {
    const bestMove = t.isLong
      ? Number(divWad(t.bestPriceWad - t.entryPriceWad, t.entryPriceWad))
      : Number(divWad(t.entryPriceWad - t.bestPriceWad, t.entryPriceWad));
    if (bestMove - rawMove >= cfg.PROFIT_TRAIL_STEP) return true;
  }

  return false;
}

// ── Restore / register ────────────────────────────────────────────────────────

export async function restoreState(redis: any, userKey: string, symbols: string[]): Promise<void> {
  const { loadActiveTrades } = await import("./services/cache/tradeCache.js");
  const cached = await loadActiveTrades(redis, userKey, symbols);
  for (const [key, ct] of cached) {
    if (!activeTrades.has(key)) {
      activeTrades.set(key, {
        userKey:       ct.userKey,
        symbol:        ct.symbol,
        timeframe:     ct.timeframe,
        isLong:        ct.isLong,
        leverage:      ct.leverage,
        entryPriceWad: BigInt(ct.entryPriceWad),
        bestPriceWad:  BigInt(ct.bestPriceWad),
        sizeWad:       BigInt(ct.sizeWad),
        openedAtMs:    ct.openedAtMs ?? Date.now(),
        closing:       false,
      });
      log.info({ symbol: ct.symbol }, "[scalping] trade restored from Redis");
    }
  }
}

export function registerTradeAfterExecution(args: {
  userKey:       string;
  symbol:        string;
  timeframe:     string;
  isLong:        boolean;
  leverage:      number;
  sizeWad:       bigint;
  entryPriceWad: bigint;
  openedAtMs?:   number;
  redis?:        any;
}) {
  const pk = posKey(args.userKey, args.symbol);
  if (activeTrades.has(pk)) return;

  const trade: ActiveTrade = {
    userKey:       args.userKey,
    symbol:        args.symbol,
    timeframe:     args.timeframe,
    isLong:        args.isLong,
    leverage:      args.leverage,
    entryPriceWad: args.entryPriceWad,
    bestPriceWad:  args.entryPriceWad,
    sizeWad:       args.sizeWad,
    openedAtMs:    args.openedAtMs ?? Date.now(),
    closing:       false,
  };
  activeTrades.set(pk, trade);
  lastActionAt.set(pk, Date.now());

  if (args.redis) {
    const cached: CachedTrade = {
      userKey: trade.userKey, symbol: trade.symbol, timeframe: trade.timeframe,
      isLong: trade.isLong, leverage: trade.leverage,
      entryPriceWad:  trade.entryPriceWad.toString(),
      bestPriceWad:   trade.bestPriceWad.toString(),
      pendingBestWad: trade.bestPriceWad.toString(),
      sizeWad:        trade.sizeWad.toString(),
      openedAtMs:     trade.openedAtMs,
      pending: false,
    };
    saveActiveTrade(args.redis, args.userKey, args.symbol, cached).catch(() => {});
  }
  log.info({ symbol: args.symbol, isLong: args.isLong }, "[scalping] trade registered");
}

// ── Fast exit monitor (50ms) ──────────────────────────────────────────────────

export async function fastExitCheck(
  userKey: string,
  symbol:  string,
  livePrice: number,
  deps: Pick<EngineDeps, "closePosition" | "emit" | "redis">,
): Promise<void> {
  const pk    = posKey(userKey, symbol);
  const trade = activeTrades.get(pk);
  if (!trade || trade.closing) return;

  const cfg       = DEFAULT_CFG;
  const priceWad  = toWad(livePrice);
  const rawMove   = movePct(trade, priceWad);

  // Hard stop only in fast path — no best-price advance
  const hardStop  = cfg.STOP_LOSS_PCT;
  const trailArm  = cfg.PROFIT_TRAIL_ARM;
  const trailStep = cfg.PROFIT_TRAIL_STEP;
  const maxHoldMs = cfg.MAX_HOLD_SECONDS * 1000;

  let shouldClose = false;
  let reason = "";

  if (rawMove <= -hardStop) {
    shouldClose = true;
    reason = "STOP_LOSS";
  } else if (Date.now() - trade.openedAtMs > maxHoldMs) {
    shouldClose = true;
    reason = "MAX_HOLD";
  } else if (rawMove >= trailArm) {
    const bestMove = trade.isLong
      ? Number(divWad(trade.bestPriceWad - trade.entryPriceWad, trade.entryPriceWad))
      : Number(divWad(trade.entryPriceWad - trade.bestPriceWad, trade.entryPriceWad));
    if (bestMove - rawMove >= trailStep) {
      shouldClose = true;
      reason = "PROFIT_TRAIL";
    }
  }

  if (!shouldClose) return;

  trade.closing = true;
  try {
    await deps.closePosition({ userKey, symbol, timeframe: trade.timeframe, exitPriceWad: priceWad });
    activeTrades.delete(pk);
    if (deps.redis) await deleteActiveTrade(deps.redis, userKey, symbol);
    const pnlLev  = rawMove * trade.leverage;
    const closedAt = Date.now();
    if (deps.redis) await recordDailyReturn(deps.redis, userKey, pnlLev).catch(() => {});
    if (deps.redis) await appendClosedTrade(deps.redis, userKey, {
      symbol,
      isLong:     trade.isLong,
      entryPrice: Number(trade.entryPriceWad) / 1e18,
      exitPrice:  livePrice,
      pnlPct:     rawMove,
      leverage:   trade.leverage,
      durationMs: closedAt - trade.openedAtMs,
      reason,
      closedAt,
      timeframe:  trade.timeframe,
      strategy:   "scalping",
      openedAtMs: trade.openedAtMs,
    }).catch(() => {});
    deps.emit?.({ ts: Date.now(), type: "FAST_EXIT", strategy: "scalping", userKey, symbol, reason, pnlLev, livePrice });
    log.info({ symbol, reason, pnlLev }, "[scalping] fast exit");
    return;
  } catch (e: any) {
    trade.closing = false;
    deps.emit?.({ ts: Date.now(), type: "FAST_EXIT_ERROR", strategy: "scalping", userKey, symbol, error: e?.message });
  }
}

// ── Main scan ─────────────────────────────────────────────────────────────────

export async function evaluateUserSymbol(
  deps: EngineDeps & { redis?: any },
  args: { userKey: UserKey; symbol: string; timeframe: string; requestedLeverage?: number },
) {
  const { userKey, symbol, timeframe } = args;
  const cfg    = DEFAULT_CFG;
  const pk     = posKey(userKey, symbol);
  const ck     = candleKey(userKey, symbol, timeframe);

  // ── Open trade exit check ─────────────────────────────────────────────────
  const trade = activeTrades.get(pk);
  if (trade && !trade.closing) {
    let ohlcv;
    try {
      ohlcv = await fetchBinanceOHLCV({ symbol, interval: timeframe, limit: 60 });
    } catch { return; }

    const closes = ohlcv.closes;
    const price  = closes[closes.length - 1]!;
    const priceWad = toWad(price);

    if (shouldExit(trade, priceWad, cfg)) {
      trade.closing = true;
      try {
        await deps.closePosition({ userKey, symbol, timeframe: trade.timeframe, exitPriceWad: priceWad });
        activeTrades.delete(pk);
        if (deps.redis) await deleteActiveTrade(deps.redis, userKey, symbol);
        const rawMove  = movePct(trade, priceWad);
        const pnlLev   = rawMove * trade.leverage;
        const closedAt = Date.now();
        const reason   = rawMove <= -cfg.STOP_LOSS_PCT ? "STOP_LOSS"
                       : closedAt - trade.openedAtMs > cfg.MAX_HOLD_SECONDS * 1000 ? "MAX_HOLD"
                       : "PROFIT_TRAIL";
        if (deps.redis) await recordDailyReturn(deps.redis, userKey, pnlLev).catch(() => {});
        if (deps.redis) await appendClosedTrade(deps.redis, userKey, {
          symbol,
          isLong:     trade.isLong,
          entryPrice: Number(trade.entryPriceWad) / 1e18,
          exitPrice:  price,
          pnlPct:     rawMove,
          leverage:   trade.leverage,
          durationMs: closedAt - trade.openedAtMs,
          reason,
          closedAt,
          timeframe:  trade.timeframe,
          strategy:   "scalping",
          openedAtMs: trade.openedAtMs,
        }).catch(() => {});
        emit(deps, { type: "TRADE_CLOSED", userKey, symbol, reason, pnlLev });
        lastActionAt.set(pk, Date.now());
      } catch (e: any) {
        trade.closing = false;
        emit(deps, { type: "CLOSE_FAILED", userKey, symbol, error: e?.message });
      }
    }
    return;
  }

  // ── Cooldown guard ────────────────────────────────────────────────────────
  const lastAct = lastActionAt.get(pk) ?? 0;
  if (Date.now() - lastAct < cfg.COOLDOWN_SECONDS * 1000) return;

  // ── Fetch candles ─────────────────────────────────────────────────────────
  let ohlcv;
  try {
    ohlcv = await fetchBinanceOHLCV({ symbol, interval: timeframe, limit: 80 });
  } catch (e: any) {
    emit(deps, { type: "FETCH_ERROR", userKey, symbol, timeframe, error: e?.message });
    return;
  }

  const { opens, highs, lows, closes, volumes, closeTimesMs } = ohlcv;

  // Deduplicate candle ticks
  const latestCloseMs = closeTimesMs[closeTimesMs.length - 1] ?? 0;
  if (lastCandleAt.get(ck) === latestCloseMs) return;
  lastCandleAt.set(ck, latestCloseMs);

  if (closes.length < 30) return;

  // ── Compute signals ────────────────────────────────────────────────────────
  const emaFast  = ema(closes, cfg.EMA_FAST);
  const emaSlow  = ema(closes, cfg.EMA_SLOW);
  const emaFastP = ema(closes.slice(0, -1), cfg.EMA_FAST);
  const emaSlowP = ema(closes.slice(0, -1), cfg.EMA_SLOW);
  const rsiVal   = rsi(closes, cfg.RSI_PERIOD);
  const vwapVal  = vwap(highs, lows, closes, volumes);
  const volSpike = volumeSpike(volumes, 20, cfg.VOLUME_MULT);
  const price    = closes[closes.length - 1]!;

  if (emaFast == null || emaSlow == null || emaFastP == null || emaSlowP == null || rsiVal == null) return;

  // ── EMA crossover detection ───────────────────────────────────────────────
  const crossAbove = emaFastP <= emaSlowP && emaFast > emaSlow; // bullish crossover
  const crossBelow = emaFastP >= emaSlowP && emaFast < emaSlow; // bearish crossover

  let isLong: boolean | null = null;
  let reason = "";

  if (crossAbove && rsiVal >= cfg.RSI_OVERSOLD && rsiVal <= 70 && volSpike && (vwapVal == null || price >= vwapVal)) {
    isLong = true;
    reason = `EMA${cfg.EMA_FAST}/EMA${cfg.EMA_SLOW} cross-above, RSI=${rsiVal.toFixed(1)}, vol spike, price>=VWAP`;
  } else if (crossBelow && rsiVal >= 30 && rsiVal <= cfg.RSI_OVERBOUGHT && volSpike && (vwapVal == null || price <= vwapVal)) {
    isLong = false;
    reason = `EMA${cfg.EMA_FAST}/EMA${cfg.EMA_SLOW} cross-below, RSI=${rsiVal.toFixed(1)}, vol spike, price<=VWAP`;
  }

  const longVotes  = crossAbove ? 1 : 0;
  const shortVotes = crossBelow ? 1 : 0;

  emit(deps, {
    type: "VOTES", userKey, symbol, timeframe, strategy: "scalping",
    decided: isLong === null ? "NONE" : isLong ? "LONG" : "SHORT",
    votes: { longVotes, shortVotes, required: 1, reason },
  });

  if (isLong === null) return;

  // ── Size calculation ──────────────────────────────────────────────────────
  const leverage    = Math.min(cfg.DEFAULT_LEVERAGE, cfg.MAX_LEVERAGE);
  const priceWad    = toWad(price);
  let sizeWad: Wad;
  try {
    const balWad   = await deps.getVaultBalanceWad({ userKey, symbol, isLong });
    const sizePct  = cfg.MANUAL_SIZE_PCT > 0 ? cfg.MANUAL_SIZE_PCT : 0.12;
    sizeWad        = (balWad * BigInt(Math.round(sizePct * 10000))) / 10000n;
    if (sizeWad === 0n) { emit(deps, { type: "ENTRY_SKIPPED", userKey, symbol, reason: "zero balance" }); return; }
  } catch (e: any) {
    emit(deps, { type: "ENTRY_SKIPPED", userKey, symbol, reason: `balance fetch error: ${e?.message}` });
    return;
  }

  emit(deps, { type: "ENTRY_SIGNAL", userKey, symbol, timeframe, isLong, leverage, reason, strategy: "scalping" });

  // ── Execute ────────────────────────────────────────────────────────────────
  try {
    const result = await deps.executeTrade({ userKey, symbol, timeframe, isLong, leverage, sizeWad, entryPriceWad: priceWad });
    if ((result as any)?.txHash) {
      registerTradeAfterExecution({ userKey, symbol, timeframe, isLong, leverage, sizeWad, entryPriceWad: priceWad, redis: deps.redis });
      lastActionAt.set(pk, Date.now());
      emit(deps, { type: "TRADE_EXECUTED", userKey, symbol, timeframe, isLong, leverage, strategy: "scalping", result });
    }
  } catch (e: any) {
    emit(deps, { type: "TRADE_FAILED", userKey, symbol, error: e?.message, strategy: "scalping" });
  }
}
