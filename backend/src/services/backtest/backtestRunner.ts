/**
 * backtestRunner.ts — Walk-forward strategy simulator
 *
 * Replicates the live botWorker (trend_range_fork) strategy logic in a
 * fully STATELESS, offline fashion against historical Binance kline data.
 *
 * Architecture:
 *   1. Fetch 5m OHLCV bars for the lookback period (paginated, up to 30 days)
 *   2. Derive 1h regime closes from 5m bars (every 12th bar)
 *   3. Walk bar-by-bar:
 *       - Every 12 bars: update 1h EMA regime (LONG / SHORT / NONE)
 *       - Per bar: check open position SL / trailing stop (using bar's High+Low)
 *       - Per bar: if no position, compute votes and check for entry
 *   4. Force-close any open position at end-of-data
 *   5. Compute BacktestMetrics from closed trades
 *
 * Key design decisions:
 *   - Uses bar's actual HIGH and LOW to check if SL was crossed intra-bar
 *     (more realistic than close-only checking — avoids SL overshoot bias)
 *   - Trailing stop peak updated using bar's favorable extreme (high for long,
 *     low for short) — gives full credit for intra-bar moves
 *   - Regime computed from the same EMA20/EMA50 of 1h closes as live bot
 *   - All indicator math copied from botWorker — no drift between live and backtest
 *   - Results cached in Redis for 1h (avoid re-fetching same symbol+days)
 */

import { log } from "../../logger.js";
import { computeMetrics, type ClosedTradeRecord, type BacktestMetrics } from "./metrics.js";

// ── Public API ─────────────────────────────────────────────────────────────────

export type BacktestParams = {
  symbol:                   string;
  days:                     number;    // lookback window (1–30)
  leverage?:                number;    // default 5
  stopLossPct?:             number;    // default 0.03 (3%)
  trailingPct?:             number;    // default 0.03 (3% reversal from peak)
  minProfitBeforeTrailing?: number;    // default 0.01 (1%)
  voteRequired?:            number;    // default 5
  stochOS?:                 number;    // default 35
  stochOB?:                 number;    // default 80
};

export type SimulatedTrade = ClosedTradeRecord & {
  entryTs:   number;   // epoch ms of entry bar's close
  exitTs:    number;   // epoch ms of exit bar's close
  entryBar:  number;   // bar index
  exitBar:   number;   // bar index
};

export type BacktestResult = {
  symbol:      string;
  days:        number;
  bars:        number;    // number of 5m bars analysed
  trades:      SimulatedTrade[];
  metrics:     BacktestMetrics;
  generatedAt: number;
};

// ── Raw OHLCV from Binance ─────────────────────────────────────────────────────

type OHLCVBar = {
  openTs:   number;
  open:     number;
  high:     number;
  low:      number;
  close:    number;
  closeTs:  number;
};

const FAPI_BASE = (process.env.BINANCE_FAPI_BASE ?? "https://fapi.binance.com").replace(/\/+$/, "");

async function fetchKlines(
  symbol:    string,
  interval:  string,
  startMs:   number,
  endMs:     number,
  limit = 1000,
): Promise<OHLCVBar[]> {
  const url =
    `${FAPI_BASE}/fapi/v1/klines` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&startTime=${startMs}` +
    `&endTime=${endMs}` +
    `&limit=${limit}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Binance klines HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const raw = (await res.json()) as any[];
  return raw.map((k: any) => ({
    openTs:  Number(k[0]),
    open:    Number(k[1]),
    high:    Number(k[2]),
    low:     Number(k[3]),
    close:   Number(k[4]),
    closeTs: Number(k[6]),
  }));
}

/**
 * Fetch historical OHLCV bars paginated.
 * Binance max 1000 per request; we paginate forward using startTime.
 */
async function fetchAllBars(symbol: string, interval: string, startMs: number, endMs: number): Promise<OHLCVBar[]> {
  const LIMIT = 999;
  const all: OHLCVBar[] = [];
  let cursor = startMs;

  while (cursor < endMs) {
    const page = await fetchKlines(symbol, interval, cursor, endMs, LIMIT);
    if (!page.length) break;
    all.push(...page);
    // advance cursor past last bar's close time
    cursor = page[page.length - 1]!.closeTs + 1;
    // Avoid hammering the API
    if (page.length === LIMIT) await new Promise(r => setTimeout(r, 120));
  }

  return all;
}

// ── Indicator functions (copied from botWorker — must stay in sync) ────────────

/** Exponential moving average. Returns null if insufficient data. */
function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i]! * k + e * (1 - k);
  return e;
}

