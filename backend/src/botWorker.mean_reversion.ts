/**
 * botWorker.mean_reversion.ts — Bollinger Band Mean Reversion Strategy
 *
 * Entry logic:
 *   - Price < lower BB(20, 2σ) AND RSI < 30  → LONG (oversold, expect bounce)
 *   - Price > upper BB(20, 2σ) AND RSI > 70  → SHORT (overbought, expect drop)
 *   - ADX < 30 (not in a strong trend — ranging market preferred)
 *   - Deviation from SMA must be > 1.5% (meaningful extension)
 *
 * Exit logic:
 *   - Target: return to middle Bollinger Band (SMA20)
 *   - Hard stop: 1.5% raw (15% lev loss at 10×)
 *   - Trail: arms at 0.5% raw, step 0.3% raw
 *   - Max hold: 4 hours
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

// ── Types ─────────────────────────────────────────────────────────────────────

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

export type MeanRevConfig = {
  STOP_LOSS_PCT:        number;  // 0.015 = 1.5% raw
  PROFIT_TRAIL_ARM:     number;  // 0.005 = 0.5% raw
  PROFIT_TRAIL_STEP:    number;  // 0.003 = 0.3% raw give-back
  TARGET_MID_BAND:      boolean; // true = also exit at middle BB (SMA20)
  DEFAULT_LEVERAGE:     number;  // 10
  MAX_LEVERAGE:         number;  // 30
  COOLDOWN_SECONDS:     number;  // 600
  MAX_HOLD_SECONDS:     number;  // 14400 = 4h
  BB_PERIOD:            number;  // 20
  BB_STD_MULT:          number;  // 2.0
  RSI_PERIOD:           number;  // 14
  RSI_OVERSOLD:         number;  // 30
  RSI_OVERBOUGHT:       number;  // 70
  ADX_MAX:              number;  // 30 (don't trade in strong trends)
  MIN_DEVIATION_PCT:    number;  // 0.015 = 1.5% price deviation from SMA
  MANUAL_SIZE_PCT:      number;  // 0 = auto
};

const DEFAULT_CFG: MeanRevConfig = {
  STOP_LOSS_PCT:        0.015,
  PROFIT_TRAIL_ARM:     0.005,
  PROFIT_TRAIL_STEP:    0.003,
  TARGET_MID_BAND:      true,
  DEFAULT_LEVERAGE:     10,
  MAX_LEVERAGE:         30,
  COOLDOWN_SECONDS:     600,
  MAX_HOLD_SECONDS:     14400,
  BB_PERIOD:            20,
  BB_STD_MULT:          2.0,
  RSI_PERIOD:           14,
  RSI_OVERSOLD:         30,
  RSI_OVERBOUGHT:       70,
  ADX_MAX:              30,
  MIN_DEVIATION_PCT:    0.015,
  MANUAL_SIZE_PCT:      0,
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
  midBandWad:    Wad;   // target exit: SMA20 at entry time
  closing:       boolean;
};

const activeTrades = new Map<string, ActiveTrade>();
const lastActionAt = new Map<string, number>();
const lastCandleAt = new Map<string, number>();

function posKey(userKey: string, symbol: string) { return `${userKey}:${symbol}`; }
function candleKey(userKey: string, symbol: string, tf: string) { return `${userKey}:${symbol}:${tf}`; }

function emit(deps: EngineDeps, e: Record<string, any>) {
  deps.emit?.({ ts: Date.now(), strategy: "mean_reversion", ...e });
}

// ── Indicators ────────────────────────────────────────────────────────────────

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

function bollinger(closes: number[], period = 20, mult = 2): { mid: number; upper: number; lower: number } | null {
  if (closes.length < period) return null;
  const win = closes.slice(-period);
  const mid = win.reduce((a, b) => a + b, 0) / win.length;
  const variance = win.reduce((a, b) => a + (b - mid) ** 2, 0) / win.length;
  const sd = Math.sqrt(variance);
  return { mid, upper: mid + mult * sd, lower: mid - mult * sd };
}

function adx(
  highs: number[], lows: number[], closes: number[], period = 14,
): { adx: number; plusDI: number; minusDI: number } | null {
  const n = highs.length;
  if (n < period * 2 + 2) return null;
  const tr: number[] = [], pdm: number[] = [], mdm: number[] = [];
  for (let i = 1; i < n; i++) {
    const h = highs[i]!, l = lows[i]!, pc = closes[i - 1]!;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = highs[i]! - highs[i - 1]!, dn = lows[i - 1]! - lows[i]!;
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
  }
  let sTR = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let sPDM = pdm.slice(0, period).reduce((a, b) => a + b, 0);
  let sMDM = mdm.slice(0, period).reduce((a, b) => a + b, 0);
  const dx: number[] = [];
  for (let i = period; i < tr.length; i++) {
    sTR  = sTR  - sTR  / period + tr[i]!;
    sPDM = sPDM - sPDM / period + pdm[i]!;
    sMDM = sMDM - sMDM / period + mdm[i]!;
    if (sTR === 0) continue;
    const pDI = (sPDM / sTR) * 100, mDI = (sMDM / sTR) * 100;
    const s = pDI + mDI;
    dx.push(s === 0 ? 0 : (Math.abs(pDI - mDI) / s) * 100);
  }
  if (dx.length < period) return null;
  let adxVal = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) adxVal = (adxVal * (period - 1) + dx[i]!) / period;
  if (sTR === 0) return null;
  return { adx: adxVal, plusDI: (sPDM / sTR) * 100, minusDI: (sMDM / sTR) * 100 };
}

// ── Exit logic ────────────────────────────────────────────────────────────────

function movePct(t: ActiveTrade, priceWad: Wad): number {
  return t.isLong
    ? Number(divWad(priceWad - t.entryPriceWad, t.entryPriceWad))
    : Number(divWad(t.entryPriceWad - priceWad, t.entryPriceWad));
}

function shouldExit(t: ActiveTrade, priceWad: Wad, cfg: MeanRevConfig, advanceBest = true): boolean {
  const rawMove = movePct(t, priceWad);

  // Hard stop
  if (rawMove <= -cfg.STOP_LOSS_PCT) return true;

  // Max hold
  if (Date.now() - t.openedAtMs > cfg.MAX_HOLD_SECONDS * 1000) return true;

  // Target: middle BB (mean reversion achieved)
  if (cfg.TARGET_MID_BAND && t.midBandWad > 0n) {
    const reachedMid = t.isLong ? priceWad >= t.midBandWad : priceWad <= t.midBandWad;
    if (reachedMid) return true;
  }

  // Trailing stop
  if (advanceBest) {
    if (t.isLong  && priceWad > t.bestPriceWad) t.bestPriceWad = priceWad;
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
        midBandWad:    0n,
        closing:       false,
      });
      log.info({ symbol: ct.symbol }, "[mean_reversion] trade restored from Redis");
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
    midBandWad:    0n,
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
  log.info({ symbol: args.symbol, isLong: args.isLong }, "[mean_reversion] trade registered");
}

// ── Fast exit monitor ─────────────────────────────────────────────────────────

export async function fastExitCheck(
  userKey:   string,
  symbol:    string,
  livePrice: number,
  deps: Pick<EngineDeps, "closePosition" | "emit" | "redis">,
): Promise<void> {
  const pk    = posKey(userKey, symbol);
  const trade = activeTrades.get(pk);
  if (!trade || trade.closing) return;

  const cfg      = DEFAULT_CFG;
  const priceWad = toWad(livePrice);
  const rawMove  = movePct(trade, priceWad);

  let shouldClose = false, reason = "";
  if (rawMove <= -cfg.STOP_LOSS_PCT) { shouldClose = true; reason = "STOP_LOSS"; }
  else if (Date.now() - trade.openedAtMs > cfg.MAX_HOLD_SECONDS * 1000) { shouldClose = true; reason = "MAX_HOLD"; }
  else if (cfg.TARGET_MID_BAND && trade.midBandWad > 0n) {
    const reachedMid = trade.isLong ? priceWad >= trade.midBandWad : priceWad <= trade.midBandWad;
    if (reachedMid) { shouldClose = true; reason = "MEAN_REACHED"; }
  }
  else if (rawMove >= cfg.PROFIT_TRAIL_ARM) {
    const bestMove = trade.isLong
      ? Number(divWad(trade.bestPriceWad - trade.entryPriceWad, trade.entryPriceWad))
      : Number(divWad(trade.entryPriceWad - trade.bestPriceWad, trade.entryPriceWad));
    if (bestMove - rawMove >= cfg.PROFIT_TRAIL_STEP) { shouldClose = true; reason = "PROFIT_TRAIL"; }
  }

  if (!shouldClose) return;

  trade.closing = true;
  try {
    await deps.closePosition({ userKey, symbol, timeframe: trade.timeframe, exitPriceWad: priceWad });
    activeTrades.delete(pk);
    if (deps.redis) await deleteActiveTrade(deps.redis, userKey, symbol);
    const pnlLev   = rawMove * trade.leverage;
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
      strategy:   "mean_reversion",
      openedAtMs: trade.openedAtMs,
    }).catch(() => {});
    deps.emit?.({ ts: Date.now(), type: "FAST_EXIT", strategy: "mean_reversion", userKey, symbol, reason, pnlLev, livePrice });
    log.info({ symbol, reason, pnlLev }, "[mean_reversion] fast exit");
  } catch (e: any) {
    trade.closing = false;
    deps.emit?.({ ts: Date.now(), type: "FAST_EXIT_ERROR", strategy: "mean_reversion", userKey, symbol, error: e?.message });
  }
}

// ── Main scan ─────────────────────────────────────────────────────────────────

export async function evaluateUserSymbol(
  deps: EngineDeps & { redis?: any },
  args: { userKey: UserKey; symbol: string; timeframe: string; requestedLeverage?: number },
) {
  const { userKey, symbol, timeframe } = args;
  const cfg = DEFAULT_CFG;
  const pk  = posKey(userKey, symbol);
  const ck  = candleKey(userKey, symbol, timeframe);

  // ── Open trade exit check ─────────────────────────────────────────────────
  const trade = activeTrades.get(pk);
  if (trade && !trade.closing) {
    let ohlcv;
    try {
      ohlcv = await fetchBinanceOHLCV({ symbol, interval: timeframe, limit: 60 });
    } catch { return; }
    const closes  = ohlcv.closes;
    const price   = closes[closes.length - 1]!;
    const priceWad = toWad(price);
    const bb      = bollinger(closes, cfg.BB_PERIOD, cfg.BB_STD_MULT);
    if (bb) trade.midBandWad = toWad(bb.mid);
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
                       : bb && (trade.isLong ? priceWad >= trade.midBandWad : priceWad <= trade.midBandWad) ? "MEAN_REACHED"
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
          strategy:   "mean_reversion",
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

  // ── Cooldown ──────────────────────────────────────────────────────────────
  const lastAct = lastActionAt.get(pk) ?? 0;
  if (Date.now() - lastAct < cfg.COOLDOWN_SECONDS * 1000) return;

  // ── Fetch OHLCV ───────────────────────────────────────────────────────────
  let ohlcv;
  try {
    ohlcv = await fetchBinanceOHLCV({ symbol, interval: timeframe, limit: 100 });
  } catch (e: any) {
    emit(deps, { type: "FETCH_ERROR", userKey, symbol, timeframe, error: e?.message });
    return;
  }

  const { highs, lows, closes, closeTimesMs } = ohlcv;

  const latestCloseMs = closeTimesMs[closeTimesMs.length - 1] ?? 0;
  if (lastCandleAt.get(ck) === latestCloseMs) return;
  lastCandleAt.set(ck, latestCloseMs);

  if (closes.length < 50) return;

  // ── Compute signals ────────────────────────────────────────────────────────
  const bb      = bollinger(closes, cfg.BB_PERIOD, cfg.BB_STD_MULT);
  const rsiVal  = rsi(closes, cfg.RSI_PERIOD);
  const adxData = adx(highs, lows, closes, 14);
  const price   = closes[closes.length - 1]!;

  if (!bb || rsiVal == null) return;

  const deviationPct = Math.abs(price - bb.mid) / bb.mid;
  const trendStrong  = adxData != null && adxData.adx > cfg.ADX_MAX;

  let isLong: boolean | null = null;
  let reason = "";

  if (!trendStrong && deviationPct >= cfg.MIN_DEVIATION_PCT) {
    if (price < bb.lower && rsiVal <= cfg.RSI_OVERSOLD) {
      isLong = true;
      reason = `price < lower BB (${bb.lower.toFixed(4)}), RSI=${rsiVal.toFixed(1)}, deviation=${(deviationPct * 100).toFixed(2)}%`;
    } else if (price > bb.upper && rsiVal >= cfg.RSI_OVERBOUGHT) {
      isLong = false;
      reason = `price > upper BB (${bb.upper.toFixed(4)}), RSI=${rsiVal.toFixed(1)}, deviation=${(deviationPct * 100).toFixed(2)}%`;
    }
  }

  const longVotes  = price < bb.lower && rsiVal <= 35 ? 1 : 0;
  const shortVotes = price > bb.upper && rsiVal >= 65 ? 1 : 0;

  emit(deps, {
    type: "VOTES", userKey, symbol, timeframe, strategy: "mean_reversion",
    decided: isLong === null ? "NONE" : isLong ? "LONG" : "SHORT",
    votes: { longVotes, shortVotes, required: 1, reason, bbMid: bb.mid, adx: adxData?.adx },
  });

  if (isLong === null) return;

  // ── Size ──────────────────────────────────────────────────────────────────
  const leverage = Math.min(cfg.DEFAULT_LEVERAGE, cfg.MAX_LEVERAGE);
  const priceWad = toWad(price);
  let sizeWad: Wad;
  try {
    const balWad  = await deps.getVaultBalanceWad({ userKey, symbol, isLong });
    const sizePct = cfg.MANUAL_SIZE_PCT > 0 ? cfg.MANUAL_SIZE_PCT : 0.15;
    sizeWad = (balWad * BigInt(Math.round(sizePct * 10000))) / 10000n;
    if (sizeWad === 0n) { emit(deps, { type: "ENTRY_SKIPPED", userKey, symbol, reason: "zero balance" }); return; }
  } catch (e: any) {
    emit(deps, { type: "ENTRY_SKIPPED", userKey, symbol, reason: `balance fetch error: ${e?.message}` });
    return;
  }

  emit(deps, { type: "ENTRY_SIGNAL", userKey, symbol, timeframe, isLong, leverage, reason, strategy: "mean_reversion" });

  // ── Execute ────────────────────────────────────────────────────────────────
  try {
    const result = await deps.executeTrade({ userKey, symbol, timeframe, isLong, leverage, sizeWad, entryPriceWad: priceWad });
    if ((result as any)?.txHash) {
      registerTradeAfterExecution({ userKey, symbol, timeframe, isLong, leverage, sizeWad, entryPriceWad: priceWad, redis: deps.redis });
      // Store mid-band target on the freshly-registered trade
      const fresh = activeTrades.get(pk);
      if (fresh) fresh.midBandWad = toWad(bb.mid);
      lastActionAt.set(pk, Date.now());
      emit(deps, { type: "TRADE_EXECUTED", userKey, symbol, timeframe, isLong, leverage, strategy: "mean_reversion", result });
    }
  } catch (e: any) {
    emit(deps, { type: "TRADE_FAILED", userKey, symbol, error: e?.message, strategy: "mean_reversion" });
  }
}