/** RSI (Wilder's smoothing). Returns null if insufficient data. */
function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(0, d))  / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** Stochastic of RSI (K line, not yet smoothed to D). */
function stochRsiK(closes: number[], rsiPeriod = 14, stochPeriod = 14): number | null {
  if (closes.length < rsiPeriod + stochPeriod + 1) return null;
  const rsiSeries: number[] = [];
  for (let i = rsiPeriod; i < closes.length; i++) {
    const r = rsi(closes.slice(0, i + 1), rsiPeriod);
    if (r != null) rsiSeries.push(r);
  }
  if (rsiSeries.length < stochPeriod) return null;
  const window = rsiSeries.slice(-stochPeriod);
  const minR = Math.min(...window), maxR = Math.max(...window);
  if (maxR === minR) return 50;
  return ((rsiSeries[rsiSeries.length - 1]! - minR) / (maxR - minR)) * 100;
}

/** Bollinger Bands (simple MA ± mult * stddev). */
function bollinger(closes: number[], period = 20, mult = 2): { mid: number; upper: number; lower: number } | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { mid, upper: mid + mult * sd, lower: mid - mult * sd };
}

/** Highest high / lowest low over a lookback window (range levels). */
function rangeLevels(closes: number[], lookback = 50): { resistance: number; support: number } {
  const slice = closes.slice(-lookback);
  return { resistance: Math.max(...slice), support: Math.min(...slice) };
}

// ── Vote engine (stateless replica of computeVotesFork) ───────────────────────

type VoteResult = {
  decided: "LONG" | "SHORT" | "NONE";
  longVotes: number;
  shortVotes: number;
};

type VoteContext = {
  prevK: number | null;
  prevD: number | null;
  stochKHist: number[];
};

function computeVotes(
  closes:       number[],
  regime:       "LONG" | "SHORT" | "NONE",
  ctx:          VoteContext,
  OS:           number,
  OB:           number,
  D_LEN:        number,
  voteRequired: number,
): VoteResult {
  const last = closes[closes.length - 1]!;
  const prev = closes[closes.length - 2] ?? last;

  const r = rsi(closes, 14);
  const k = stochRsiK(closes, 14, 14);
  if (r == null || k == null) return { decided: "NONE", longVotes: 0, shortVotes: 0 };

  // D from rolling K history (stateful per-bar context)
  ctx.stochKHist.push(k);
  while (ctx.stochKHist.length > D_LEN) ctx.stochKHist.shift();
  const d = ctx.stochKHist.length === D_LEN
    ? ctx.stochKHist.reduce((a, b) => a + b, 0) / D_LEN
    : null;

  const pk = ctx.prevK;
  const pd = ctx.prevD;
  ctx.prevK = k;
  if (d != null) ctx.prevD = d;

  const crossUp   = pk != null && pd != null && d != null && pk <= pd && k > d;
  const crossDown = pk != null && pd != null && d != null && pk >= pd && k < d;
  const leftOS    = pk != null ? (pk <= OS && k > OS) : false;
  const leftOB    = pk != null ? (pk >= OB && k < OB) : false;

  // RSI lookback for pullback detection
  const LOOKBACK = 12;
  const rsiSeries: number[] = [];
  for (let i = Math.max(0, closes.length - (LOOKBACK + 20)); i < closes.length; i++) {
    const rr = rsi(closes.slice(0, i + 1), 14);
    if (rr != null) rsiSeries.push(rr);
  }
  const recent    = rsiSeries.slice(-LOOKBACK);
  const recentMin = recent.length ? Math.min(...recent) : r;
  const recentMax = recent.length ? Math.max(...recent) : r;
  const rsiRising  = r > (recent[recent.length - 2] ?? r);
  const rsiFalling = r < (recent[recent.length - 2] ?? r);

  // ── Trend mode ──────────────────────────────────────────────────────────────
  if (regime !== "NONE") {
    if (regime === "LONG") {
      let longVotes = 2;
      if (recentMin <= 55) longVotes += 1;
      const triggerOk = crossUp || leftOS;
      if (triggerOk) longVotes += 2;
      if (rsiRising)  longVotes += 1;
      const decided = triggerOk && longVotes >= voteRequired && longVotes > 0 ? "LONG" : "NONE";
      return { decided, longVotes, shortVotes: 0 };
    }
    if (regime === "SHORT") {
      let shortVotes = 2;
      if (recentMax >= 45) shortVotes += 1;
      const triggerOk = crossDown || leftOB;
      if (triggerOk) shortVotes += 2;
      if (rsiFalling) shortVotes += 1;
      const decided = triggerOk && shortVotes >= voteRequired && shortVotes > 0 ? "SHORT" : "NONE";
      return { decided, longVotes: 0, shortVotes };
    }
  }

  // ── Range mode ───────────────────────────────────────────────────────────────
  const bb  = bollinger(closes, 20, 2);
  const rl  = rangeLevels(closes, 50);
  const tol = last * 0.003;

  const nearSupport    = last <= rl.support + tol;
  const nearResistance = last >= rl.resistance - tol;
  const touchLowerBB   = bb ? last <= bb.lower + tol : false;
  const touchUpperBB   = bb ? last >= bb.upper - tol : false;

  const bullRejection = last > prev;
  const bearRejection = last < prev;

  const longLocationOk  = (nearSupport || touchLowerBB) && r <= 35;
  const shortLocationOk = (nearResistance || touchUpperBB) && r >= 65;
  const longTriggerOk   = (crossUp || leftOS) && bullRejection;
  const shortTriggerOk  = (crossDown || leftOB) && bearRejection;

  const rangeLong  = longLocationOk  && longTriggerOk;
  const rangeShort = shortLocationOk && shortTriggerOk;

  const longVotes  = rangeLong  ? 5 : 0;
  const shortVotes = rangeShort ? 5 : 0;

  const decided =
    rangeLong  && longVotes  >= voteRequired && longVotes  > shortVotes ? "LONG"
    : rangeShort && shortVotes >= voteRequired && shortVotes > longVotes ? "SHORT"
    : "NONE";

  return { decided, longVotes, shortVotes };
}

// ── Position simulator ────────────────────────────────────────────────────────

type OpenPosition = {
  isLong:     boolean;
  entryPrice: number;
  entryTs:    number;
  entryBar:   number;
  bestPrice:  number;  // highest for long, lowest for short
};

function checkAndCloseBar(
  pos:         OpenPosition,
  bar:         OHLCVBar,
  stopPct:     number,
  trailPct:    number,
  minProfit:   number,
): { closed: true; exitPrice: number; reason: string } | { closed: false } {
  // Update trailing best (use intra-bar extreme for full credit)
  if (pos.isLong) {
    if (bar.high > pos.bestPrice) pos.bestPrice = bar.high;
  } else {
    if (bar.low < pos.bestPrice) pos.bestPrice = bar.low;
  }

  // Check SL using intra-bar Low (long) or High (short) — realistic fill
  const slCheckPrice = pos.isLong ? bar.low : bar.high;
  const slMove = pos.isLong
    ? (pos.entryPrice - slCheckPrice) / pos.entryPrice
    : (slCheckPrice - pos.entryPrice) / pos.entryPrice;

  if (slMove >= stopPct) {
    // SL: assume exit at the stop price (entry ± stopPct)
    const exitPrice = pos.isLong
      ? pos.entryPrice * (1 - stopPct)
      : pos.entryPrice * (1 + stopPct);
    return { closed: true, exitPrice, reason: "STOP_LOSS" };
  }

  // Trailing stop: check using closing price (conservative)
  const bestMove = pos.isLong
    ? (pos.bestPrice - pos.entryPrice) / pos.entryPrice
    : (pos.entryPrice - pos.bestPrice) / pos.entryPrice;

  if (bestMove >= minProfit) {
    const giveBack = pos.isLong
      ? (pos.bestPrice - bar.close) / pos.bestPrice
      : (bar.close - pos.bestPrice) / pos.bestPrice;

    if (giveBack >= trailPct) {
      return { closed: true, exitPrice: bar.close, reason: "PROFIT_REVERSAL" };
    }
  }

  return { closed: false };
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runBacktest(params: BacktestParams): Promise<BacktestResult> {
  const {
    symbol,
    days          = 7,
    leverage      = 5,
    stopLossPct   = 0.03,
    trailingPct   = 0.03,
    minProfitBeforeTrailing = 0.01,
    voteRequired  = 5,
    stochOS       = 35,
    stochOB       = 80,
  } = params;

  const D_LEN = 3; // StochRSI D smoothing length (same as live bot)

  log.info({ symbol, days, leverage }, "[backtest] starting");

  const endMs   = Date.now();
  // Fetch extra warmup bars (60 5m bars = 5h) before the target window
  const warmup  = 60 * 5 * 60 * 1000; // 60 bars × 5 min
  const startMs = endMs - days * 24 * 60 * 60 * 1000 - warmup;

  // ── Fetch 5m bars ──────────────────────────────────────────────────────────
  log.info({ symbol, startMs, endMs }, "[backtest] fetching 5m bars");
  const bars5m = await fetchAllBars(symbol, "5m", startMs, endMs);

  if (bars5m.length < 120) {
    throw new Error(`Insufficient 5m bars for backtest: got ${bars5m.length}`);
  }

  log.info({ bars: bars5m.length }, "[backtest] 5m bars fetched");

  // ── Derive 1h closes from 5m bars ─────────────────────────────────────────
  // Every 12 consecutive 5m bars form one 1h bar.
  // We capture the close of bar #11 (0-indexed) of each group.
  const closes1h: number[] = [];
  for (let i = 11; i < bars5m.length; i += 12) {
    closes1h.push(bars5m[i]!.close);
  }

  // ── Walk-forward simulation ────────────────────────────────────────────────
  let regime: "LONG" | "SHORT" | "NONE" = "NONE";
  let position: OpenPosition | null = null;
  const trades: SimulatedTrade[] = [];

  // Stochastic D context (stateful across bars, reset on entry)
  const voteCtx: VoteContext = { prevK: null, prevD: null, stochKHist: [] };

  // Skip first 60 bars (indicator warmup)
  const WARMUP_BARS = 60;

  for (let i = WARMUP_BARS; i < bars5m.length; i++) {
    const bar    = bars5m[i]!;
    const closes = bars5m.slice(0, i + 1).map(b => b.close);

    // ── Update 1h regime every 12 bars ────────────────────────────────────
    if (i % 12 === 11) {
      const h1Idx    = Math.floor(i / 12);
      const h1Window = closes1h.slice(0, h1Idx + 1);
      const e20      = ema(h1Window, 20);
      const e50      = ema(h1Window, 50);
      if (e20 != null && e50 != null) {
        regime = e20 > e50 ? "LONG" : e20 < e50 ? "SHORT" : "NONE";
      }
    }

    // ── Exit check (position is open) ─────────────────────────────────────
    if (position) {
      const result = checkAndCloseBar(position, bar, stopLossPct, trailingPct, minProfitBeforeTrailing);

      if (result.closed) {
        const { exitPrice, reason } = result;
        const pnlPct = position.isLong
          ? (exitPrice - position.entryPrice) / position.entryPrice
          : (position.entryPrice - exitPrice) / position.entryPrice;

        trades.push({
          symbol,
          isLong:      position.isLong,
          entryPrice:  position.entryPrice,
          exitPrice,
          pnlPct,
          leverage,
          durationMs:  bar.closeTs - position.entryTs,
          reason,
          closedAt:    bar.closeTs,
          entryTs:     position.entryTs,
          exitTs:      bar.closeTs,
          entryBar:    position.entryBar,
          exitBar:     i,
        });

        position = null;
        // Reset vote context on close (fresh stoch history for next entry)
        voteCtx.prevK       = null;
        voteCtx.prevD       = null;
        voteCtx.stochKHist  = [];
      }
      continue; // don't enter a new position on the same bar
    }

    // ── Entry check (no open position) ────────────────────────────────────
    const votes = computeVotes(closes, regime, voteCtx, stochOS, stochOB, D_LEN, voteRequired);
    if (votes.decided !== "NONE") {
      position = {
        isLong:     votes.decided === "LONG",
        entryPrice: bar.close,
        entryTs:    bar.closeTs,
        entryBar:   i,
        bestPrice:  bar.close,
      };
    }
  }

  // ── Force-close any open position at end-of-data ──────────────────────────
  if (position && bars5m.length > 0) {
    const lastBar  = bars5m[bars5m.length - 1]!;
    const exitPrice = lastBar.close;
    const pnlPct    = position.isLong
      ? (exitPrice - position.entryPrice) / position.entryPrice
      : (position.entryPrice - exitPrice) / position.entryPrice;

    trades.push({
      symbol,
      isLong:      position.isLong,
      entryPrice:  position.entryPrice,
      exitPrice,
      pnlPct,
      leverage,
      durationMs:  lastBar.closeTs - position.entryTs,
      reason:      "END_OF_DATA",
      closedAt:    lastBar.closeTs,
      entryTs:     position.entryTs,
      exitTs:      lastBar.closeTs,
      entryBar:    position.entryBar,
      exitBar:     bars5m.length - 1,
    });
  }

  // ── Compute metrics ────────────────────────────────────────────────────────
  // Only include trades in the requested window (exclude warmup-period trades)
  const windowStart = endMs - days * 24 * 60 * 60 * 1000;
  const windowTrades = trades.filter(t => t.entryTs >= windowStart);

  const metrics = computeMetrics(windowTrades);
  const analysedBars = bars5m.length - WARMUP_BARS;

  log.info(
    { symbol, days, bars: analysedBars, trades: windowTrades.length, winRate: metrics.winRate.toFixed(2) },
    "[backtest] complete"
  );

  return {
    symbol,
    days,
    bars:        analysedBars,
    trades:      windowTrades,
    metrics,
    generatedAt: Date.now(),
  };
}
