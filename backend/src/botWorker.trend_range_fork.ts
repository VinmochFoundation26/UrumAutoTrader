import { toWad, divWad, mulWad, type Wad } from "./services/onchain/wad.js";
import { fetchBinanceCloses, fetchBinanceOHLCV, type BinanceOHLCV } from "./services/market/binanceCandles.js";
import { log } from "./logger.js";
import {
  saveActiveTrade,
  deleteActiveTrade,
  saveTrendRegime,
  appendClosedTrade,
  type CachedTrade,
} from "./services/cache/tradeCache.js";
import { recordDailyReturn } from "./services/bot/drawdownGuard.js";
import {
  extractFeatures,
  featureKey,
  getAiScore,
  recordTradeOutcome,
} from "./services/ai/signalScorer.js";

export type UserKey = string;

// ── Per-symbol max leverage caps ──────────────────────────────────────────────
// BTC and ETH support up to 100x on most perp venues.
// Alt-coins (TAO, RENDER, SOL, etc.) are capped at 30x due to lower liquidity.
export const SYMBOL_MAX_LEVERAGE: Record<string, number> = {
  BTCUSDT:    100,
  ETHUSDT:    100,
  TAOUSDT:     30,
  RENDERUSDT:  30,
  SOLUSDT:     50,
  BNBUSDT:     75,
  XRPUSDT:     50,
  DOGEUSDT:    25,
};

/** Hard cap for a given symbol.  Falls back to 20x for unknown symbols. */
export function symbolMaxLev(symbol: string): number {
  return SYMBOL_MAX_LEVERAGE[symbol.toUpperCase()] ?? 20;
}

export type BotConfig = {
  STOP_LOSS_PCT: number;              // hard stop   — 0.015 = 1.5% raw → 15% lev loss at 10×
  EXIT_ON_PROFIT_REVERSAL: number;    // step size   — 0.03 = 3% lev per step (0.3% raw at 10×)
  MIN_PROFIT_BEFORE_REVERSAL: number; // min gate    — 0.03 = 3% lev (0.3% raw) — first staircase step
  PROFIT_LOCK_GATE: number;           // major gate  — 0.30 = 30% lev (3% raw) — floor locks here permanently once hit
  DEFAULT_LEVERAGE: number;           // e.g. 10
  MAX_LEVERAGE: number;               // soft user ceiling (further capped by SYMBOL_MAX_LEVERAGE)
  COOLDOWN_SECONDS: number;           // e.g. 600
  VOTE_REQUIRED: number;              // e.g. 5 — minimum votes to fire an entry
  ATR_PERIOD: number;                 // e.g. 14 — ATR lookback period (close-to-close)
  ATR_VOLATILITY_THRESHOLD: number;   // e.g. 0.008 = 0.8% — skip entry above this ATR%
  MANUAL_SIZE_PCT: number;            // 0 = auto ATR-scaled; >0 = fixed % of vault per trade (e.g. 0.10 = 10%)
};

export const DEFAULT_CFG: BotConfig = {
  STOP_LOSS_PCT: 0.01,         // Tier 1 (10×–30×): 1% raw stop → 10% lev loss at 10×
                               // Tier 2 (40×–100×): overridden dynamically to 0.5–0.8% ATR-scaled (see shouldExit)
  EXIT_ON_PROFIT_REVERSAL: 0.03,    // step size   — 3% lev per staircase step (0.3% raw at 10×)
  MIN_PROFIT_BEFORE_REVERSAL: 0.03, // min gate    — trail arms at 3% lev (0.3% raw at 10×) — first staircase step
  PROFIT_LOCK_GATE: 0.30,           // major gate  — 30% lev (3% raw at 10×) — floor permanently locked once hit
  DEFAULT_LEVERAGE: 10,
  MAX_LEVERAGE: 100,           // raised; symbol cap enforced separately
  COOLDOWN_SECONDS: 600,
  VOTE_REQUIRED: 5,            // lowered back to 5: max available votes is 9 but 5 is achievable in good setups
  ATR_PERIOD: 14,
  ATR_VOLATILITY_THRESHOLD: 0.008, // Tier 1 gate; Tier 2 uses 60% of this (≈0.48%)
                                   // Raised from 0.5% → 0.8%: RENDER/TAO normal ATR is 0.52–0.61%,
                                   // which was blocking them 78–90% of the time. BTC/ETH (ATR ~0.21%)
                                   // are unaffected. Genuine volatility spikes (>0.8%) still blocked.
  MANUAL_SIZE_PCT: 0,          // 0 = auto (ATR-scaled, 15% base)
};

function asNum(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : undefined;
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

export function validateConfig(raw: Partial<Record<keyof BotConfig, unknown>>): BotConfig {
  const stop  = asNum(raw.STOP_LOSS_PCT) ?? DEFAULT_CFG.STOP_LOSS_PCT;
  const rev   = asNum(raw.EXIT_ON_PROFIT_REVERSAL) ?? DEFAULT_CFG.EXIT_ON_PROFIT_REVERSAL;
  const minP  = asNum(raw.MIN_PROFIT_BEFORE_REVERSAL) ?? DEFAULT_CFG.MIN_PROFIT_BEFORE_REVERSAL;
  const defL  = asNum(raw.DEFAULT_LEVERAGE) ?? DEFAULT_CFG.DEFAULT_LEVERAGE;
  const maxL  = asNum(raw.MAX_LEVERAGE) ?? DEFAULT_CFG.MAX_LEVERAGE;
  const cds   = asNum(raw.COOLDOWN_SECONDS) ?? DEFAULT_CFG.COOLDOWN_SECONDS;
  const vreq  = asNum(raw.VOTE_REQUIRED) ?? DEFAULT_CFG.VOTE_REQUIRED;
  const atrP  = asNum(raw.ATR_PERIOD) ?? DEFAULT_CFG.ATR_PERIOD;
  const atrT  = asNum(raw.ATR_VOLATILITY_THRESHOLD) ?? DEFAULT_CFG.ATR_VOLATILITY_THRESHOLD;
  const msp   = asNum(raw.MANUAL_SIZE_PCT) ?? DEFAULT_CFG.MANUAL_SIZE_PCT;

  const lockG = asNum(raw.PROFIT_LOCK_GATE) ?? DEFAULT_CFG.PROFIT_LOCK_GATE;

  const STOP_LOSS_PCT              = clamp(stop,  0.001, 0.20);  // 0.1% .. 20% raw
  const EXIT_ON_PROFIT_REVERSAL    = clamp(rev,   0.001, 0.50);  // step size — 3% lev per step
  const MIN_PROFIT_BEFORE_REVERSAL = clamp(minP,  0.001, 0.50);  // min gate — first step activation
  const PROFIT_LOCK_GATE           = clamp(lockG, 0.001, 1.00);  // major gate — permanent floor once hit

  // User sets their own ceiling; per-symbol hard cap is enforced at entry time
  const MAX_LEVERAGE     = clamp(Math.floor(maxL), 1, 100);
  const DEFAULT_LEVERAGE = clamp(Math.floor(defL), 1, MAX_LEVERAGE);

  const COOLDOWN_SECONDS         = clamp(Math.floor(cds), 0, 24 * 3600);
  const VOTE_REQUIRED            = clamp(Math.floor(vreq), 3, 6);   // min 3, max 6
  const ATR_PERIOD               = clamp(Math.floor(atrP), 5, 50);
  const ATR_VOLATILITY_THRESHOLD = clamp(atrT, 0.001, 0.05);        // 0.1% .. 5%

  // 0 = auto ATR-scaled; 0.01 .. 1.00 = fixed fraction of vault per trade
  const MANUAL_SIZE_PCT = clamp(msp, 0, 1.0);

  return {
    STOP_LOSS_PCT,
    EXIT_ON_PROFIT_REVERSAL,
    MIN_PROFIT_BEFORE_REVERSAL,
    PROFIT_LOCK_GATE,
    DEFAULT_LEVERAGE,
    MAX_LEVERAGE,
    COOLDOWN_SECONDS,
    VOTE_REQUIRED,
    ATR_PERIOD,
    ATR_VOLATILITY_THRESHOLD,
    MANUAL_SIZE_PCT,
  };
}

// Keys you can use for the admin panel:
export const CFG_KEYS = {
  global: "botcfg:global",
  user: (userAddr: string) => `botcfg:user:${userAddr.toLowerCase()}`,
};

async function safeJsonGet(redis: any, key: string): Promise<any | null> {
  try {
    const s = await redis.get(key);
    if (!s) return null;
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Merges: DEFAULT <- global <- user, then validates.
export async function loadUserConfig(redis: any, userAddr: string): Promise<BotConfig> {
  const [globalRaw, userRaw] = await Promise.all([
    safeJsonGet(redis, CFG_KEYS.global),
    safeJsonGet(redis, CFG_KEYS.user(userAddr)),
  ]);

  const merged = { ...(globalRaw ?? {}), ...(userRaw ?? {}) } as Partial<Record<keyof BotConfig, unknown>>;
  return validateConfig(merged);
}
type LeveragePolicy = {
  defaultLev: number;
  maxLev: number;
  minLev: number;
  step: number; // set to 1 unless you truly support halves, etc.
};

export function clampLeverage(input: unknown, policy: LeveragePolicy): number {
  const n = typeof input === "string" ? Number(input) : (input as number);

  if (!Number.isFinite(n)) return policy.defaultLev;

  const stepped = Math.round(n / policy.step) * policy.step;
  const clamped = Math.min(policy.maxLev, Math.max(policy.minLev, stepped));

  if (!Number.isFinite(clamped) || clamped <= 0) return policy.defaultLev;
  return clamped;
}

// helper using BotConfig
export function resolveLeverage(requested: unknown, cfg: BotConfig): number {
  return clampLeverage(requested, {
    defaultLev: cfg.DEFAULT_LEVERAGE,
    maxLev: cfg.MAX_LEVERAGE,
    minLev: 1,
    step: 1,
  });
}

export type PositionState = {
  entryPrice: number;
  isLong: boolean;

  // Track best favorable excursion:
  peakPriceSinceEntry: number;   // long: highest price since entry
  troughPriceSinceEntry: number; // short: lowest price since entry

  openedAtMs: number;
};

export type CloseDecision =
  | { action: "HOLD"; pnlPct: number }
  | { action: "CLOSE"; reason: "STOP_LOSS" | "PROFIT_REVERSAL"; pnlPct: number };

function pnlPct(entry: number, price: number, isLong: boolean) {
  const raw = (price - entry) / entry;
  return isLong ? raw : -raw;
}

function updateBestPrice(pos: PositionState, price: number) {
  if (pos.isLong) pos.peakPriceSinceEntry = Math.max(pos.peakPriceSinceEntry, price);
  else pos.troughPriceSinceEntry = Math.min(pos.troughPriceSinceEntry, price);
}

function reversalFromBestPct(pos: PositionState, price: number) {
  if (pos.isLong) {
    const peak = pos.peakPriceSinceEntry || pos.entryPrice;
    return (peak - price) / peak;
  } else {
    const trough = pos.troughPriceSinceEntry || pos.entryPrice;
    return (price - trough) / trough;
  }
}

// Call this each tick when a position is open
export function evaluateRisk(pos: PositionState, price: number, cfg: BotConfig): CloseDecision {
  // update best excursion first
  updateBestPrice(pos, price);

  const profit = pnlPct(pos.entryPrice, price, pos.isLong);

  // stop-loss
  if (profit <= -cfg.STOP_LOSS_PCT) {
    return { action: "CLOSE", reason: "STOP_LOSS", pnlPct: profit };
  }

  // profit reversal (only after min profit achieved)
  const rev = reversalFromBestPct(pos, price);
  if (profit >= cfg.MIN_PROFIT_BEFORE_REVERSAL && rev >= cfg.EXIT_ON_PROFIT_REVERSAL) {
    return { action: "CLOSE", reason: "PROFIT_REVERSAL", pnlPct: profit };
  }

  return { action: "HOLD", pnlPct: profit };
}

export const COOLDOWN_KEY = (userAddr: string, symbol: string) =>
  `cooldown:${userAddr.toLowerCase()}:${symbol.toUpperCase()}`;

async function getCooldownUntilMs(redis: any, key: string): Promise<number> {
  const v = await redis.get(key);
  const n = v ? Number(v) : 0;
  return Number.isFinite(n) ? n : 0;
}

async function setCooldown(redis: any, key: string, cooldownSeconds: number) {
  const until = Date.now() + cooldownSeconds * 1000;
  // TTL slightly longer than cooldown (optional)
  await redis.set(key, String(until), "PX", cooldownSeconds * 1000 + 60_000);
  return until;
}

// Entry guard (call before opening)
export async function cooldownBlocksEntry(redis: any, userAddr: string, symbol: string): Promise<{ blocked: boolean; remainingMs: number }> {
  const key = COOLDOWN_KEY(userAddr, symbol);
  const until = await getCooldownUntilMs(redis, key);
  const now = Date.now();
  return until > now ? { blocked: true, remainingMs: until - now } : { blocked: false, remainingMs: 0 };
}

// Set after close
export async function applyCooldown(redis: any, userAddr: string, symbol: string, cfg: BotConfig) {
  const key = COOLDOWN_KEY(userAddr, symbol);
  return setCooldown(redis, key, cfg.COOLDOWN_SECONDS);
}

export type EngineDeps = {
  redis?: any; // ioredis/redis client from your runner
  getVaultBalanceWad: (args: { userKey: UserKey; symbol: string; isLong: boolean }) => Promise<Wad>;
  executeTrade: (args: { userKey: UserKey; symbol: string; timeframe: string; isLong: boolean; leverage: number; sizeWad: Wad; entryPriceWad: Wad }) => Promise<any>;
  closePosition: (args: { userKey: UserKey; symbol: string; timeframe: string; exitPriceWad: Wad }) => Promise<any>;
  emit?: (event: Record<string, any>) => void;

  // runner attaches these
  strategy?: string;
  trigger?: { stochOS?: number; stochOB?: number; stochMid?: number; stochDLen?: number };
};

type Votes = {
  longVotes: number;
  shortVotes: number;
  required: number;
  mode: "TREND" | "RANGE";
  trendRegime: "LONG" | "SHORT" | "NONE";
  rsiValue?: number;
  stochK?: number;
  stochD?: number;
  atrPct?: number;
  reason: string;
};

type ActiveTrade = {
  userKey: UserKey;
  symbol: string;
  timeframe: string; // entry timeframe (5m)
  isLong: boolean;
  leverage: number;
  entryPriceWad: Wad;
  bestPriceWad: Wad;    // kline-confirmed trailing peak — gate anchors here
  pendingBestWad: Wad;  // candidate new high seen on LAST kline tick; promoted to bestPriceWad
                        // only when the NEXT tick confirms the price is still at/above it.
                        // Prevents micro-spikes (< 10s) from locking in a false gate floor.
  sizeWad: Wad;
  openedAtMs: number;
  pending: boolean;
  closing: boolean; // true once exit is in-flight — prevents double-close from fast monitor + scanner
};

const MIN_DATA_POINTS = 80;

// ---- persistent engine state (fork-ready) ----
const lastCandleCloseAtMs = new Map<string, number>(); // key: user:symbol:timeframe
const lastActionAt = new Map<string, number>();        // key: user:symbol
const activeTrades = new Map<string, ActiveTrade>();   // key: user:symbol

// Regime timeframe (1h) direction memory — updated each tick before 5m entry
const trendRegime = new Map<string, { dir: "LONG" | "SHORT" | "NONE"; updatedAt: number }>(); // key: user:symbol

// stoch helpers
const stochKHistory = new Map<string, number[]>(); // key: user:symbol:timeframe
const prevK = new Map<string, number>();
const prevD = new Map<string, number>();

// ── Phase 3: AI feature tracking ──────────────────────────────────────────────
// Stores the AI feature key captured at entry; retrieved on close to record outcome.
// Format: posKey (user:symbol) → featureKey string
const entryFeatureKeys = new Map<string, string>();

// ── Config cache for fastExitCheck ────────────────────────────────────────────
// Avoids 2 Redis calls × 4 symbols × 2/sec = 16 ops/sec hitting Redis just for config.
// Config changes infrequently (only on admin updates), so 10s staleness is fine.
const _cfgCache = new Map<string, { cfg: BotConfig; expiresAt: number }>();
const CFG_CACHE_TTL_MS = 10_000;

async function loadUserConfigCached(redis: any, userAddr: string): Promise<BotConfig> {
  const now = Date.now();
  const cached = _cfgCache.get(userAddr);
  if (cached && now < cached.expiresAt) return cached.cfg;
  const cfg = await loadUserConfig(redis, userAddr);
  _cfgCache.set(userAddr, { cfg, expiresAt: now + CFG_CACHE_TTL_MS });
  return cfg;
}

function emit(deps: EngineDeps, e: Record<string, any>) {
  deps.emit?.({ ts: Date.now(), ...e });
}

/**
 * Restore persistent state from Redis into module-level Maps.
 * Call once at bot startup (before on-chain recoverOpenPositions).
 * Preserves trailing stop peaks (bestPriceWad) across restarts.
 */
export async function restoreState(
  redis: any,
  userKey: string,
  symbols: string[],
): Promise<void> {
  // Restore active trades — verify each one is still open on-chain before registering.
  // This prevents ghost trades (Redis key present but vault position closed) from
  // blocking new entries after a crash, failed tx, or silent on-chain revert.
  const { loadActiveTrades, loadTrendRegimes, deleteActiveTrade: delTrade } = await import("./services/cache/tradeCache.js");
  const cachedTrades = await loadActiveTrades(redis, userKey, symbols);
  for (const [mapKey, ct] of cachedTrades) {
    if (!activeTrades.has(mapKey)) {
      // Ghost-trade guard: verify position is actually open on-chain
      try {
        const { getVaultAddress, VAULT_ABI, getProvider } = await import("./services/onchain/contractInstance.js");
        const { Contract } = await import("ethers");
        const provider = getProvider();
        const vault = new Contract(getVaultAddress(), VAULT_ABI, provider);
        const { symbolToMarketId } = await import("./services/onchain/vaultAdapter.js");
        const marketId = symbolToMarketId(ct.symbol);
        const pos = await (vault as any).positionOf(userKey, marketId);
        if (!pos.isOpen) {
          log.warn({ symbol: ct.symbol }, "[botWorker] ghost trade detected at startup — Redis key exists but vault position is closed. Clearing.");
          await delTrade(redis, userKey, ct.symbol);
          continue;
        }
      } catch (verifyErr: any) {
        // If on-chain check fails (RPC issue), restore the trade conservatively
        log.warn({ symbol: ct.symbol, err: verifyErr?.message }, "[botWorker] could not verify trade on-chain — restoring from Redis conservatively");
      }

      const trade: ActiveTrade = {
        userKey: ct.userKey,
        symbol: ct.symbol,
        timeframe: ct.timeframe,
        isLong: ct.isLong,
        leverage: ct.leverage,
        entryPriceWad:   BigInt(ct.entryPriceWad),
        bestPriceWad:    BigInt(ct.bestPriceWad),
        // pendingBestWad defaults to bestPriceWad if not stored (backwards-compat)
        pendingBestWad:  ct.pendingBestWad ? BigInt(ct.pendingBestWad) : BigInt(ct.bestPriceWad),
        sizeWad:         BigInt(ct.sizeWad),
        openedAtMs: ct.openedAtMs ?? Date.now(), // fallback: treat legacy trades (no timestamp) as just opened — they'll be recycled by 12h gate on next restart
        pending: false,
        closing: false,
      };
      activeTrades.set(mapKey, trade);
      log.info({ symbol: ct.symbol, isLong: ct.isLong }, "[botWorker] trade restored from Redis");
    }
  }

  // Restore trend regimes
  const cachedRegimes = await loadTrendRegimes(redis, userKey, symbols);
  for (const [mapKey, regime] of cachedRegimes) {
    if (!trendRegime.has(mapKey)) {
      trendRegime.set(mapKey, regime);
      log.info({ key: mapKey, dir: regime.dir }, "[botWorker] regime restored from Redis");
    }
  }
}

/**
 * Called by runner.ts after a successful direct executeTrade call.
 * Registers the trade in activeTrades so exit logic (stop-loss / profit-reversal)
 * runs on subsequent ticks.
 */
export function registerTradeAfterExecution(args: {
  userKey: string;
  symbol: string;
  timeframe: string;
  isLong: boolean;
  leverage: number;
  sizeWad: bigint;
  entryPriceWad: bigint;
  openedAtMs?: number;
  redis?: any;
}) {
  const pk = posKeyOf(args.userKey, args.symbol);

  // Check if already restored from Redis (preserve bestPriceWad from cache)
  const existing = activeTrades.get(pk);
  if (existing) {
    log.info({ symbol: args.symbol }, "[botWorker] registerTrade: already in activeTrades (Redis-restored), skipping");
    return;
  }

  const trade: ActiveTrade = {
    userKey: args.userKey,
    symbol: args.symbol,
    timeframe: args.timeframe,
    isLong: args.isLong,
    leverage: args.leverage,
    entryPriceWad:  args.entryPriceWad,
    bestPriceWad:   args.entryPriceWad,
    pendingBestWad: args.entryPriceWad, // starts at entry; advances via 2-phase confirmation
    sizeWad: args.sizeWad,
    openedAtMs: args.openedAtMs ?? Date.now(),
    pending: false,
    closing: false,
  };
  activeTrades.set(pk, trade);
  recordAct(pk);

  // Persist on-chain recovery to Redis (so future restarts use Redis, not on-chain)
  if (args.redis) {
    const cached: CachedTrade = {
      userKey: trade.userKey, symbol: trade.symbol, timeframe: trade.timeframe,
      isLong: trade.isLong, leverage: trade.leverage,
      entryPriceWad:  trade.entryPriceWad.toString(),
      bestPriceWad:   trade.bestPriceWad.toString(),
      pendingBestWad: trade.pendingBestWad.toString(),
      sizeWad:        trade.sizeWad.toString(),
      openedAtMs: trade.openedAtMs, pending: false,
    };
    saveActiveTrade(args.redis, args.userKey, args.symbol, cached).catch(() => {});
  }
  log.info({ symbol: args.symbol, isLong: args.isLong }, "[botWorker] trade registered (on-chain recovery)");
}

function canAct(posKey: string, cfg: BotConfig) {
  const last = lastActionAt.get(posKey) ?? 0;
  return Date.now() - last > cfg.COOLDOWN_SECONDS * 1000;
}

function recordAct(posKey: string) {
  lastActionAt.set(posKey, Date.now());
}

function posKeyOf(userKey: string, symbol: string) {
  return `${userKey}:${symbol}`;
}
function candleKeyOf(userKey: string, symbol: string, timeframe: string) {
  return `${userKey}:${symbol}:${timeframe}`;
}

/** Pick final leverage: user request → cfg ceiling → per-symbol hard cap. */
function pickLeverage(requested: unknown, cfg: BotConfig, symbol?: string) {
  const userLev = resolveLeverage(requested, cfg);
  const hardCap = symbol ? symbolMaxLev(symbol) : cfg.MAX_LEVERAGE;
  return Math.min(userLev, hardCap);
}

// ---------- indicators ----------
function ema(v: number[], p: number) {
  if (v.length < p) return null;
  const k = 2 / (p + 1);
  let e = v[0];
  for (let i = 1; i < v.length; i++) e = v[i] * k + e * (1 - k);
  return Number.isFinite(e) ? e : null;
}

function rsi(v: number[], p = 14) {
  if (v.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = v.length - (p + 1); i < v.length - 1; i++) {
    const d = v[i + 1] - v[i];
    if (d >= 0) g += d; else l += -d;
  }
  const ag = g / p, al = l / p;
  if (al === 0) return 100;
  const rs = ag / al;
  return 100 - 100 / (1 + rs);
}

function stochRsiK(v: number[], rsiP = 14, stochP = 14) {
  if (v.length < rsiP + stochP + 2) return null;
  const rsis: number[] = [];
  for (let i = rsiP + 1; i <= v.length; i++) {
    const r = rsi(v.slice(0, i), rsiP);
    if (r != null) rsis.push(r);
  }
  if (rsis.length < stochP + 1) return null;
  const tail = rsis.slice(-stochP);
  const cur = tail[tail.length - 1];
  const mn = Math.min(...tail);
  const mx = Math.max(...tail);
  const k = mx === mn ? 0 : ((cur - mn) / (mx - mn)) * 100;
  return k;
}

function rangeLevels(closes: number[], lookback = 50) {
  const win = closes.slice(-lookback);
  const support = Math.min(...win);
  const resistance = Math.max(...win);
  return { support, resistance };
}

function stddev(vals: number[]) {
  const m = vals.reduce((a,b)=>a+b,0) / vals.length;
  const v = vals.reduce((a,b)=>a + (b-m)*(b-m), 0) / vals.length;
  return Math.sqrt(v);
}

function bollinger(closes: number[], period = 20, mult = 2) {
  if (closes.length < period) return null;
  const win = closes.slice(-period);
  const mid = win.reduce((a,b)=>a+b,0) / win.length;
  const sd = stddev(win);
  return { mid, upper: mid + mult*sd, lower: mid - mult*sd };
}

/**
 * Rolling VWAP — typical price × volume weighted average over all supplied bars.
 * typical_price = (high + low + close) / 3
 * Returns null if arrays are empty or volumes are all zero.
 */
function vwap(highs: number[], lows: number[], closes: number[], volumes: number[]): number | null {
  const n = Math.min(highs.length, lows.length, closes.length, volumes.length);
  if (n === 0) return null;
  let cumTPV = 0, cumVol = 0;
  for (let i = 0; i < n; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    cumTPV += tp * volumes[i];
    cumVol += volumes[i];
  }
  if (cumVol === 0) return null;
  const result = cumTPV / cumVol;
  return Number.isFinite(result) ? result : null;
}

/**
 * EMA slope: difference between EMA(period) now and `lookback` bars ago.
 * Positive = upward slope, negative = downward slope.
 * Returns null if not enough data.
 */
function emaSlope(closes: number[], period: number, lookback = 3): number | null {
  if (closes.length < period + lookback) return null;
  const current  = ema(closes, period);
  const previous = ema(closes.slice(0, closes.length - lookback), period);
  if (current == null || previous == null) return null;
  return current - previous;
}

/**
 * Volume confirmation: true if the latest bar's volume is above the N-period average.
 */
function volumeAboveAverage(volumes: number[], period = 20): boolean {
  if (volumes.length < period + 1) return true; // not enough data — don't block
  const recent = volumes.slice(-period);
  const avg    = recent.reduce((a, b) => a + b, 0) / period;
  const latest = volumes[volumes.length - 1];
  return latest >= avg * 0.6; // 60% of avg — pullbacks in healthy trends often have lower volume
}

/**
 * RSI Bullish Divergence: price makes a lower low but RSI makes a higher low.
 * Looks back `lookback` bars for the swing low comparison.
 */
function rsiBullishDivergence(closes: number[], period = 14, lookback = 20): boolean {
  if (closes.length < period + lookback + 2) return false;
  const rsiNow  = rsi(closes, period);
  const rsiPrev = rsi(closes.slice(0, closes.length - lookback), period);
  if (rsiNow == null || rsiPrev == null) return false;
  const priceNow  = closes[closes.length - 1];
  const pricePrev = closes[closes.length - 1 - lookback];
  // Price lower low, RSI higher low = bullish divergence
  return priceNow < pricePrev && rsiNow > rsiPrev;
}

/**
 * RSI Bearish Divergence: price makes a higher high but RSI makes a lower high.
 * Looks back `lookback` bars for the swing high comparison.
 */
function rsiBearishDivergence(closes: number[], period = 14, lookback = 20): boolean {
  if (closes.length < period + lookback + 2) return false;
  const rsiNow  = rsi(closes, period);
  const rsiPrev = rsi(closes.slice(0, closes.length - lookback), period);
  if (rsiNow == null || rsiPrev == null) return false;
  const priceNow  = closes[closes.length - 1];
  const pricePrev = closes[closes.length - 1 - lookback];
  // Price higher high, RSI lower high = bearish divergence
  return priceNow > pricePrev && rsiNow < rsiPrev;
}

/**
 * Close-to-close ATR approximation (no OHLC required).
 * Returns the average |close[i] - close[i-1]| over the last `period` bars.
 * Returns null if not enough data.
 */
function atrClose(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let sum = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    sum += Math.abs(closes[i] - closes[i - 1]);
  }
  return sum / period;
}

/**
 * ADX — Average Directional Index (Wilder, default period = 14).
 * Returns { adx, plusDI, minusDI } or null if insufficient data.
 *
 * Interpretation used by Phase 2 SHORT guard:
 *   adx < 20  → no confirmed trend (choppy) → block SHORT
 *   adx 20–25 → emerging trend → allowed
 *   adx ≥ 25  → strong trend   → preferred
 *
 * Note: for ADX to be meaningful, the function needs OHLCV data (highs + lows).
 * Requires at least period*2 + 2 bars (≈ 30 bars at period=14).
 */
function adx(
  highs: number[],
  lows:  number[],
  closes: number[],
  period = 14,
): { adx: number; plusDI: number; minusDI: number } | null {
  const n = highs.length;
  if (n < period * 2 + 2 || n !== lows.length || n !== closes.length) return null;

  // Step 1: True Range and raw Directional Movement for each bar
  const trArr:  number[] = [];
  const pdmArr: number[] = [];
  const mdmArr: number[] = [];

  for (let i = 1; i < n; i++) {
    const h = highs[i], l = lows[i], pc = closes[i - 1];
    trArr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up   = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    pdmArr.push(up > down && up > 0 ? up : 0);
    mdmArr.push(down > up && down > 0 ? down : 0);
  }

  // Step 2: Wilder's initial smoothing (sum of first `period` bars)
  let sTR  = trArr.slice(0, period).reduce((a, b) => a + b, 0);
  let sPDM = pdmArr.slice(0, period).reduce((a, b) => a + b, 0);
  let sMDM = mdmArr.slice(0, period).reduce((a, b) => a + b, 0);

  // Step 3: Build DX series using Wilder's rolling update
  const dxArr: number[] = [];
  for (let i = period; i < trArr.length; i++) {
    sTR  = sTR  - sTR  / period + trArr[i];
    sPDM = sPDM - sPDM / period + pdmArr[i];
    sMDM = sMDM - sMDM / period + mdmArr[i];
    if (sTR === 0) continue;
    const pDI = (sPDM / sTR) * 100;
    const mDI = (sMDM / sTR) * 100;
    const sum = pDI + mDI;
    dxArr.push(sum === 0 ? 0 : (Math.abs(pDI - mDI) / sum) * 100);
  }

  if (dxArr.length < period) return null;

  // Step 4: ADX = Wilder-smoothed DX (seed = average of first `period` DX values)
  let adxVal = dxArr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxArr.length; i++) {
    adxVal = (adxVal * (period - 1) + dxArr[i]) / period;
  }

  if (sTR === 0) return null;
  return {
    adx:     adxVal,
    plusDI:  (sPDM / sTR) * 100,
    minusDI: (sMDM / sTR) * 100,
  };
}

// ---------- exits ----------
//
// Advance bestPriceWad directly from the kline extreme (HIGH for LONG, LOW for SHORT).
// We use settled OHLCV candle data here — not raw WS tick prices — so a single-candle
// peak is reliable and does not need multi-tick confirmation.
// The old 2-phase confirmation (pendingBestWad → bestPriceWad on next tick) was designed
// to filter WS micro-spikes, but those never reach this function (the fast monitor passes
// advanceBestPrice=false and never calls updateBest).  The 2-phase logic caused the trailing
// stop to silently fail whenever a peak-and-reverse happened in a single 10s window: the
// pending candidate was set but never confirmed, so bestPriceWad stayed at entry forever and
// bestMove stayed 0%, meaning the trailing gate never armed.
//
function updateBest(t: ActiveTrade, price: Wad): void {
  if (t.isLong) {
    if (price > t.bestPriceWad) {
      t.bestPriceWad  = price;
      t.pendingBestWad = price; // keep in sync for Redis persistence / compat
    }
  } else {
    if (price < t.bestPriceWad) {
      t.bestPriceWad  = price;
      t.pendingBestWad = price;
    }
  }
}

function movePctWad(t: ActiveTrade, price: Wad): Wad {
  return t.isLong ? divWad(price - t.entryPriceWad, t.entryPriceWad) : divWad(t.entryPriceWad - price, t.entryPriceWad);
}

// advanceBestPrice is kept for API compatibility but is no longer used inside
// shouldExit — bestPriceWad is now advanced by an explicit updateBest() call in
// the scanner BEFORE shouldExit is called.  The fast monitor still passes false
// (it must never advance bestPriceWad from raw WS tick prices).
function shouldExit(t: ActiveTrade, price: Wad, cfg: BotConfig, currentAtrPct = 0, advanceBestPrice = true, candleExtreme?: Wad): boolean {
  const rawMove = movePctWad(t, price); // raw price % (no leverage), direction-aware

  // ── 1. Hard stop-loss — leverage-tiered ────────────────────────────────────
  //
  // TIER 1 (10×–30×): fixed 1% raw stop  (cfg.STOP_LOSS_PCT = 0.01)
  //   • 1% raw × 10× = 10% leveraged loss at stop
  //   • Liquidation at 3.33% raw → 2.33% safety buffer ✅
  //   • Vault loss per stop: 1% × 10 × 15% collateral = 1.5% of vault
  //
  // TIER 2 (40×–100×): ATR-scaled stop, 0.5%–0.8% raw
  //   • Equal-risk formula: baseStop = clamp(0.30 / leverage, 0.5%, 0.8%)
  //     → targets same ~4.5% vault loss as Tier 1 at 40×–60×
  //   • ATR tightens stop toward 0.5% in volatile markets (dumps/pumps),
  //     widens toward base in calm trending conditions
  //   • At 80×–100× a 0.5% floor applies (below equal-risk, slight extra exposure)
  // ───────────────────────────────────────────────────────────────────────────
  let rawStopNum: number;
  if (t.leverage >= 40) {
    // Equal-risk base: targets ~30% leveraged loss (same proportional risk as Tier 1)
    const baseStop = Math.min(0.008, Math.max(0.005, 0.30 / t.leverage));
    // ATR factor: calm market → use baseStop; volatile → tighten toward 0.5% floor
    const atrFactor = currentAtrPct > 0 ? Math.min(1.0, 0.003 / currentAtrPct) : 1.0;
    rawStopNum = Math.max(0.005, baseStop * atrFactor);
  } else {
    // Tier 1: fixed raw stop (1% default)
    rawStopNum = cfg.STOP_LOSS_PCT;
  }
  const stop = toWad(rawStopNum);
  if (rawMove <= -stop) return true;

  // bestPriceWad is advanced by an explicit updateBest() call in the scanner loop
  // before shouldExit is called, so there is nothing to do here.

  // ── 2. Two-gate ratcheting staircase (LEVERAGED PnL terms) ──────────────────
  //
  //   MIN GATE  = MIN_PROFIT_BEFORE_REVERSAL (0.03 = 3% lev = 0.3% raw at 10×)
  //     — First step: trailing stop arms here. Any profit seen is locked.
  //
  //   STEP SIZE = EXIT_ON_PROFIT_REVERSAL    (0.03 = 3% lev = 0.3% raw at 10×)
  //     — Give-back allowed per step. Floor ratchets up every 3% lev.
  //
  //   MAJOR GATE = PROFIT_LOCK_GATE          (0.30 = 30% lev = 3% raw at 10×)
  //     — Once peak hits this level, floor permanently locks at 30% lev.
  //     — Trades that never reach major gate keep ratcheting from min gate up.
  //
  //   effectiveStop = max(minGate, peak − step)
  //   if peak >= majorGate: effectiveStop = max(effectiveStop, majorGate)
  //
  // Staircase table (at 10× leverage, step = 3% lev = 0.3% raw):
  //   peak =  3% lev (0.3% raw) → floor =  3% lev — any dip exits with profit ✓
  //   peak =  6% lev (0.6% raw) → floor =  3% lev (one step below peak)
  //   peak =  9% lev (0.9% raw) → floor =  6% lev
  //   peak = 12% lev (1.2% raw) → floor =  9% lev
  //   peak = 15% lev (1.5% raw) → floor = 12% lev
  //   peak = 18% lev (1.8% raw) → floor = 15% lev
  //   peak = 21% lev (2.1% raw) → floor = 18% lev
  //   peak = 24% lev (2.4% raw) → floor = 21% lev
  //   peak = 27% lev (2.7% raw) → floor = 24% lev
  //   peak = 30% lev (3.0% raw) → floor = 30% lev ← MAJOR GATE LOCKS HERE
  //   peak = 40% lev (4.0% raw) → floor = 37% lev (trailing above major gate)
  // ───────────────────────────────────────────────────────────────────────────
  const levWad    = toWad(t.leverage);
  const move      = mulWad(rawMove, levWad);                        // leveraged current PnL
  const bestMove  = mulWad(movePctWad(t, t.bestPriceWad), levWad); // leveraged peak PnL
  const minGate   = toWad(cfg.MIN_PROFIT_BEFORE_REVERSAL);         // 3% lev  — first step
  const lockGate  = toWad(cfg.PROFIT_LOCK_GATE);                   // 30% lev — major gate, permanent floor
  const trail     = toWad(cfg.EXIT_ON_PROFIT_REVERSAL);            // 3% lev  — step size / give-back

  if (bestMove >= minGate) {
    const trailLevel = bestMove - trail;
    let effectiveStop = trailLevel > minGate ? trailLevel : minGate; // max(minGate, peak − step)
    // Major gate: once peak reaches lockGate, snap floor up permanently
    if (bestMove >= lockGate && effectiveStop < lockGate) effectiveStop = lockGate;
    if (move <= effectiveStop) return true;
  }

  // ── 3. Maximum hold time — dead-capital protection ────────────────────────
  // If a trade has been open for > 12 hours without reaching the profit gate,
  // close it at market to free capital for new signals.
  // Applies even if in profit/loss — better to recycle than hold indefinitely.
  const MAX_HOLD_MS = 12 * 60 * 60 * 1000; // 12 hours
  if (Date.now() - Number(t.openedAtMs) >= MAX_HOLD_MS) return true;

  return false;
}

// ── Fast-path exit monitor (called every ~500ms using live WS prices) ─────────
//
// Why: The main scanner runs every 10s via Binance REST 5m-kline endpoint.
// When a sharp reversal occurs after the gate (5% lev) is hit, the bot might
// not catch the exit until the NEXT 10s tick, by which time the price has
// already fallen well below the 5% floor (e.g., to 0.69% lev).
//
// This function is called from runner.ts on a 500ms interval using getLatestPrice()
// (WebSocket cache, updated ~every 1 second). It catches exits within ~500ms of
// the reversal, so actual exit prices stay much closer to the trail floor.
//
// ATR is passed as 0 (no candle data here) — Tier-1 trades (≤30x) use a fixed
// stop so this is fine. Tier-2 trades (≥40x) use base stop without ATR tightening,
// which is slightly conservative (wider stop), an acceptable trade-off.
export async function fastExitCheck(
  userKey: string,
  symbol: string,
  livePrice: number,
  deps: Pick<EngineDeps, "closePosition" | "emit" | "redis">
): Promise<void> {
  const pk = posKeyOf(userKey, symbol);
  const t = activeTrades.get(pk);
  if (!t || t.pending || t.closing) return; // no trade, not started yet, or already being closed

  const priceWad = toWad(livePrice);
  // Use cached config (10s TTL) to avoid hammering Redis on every 500ms tick
  const cfg = deps.redis ? await loadUserConfigCached(deps.redis, userKey) : DEFAULT_CFG;

  // ── Minimum hold time guard (fast monitor) ─────────────────────────────────
  // Mirror the 60-second hold window used by the 10s kline scanner.
  // The scanner now advances bestPriceWad even during the hold window (to capture
  // early peaks), but the trailing exit must still wait 60 s to avoid exiting at
  // 0% on a brief pullback immediately after entry.
  // Hard stop-loss (rawMove ≤ -stop) is still allowed to fire immediately.
  const fastHeldMs  = Date.now() - t.openedAtMs;
  const MIN_HOLD_MS = 60_000;
  if (fastHeldMs < MIN_HOLD_MS) {
    // Only allow an immediate hard stop; skip the trailing-stop check entirely.
    const rawMoveF  = movePctWad(t, priceWad);
    const rawStopF  = t.leverage >= 40
      ? Math.max(0.005, Math.min(0.008, 0.30 / t.leverage))
      : cfg.STOP_LOSS_PCT;
    if (rawMoveF > -toWad(rawStopF)) return; // not at hard stop — keep holding
  }

  // advanceBestPrice=false: do NOT update bestPriceWad from raw WS tick prices.
  // WS prices include micro-spikes that reverse within < 500ms; locking bestPriceWad
  // to a spike would cause exits far below the gate on the very next tick.
  // bestPriceWad is advanced exclusively by the 10s kline scanner (advanceBestPrice=true).
  if (!shouldExit(t, priceWad, cfg, 0, false)) return;

  // Mark closing immediately — prevents the 10s scanner from also attempting a close
  t.closing = true;
  const heldMs = Date.now() - Number(t.openedAtMs);
  const exitReason = heldMs >= 12 * 60 * 60 * 1000 ? "max_hold_exit" : "risk_exit";
  emit(deps as unknown as EngineDeps, { type: "EXIT_SIGNAL", userKey, symbol, timeframe: t.timeframe, reason: exitReason, heldMinutes: Math.round(heldMs / 60000) });

  try {
    await deps.closePosition({ userKey, symbol, timeframe: t.timeframe, exitPriceWad: priceWad });
  } catch (closeErr: any) {
    if (String(closeErr?.message ?? "").includes("no open pos")) {
      log.warn({ symbol }, "[botWorker/fast] ghost trade detected — clearing local state");
      activeTrades.delete(pk);
      if (deps.redis) deleteActiveTrade(deps.redis, userKey, symbol).catch(() => {});
      emit(deps as unknown as EngineDeps, { type: "GHOST_TRADE_CLEARED", userKey, symbol, timeframe: t.timeframe });
      return;
    }
    // Close failed — allow retry by un-marking closing
    t.closing = false;
    log.error({ symbol, err: closeErr?.message }, "[botWorker/fast] close failed — will retry on next tick");
    return;
  }

  const exitPrice = livePrice;
  const entryPrice = Number(t.entryPriceWad) / 1e18;
  const rawMove = t.isLong
    ? (exitPrice - entryPrice) / entryPrice
    : (entryPrice - exitPrice) / entryPrice;

  activeTrades.delete(pk);
  if (deps.redis) {
    deleteActiveTrade(deps.redis, userKey, symbol).catch(() => {});
    appendClosedTrade(deps.redis, userKey, {
      symbol, isLong: t.isLong, entryPrice, exitPrice,
      pnlPct: rawMove, leverage: t.leverage,
      durationMs: Date.now() - t.openedAtMs,
      reason: "risk_exit", closedAt: Date.now(),
    }).catch(() => {});
    recordDailyReturn(deps.redis, userKey, rawMove * t.leverage).catch(() => {});
    const fk = entryFeatureKeys.get(pk);
    if (fk) {
      recordTradeOutcome(deps.redis, fk, rawMove > 0).catch(() => {});
      entryFeatureKeys.delete(pk);
    }
  }

  if (deps.redis) await applyCooldown(deps.redis, userKey, symbol, cfg);
  recordAct(pk);
  emit(deps as unknown as EngineDeps, { type: "POSITION_CLOSED", userKey, symbol, timeframe: t.timeframe, pnlPct: rawMove * t.leverage });
  log.info({ symbol, pnlPct: (rawMove * t.leverage * 100).toFixed(2) + "%", livePrice }, "[botWorker/fast] exit executed via fast monitor");
}


// ---------- votes (fork rules) ----------
function computeVotesFork(
  deps: EngineDeps,
  closes: number[],
  userKey: string,
  symbol: string,
  timeframe: string,
  cfg: BotConfig = DEFAULT_CFG,
  ohlcv?: BinanceOHLCV
): { decided: "LONG" | "SHORT" | "NONE"; votes: Votes } | null {

  const trig = deps.trigger ?? {};
  const OS = Number(trig.stochOS ?? 20);
  const OB = Number(trig.stochOB ?? 80);
  const D_LEN = Number(trig.stochDLen ?? 3);
  const required = cfg.VOTE_REQUIRED;

  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2] ?? last;

  // ── Regime timeframe (any non-5m, e.g. 1h): VWAP + EMA slope direction ──────
  // NEW LOGIC: replaces lagging EMA20/EMA50 crossover with real-time context:
  //   LONG  = price > VWAP  AND EMA20 slope is positive (upward momentum)
  //   SHORT = price < VWAP  AND EMA20 slope is negative (downward momentum)
  //   NONE  = conflicting signals (price above VWAP but slope down, or vice versa)
  //           → bot sits out rather than forcing a direction
  if (timeframe !== "5m") {
    const slope = emaSlope(closes, 20, 3);
    if (slope == null) return null;

    // Compute VWAP if OHLCV is available; fall back to EMA slope only if not
    let dir: "LONG" | "SHORT" | "NONE";
    let reason: string;

    if (ohlcv && ohlcv.highs.length >= 20) {
      const vwapLevel = vwap(ohlcv.highs, ohlcv.lows, ohlcv.closes, ohlcv.volumes);
      if (vwapLevel == null) return null;
      const priceAboveVwap = last > vwapLevel;
      const slopeUp        = slope > 0;
      dir =
        priceAboveVwap && slopeUp   ? "LONG"  :
        !priceAboveVwap && !slopeUp ? "SHORT" : "NONE";
      reason = `${timeframe} regime: price ${priceAboveVwap ? ">" : "<"} VWAP(${vwapLevel.toFixed(2)}) slope=${slope.toFixed(4)} → ${dir}`;
    } else {
      // Fallback (no OHLCV): use EMA slope alone + EMA20 vs EMA50 crossover
      const e20 = ema(closes, 20);
      const e50 = ema(closes, 50);
      if (e20 == null || e50 == null) return null;
      const crossDir: "LONG" | "SHORT" | "NONE" = e20 > e50 ? "LONG" : e20 < e50 ? "SHORT" : "NONE";
      // Both slope and cross must agree for a direction
      dir =
        crossDir === "LONG"  && slope > 0 ? "LONG"  :
        crossDir === "SHORT" && slope < 0 ? "SHORT" : "NONE";
      reason = `${timeframe} regime (fallback): EMA20 ${crossDir} slope=${slope.toFixed(4)} → ${dir}`;
    }

    const regime = { dir, updatedAt: Date.now() };

    // All regime timeframes (1h, etc.) update the primary trend regime.
    trendRegime.set(`${userKey}:${symbol}`, regime);
    if ((deps as any).redis) {
      saveTrendRegime((deps as any).redis, userKey, symbol, regime).catch(() => {});
    }

    return {
      decided: "NONE",
      votes: {
        longVotes:  dir === "LONG"  ? 3 : 0,
        shortVotes: dir === "SHORT" ? 3 : 0,
        required,
        mode: "TREND",
        trendRegime: dir,
        reason,
      },
    };
  }

  const t = trendRegime.get(`${userKey}:${symbol}`)?.dir ?? "NONE";

  const r = rsi(closes, 14);
  const k = stochRsiK(closes, 14, 14);
  if (r == null || k == null) return null;

  // D from rolling K history
  const stochKey = `${userKey}:${symbol}:${timeframe}`;
  const hist = stochKHistory.get(stochKey) ?? [];
  hist.push(k);
  while (hist.length > D_LEN) hist.shift();
  stochKHistory.set(stochKey, hist);
  const d = hist.length === D_LEN ? hist.reduce((a,b)=>a+b,0) / D_LEN : null;

  const pk = prevK.get(stochKey);
  const pd = prevD.get(stochKey);
  prevK.set(stochKey, k);
  if (d != null) prevD.set(stochKey, d);

  const crossUp = pk != null && pd != null && d != null && pk <= pd && k > d;
  const crossDown = pk != null && pd != null && d != null && pk >= pd && k < d;

  const leftOS = pk != null ? (pk <= OS && k > OS) : false;
  const leftOB = pk != null ? (pk >= OB && k < OB) : false;

  // -------- TREND pullback entries (only if 15m trend exists) --------
  // “was RSI pulled back recently?”
  const LOOKBACK = 12;
  // build RSI mini-series cheaply
  const rsiSeries: number[] = [];
  for (let i = Math.max(0, closes.length - (LOOKBACK + 20)); i < closes.length; i++) {
    const rr = rsi(closes.slice(0, i + 1), 14);
    if (rr != null) rsiSeries.push(rr);
  }
  const recent = rsiSeries.slice(-LOOKBACK);
  const recentMin = recent.length ? Math.min(...recent) : r;
  const recentMax = recent.length ? Math.max(...recent) : r;

  const rsiRising = r > (recent[recent.length - 2] ?? r);
  const rsiFalling = r < (recent[recent.length - 2] ?? r);

  // range helpers (used only when 15m trend NONE)
  const bb = bollinger(closes, 20, 2);
  const rl = rangeLevels(closes, 50);
  const tol = last * 0.003; // 0.3% tolerance

  const nearSupport = last <= rl.support + tol;
  const nearResistance = last >= rl.resistance - tol;
  const touchLowerBB = bb ? last <= bb.lower + tol : false;
  const touchUpperBB = bb ? last >= bb.upper - tol : false;

  let decided: "LONG" | "SHORT" | "NONE" = "NONE";
  let longVotes = 0;
  let shortVotes = 0;
  // `required` comes from cfg.VOTE_REQUIRED (default 5)

  // ── 5m short-term trend filter — 2-candle confirmation ────────────────────
  // Require the LAST TWO closes to both be on the correct side of the 5m EMA20.
  // Single-candle confirmation allowed brief bounce entries: price would spike
  // above EMA20 for one 5m bar during a downtrend, triggering a LONG, then fall
  // immediately back below EMA20 → stop-loss within minutes (TAO -10% pattern).
  // Requiring two consecutive closes above EMA20 means the price has held the
  // EMA for at least one full 5m candle after the initial breakout — far less
  // likely to be a false spike.
  const e20_5m      = ema(closes, 20);                    // EMA20 at current close
  const e20_5m_prev = ema(closes.slice(0, -1), 20);       // EMA20 one candle ago
  const prevLast    = closes.length >= 2 ? closes[closes.length - 2] : null;

  // Both the current AND previous close must be on the correct side of their
  // respective EMA20 values. Null-safe: if either is unavailable, gate = false.
  const priceAboveEma20 =
    e20_5m != null && e20_5m_prev != null && prevLast != null &&
    last > e20_5m && prevLast > e20_5m_prev;              // required for LONG

  const priceBelowEma20 =
    e20_5m != null && e20_5m_prev != null && prevLast != null &&
    last < e20_5m && prevLast < e20_5m_prev;              // required for SHORT

  // Volume confirmation (5m): volume >= 60% of 20-bar average (was 80%).
  // Lowered threshold because pullbacks in healthy trends often occur on lower volume —
  // requiring 80% was blocking valid trend-following entries. Volume is used as a
  // bonus vote (+1) rather than a hard gate, so below-average-volume setups can still
  // fire when other signals are strong.
  const volOk = ohlcv ? volumeAboveAverage(ohlcv.volumes, 20) : true;

  // RSI divergence bonus votes (adds 1 bonus vote when divergence is detected)
  const bullDiv = rsiBullishDivergence(closes, 14, 15);
  const bearDiv = rsiBearishDivergence(closes, 14, 15);

  // ── Support / Resistance structure bonus votes ───────────────────────────
  // Detect swing highs and swing lows from the last 50 candles.
  // A pivot high = candle whose high is strictly greater than the 2 candles
  // immediately to its left AND right (5-candle pivot window).
  // A pivot low  = candle whose low  is strictly less    than the 2 neighbours.
  // If the current price is within 0.5% of a recent swing HIGH → atResistance (+1 SHORT)
  // If the current price is within 0.5% of a recent swing LOW  → atSupport   (+1 LONG)
  let atSupport    = false;
  let atResistance = false;
  if (ohlcv && ohlcv.highs.length >= 10) {
    const swingWindow = Math.min(50, ohlcv.highs.length);
    const recentHighs = ohlcv.highs.slice(-swingWindow);
    const recentLows  = ohlcv.lows.slice(-swingWindow);
    const PIVOT_SIDE  = 2;          // candles on each side
    const SR_TOL      = 0.005;      // 0.5% proximity tolerance

    const pivotHighs: number[] = [];
    const pivotLows:  number[] = [];

    for (let i = PIVOT_SIDE; i < recentHighs.length - PIVOT_SIDE; i++) {
      const h = recentHighs[i];
      let isPivotHigh = true;
      let isPivotLow  = true;
      for (let j = 1; j <= PIVOT_SIDE; j++) {
        if (recentHighs[i - j] >= h || recentHighs[i + j] >= h) isPivotHigh = false;
        if (recentLows[i - j]  <= recentLows[i] || recentLows[i + j] <= recentLows[i]) isPivotLow = false;
      }
      if (isPivotHigh) pivotHighs.push(h);
      if (isPivotLow)  pivotLows.push(recentLows[i]);
    }

    atResistance = pivotHighs.some(ph => Math.abs(last - ph) / ph <= SR_TOL);
    atSupport    = pivotLows.some (pl => Math.abs(last - pl) / pl <= SR_TOL);
  }

  // Trend mode: direction from regime TF (1h), trigger from 5m pullback
  if (t !== "NONE") {
    const mode: Votes["mode"] = "TREND";

    if (t === "LONG") {
      longVotes += 2; // direction weight (VWAP+slope regime)
      const pullbackOk = recentMin <= 55;    // RSI dipped below mid
      if (pullbackOk) longVotes += 1;
      // triggerOk: classic stoch cross OR momentum continuation.
      // crossUp/leftOS = ideal pullback entry from oversold.
      // momentumOk = stoch K above D and above 40 while RSI had a pullback — valid
      // in strong trends where stoch stays elevated and never revisits OS territory.
      const momentumOk = d != null && k > d && k >= 40 && pullbackOk;
      const triggerOk = crossUp || leftOS || momentumOk;
      if (triggerOk) longVotes += 2;
      const timingOk = rsiRising;
      if (timingOk) longVotes += 1;
      if (bullDiv) longVotes += 1;           // RSI bullish divergence bonus
      if (priceAboveEma20) longVotes += 1;   // above 5m EMA20 (+1 bonus)
      if (volOk) longVotes += 1;             // volume above 60% avg (+1 bonus)
      if (atSupport) longVotes += 1;         // price at swing-low support (+1 bonus)

      const triggerSrc = crossUp ? "crossUp" : leftOS ? "leftOS" : momentumOk ? "momentum" : "none";
      const reason = `Trend LONG (regime). pullbackOk=${pullbackOk} triggerOk=${triggerOk}(${triggerSrc}) rsiRising=${timingOk} ema20gate=${priceAboveEma20} volOk=${volOk} bullDiv=${bullDiv} atSupport=${atSupport} votes=${longVotes}/${required}`;
      decided =
        triggerOk && longVotes >= required && longVotes > shortVotes
          ? "LONG" : "NONE";

      return { decided, votes: { longVotes, shortVotes, required, mode, trendRegime: t, rsiValue: r, stochK: k, stochD: d ?? undefined, reason } };
    }

    if (t === "SHORT") {
      // ═══════════════════════════════════════════════════════════════════════
      // Phase 2 — SHORT Hardening: 5 additional gates before a SHORT fires.
      //
      // Background: March 2026 trade history showed all 3 SHORT trades were
      // regime mis-reads — BTC shorted at the start of a +30% breakout, TAO
      // shorted into a sustained +50% rally.  Root cause: the 1h regime gate
      // (VWAP + EMA slope) has shallow requirements; a 1-bar dip below VWAP
      // while EMA slope briefly flattens is enough to flip to SHORT.  The
      // following 5 gates add orthogonal confirmation so all must agree before
      // a SHORT is entered.
      // ═══════════════════════════════════════════════════════════════════════

      // ── Guard 1: Time-of-day filter ─────────────────────────────────────────
      // Block SHORTs during 00:00–07:59 UTC (Asian session / thin overnight).
      // Crypto historically pumps during Asian hours on low volume — the worst
      // possible environment to hold a short position.
      // Allowed window: 08:00–21:59 UTC (London open through NY close).
      const hourUTC     = new Date().getUTCHours();
      const shortTimeOk = hourUTC >= 8 && hourUTC < 22;

      // ── Guard 2: ADX ≥ 20 (5m chart must have confirmed trend strength) ─────
      // ADX measures how directional a chart is, independent of direction.
      // ADX < 20 = choppy / oscillating → SHORT in this regime = noise trade.
      // ADX 20–25 = emerging downtrend → allowed.
      // ADX ≥ 25 = strong downtrend → ideal.
      // Permissive when OHLCV unavailable (don't block on missing data).
      let adxVal: number | null = null;
      if (ohlcv && ohlcv.highs.length >= 30) {
        const adxResult = adx(ohlcv.highs, ohlcv.lows, ohlcv.closes);
        adxVal = adxResult?.adx ?? null;
      }
      const adxOk = adxVal == null || adxVal >= 20;

      // ── Guard 3: EMA stack alignment (5m bearish stack) ─────────────────────
      // Require 5m EMA20 < EMA50 (short MA below long MA = confirmed bearish
      // structure at the entry timeframe).  EMA20 above EMA50 on 5m means the
      // entry TF is still in an uptrend — shorting against it has historically
      // produced the March "caught in a breakout" losses.
      const e50_5m       = ema(closes, 50);
      const emaStackShort = e50_5m != null && e20_5m != null && e20_5m < e50_5m;

      // ── Guard 4: ATR expansion guard ────────────────────────────────────────
      // Block SHORT when the current 5m ATR is > 130% of its recent 5-bar
      // average.  Expanding ATR = breakout / momentum surge in progress.
      // Shorting into an ATR expansion is the highest-risk scenario:
      // the price is moving fast in SOME direction and the direction is
      // ambiguous until the candle closes — whichever way it resolves, a
      // short entry into expanding volatility faces wide slippage and
      // immediate stop-loss risk.
      let atrExpanding = false;
      {
        const atrNow = atrClose(closes, 14);
        if (atrNow != null) {
          const prevAtrs: number[] = [];
          for (let i = 1; i <= 5; i++) {
            const a = atrClose(closes.slice(0, closes.length - i), 14);
            if (a != null) prevAtrs.push(a);
          }
          if (prevAtrs.length >= 3) {
            const atrAvg = prevAtrs.reduce((a, b) => a + b, 0) / prevAtrs.length;
            atrExpanding = atrNow > atrAvg * 1.30;   // 30% above recent average
          }
        }
      }
      const atrGuardOk = !atrExpanding;

      // ── Guard 5: Vote threshold (same as LONG) ──────────────────────────────
      // SHORT uses same threshold as LONG (VOTE_REQUIRED = 5).
      // The signal quality guards (EMA stack, ADX, ATR, session) already
      // filter low-quality shorts — no need for an extra vote penalty.
      const shortRequired = required;

      // ── Existing vote accumulation (unchanged) ─────────────────────────────
      shortVotes += 2;                              // direction weight (VWAP+slope regime)
      const pullbackOk = recentMax >= 45;           // RSI rose above mid
      if (pullbackOk) shortVotes += 1;
      const momentumOk = d != null && k < d && k <= 60 && pullbackOk;
      const triggerOk  = crossDown || leftOB || momentumOk;
      if (triggerOk) shortVotes += 2;
      const timingOk = rsiFalling;
      if (timingOk) shortVotes += 1;
      if (bearDiv) shortVotes += 1;                // RSI bearish divergence bonus
      if (priceBelowEma20) shortVotes += 1;        // below 5m EMA20 (+1 bonus)
      if (volOk) shortVotes += 1;                  // volume above 60% avg (+1 bonus)
      if (atResistance) shortVotes += 1;            // price at swing-high resistance (+1 bonus)

      const triggerSrc = crossDown ? "crossDown" : leftOB ? "leftOB" : momentumOk ? "momentum" : "none";
      const reason =
        `Trend SHORT. pullbackOk=${pullbackOk} triggerOk=${triggerOk}(${triggerSrc}) ` +
        `rsiFalling=${timingOk} ema20=${priceBelowEma20} ` +
        `emaStack=${emaStackShort} adx=${adxVal != null ? adxVal.toFixed(1) : "n/a"}(ok=${adxOk}) ` +
        `atrExpanding=${atrExpanding}(ok=${atrGuardOk}) timeOk=${shortTimeOk} ` +
        `volOk=${volOk} bearDiv=${bearDiv} atResistance=${atResistance} ` +
        `votes=${shortVotes}/${shortRequired}`;

      decided =
        triggerOk          &&
        shortVotes >= shortRequired &&
        shortVotes > longVotes &&
        emaStackShort      &&   // Guard 3: 5m EMA stack is bearish
        adxOk              &&   // Guard 2: ADX ≥ 20 (or unavailable)
        atrGuardOk         &&   // Guard 4: ATR not expanding
        shortTimeOk             // Guard 1: London/NY session only
          ? "SHORT"
          : "NONE";

      return { decided, votes: { longVotes, shortVotes, required: shortRequired, mode, trendRegime: t, rsiValue: r, stochK: k, stochD: d ?? undefined, reason } };
    }
  }

// -------- RANGE mode: only when regime trend NONE --------
{
  const mode: Votes["mode"] = "RANGE";

  const bullRejection = last > prev;
  const bearRejection = last < prev;

  const longLocationOk = (nearSupport || touchLowerBB) && r <= 35;
  const shortLocationOk = (nearResistance || touchUpperBB) && r >= 65;

  const longTriggerOk = (crossUp || leftOS) && bullRejection;
  const shortTriggerOk = (crossDown || leftOB) && bearRejection;

  const rangeLong = longLocationOk && longTriggerOk;
  const rangeShort = shortLocationOk && shortTriggerOk;

  // Range fires at full strength (5 votes) when all conditions met
  longVotes = rangeLong ? 5 : 0;
  shortVotes = rangeShort ? 5 : 0;

  decided =
    rangeLong && longVotes >= required && longVotes > shortVotes ? "LONG"
    : rangeShort && shortVotes >= required && shortVotes > longVotes ? "SHORT"
    : "NONE";

  const reason =
    `Range (regime NONE). longLoc=${longLocationOk} longTrig=${longTriggerOk} ` +
    `shortLoc=${shortLocationOk} shortTrig=${shortTriggerOk} ` +
    `nearSup=${nearSupport} touchLB=${touchLowerBB} nearRes=${nearResistance} touchUB=${touchUpperBB} ` +
    `rsi=${r.toFixed(2)} crossUp=${crossUp} leftOS=${leftOS} crossDown=${crossDown} leftOB=${leftOB}`;

  return {
    decided,
    votes: {
      longVotes,
      shortVotes,
      required,
      mode,
      trendRegime: "NONE",
      rsiValue: r,
      stochK: k,
      stochD: d ?? undefined,
      reason,
    },
  };
 }
}

// =======================
// EXPORT: runner entrypoint
// =======================
export async function evaluateUserSymbol(
  deps: EngineDeps & { redis?: any },
  args: { userKey: UserKey; symbol: string; timeframe: string; requestedLeverage?: number }
) {
  const { userKey, symbol, timeframe, requestedLeverage } = args;
  
  log.debug({ symbol, timeframe }, "[botWorker] evaluateUserSymbol");

  // 1) Load OHLCV candles for this symbol/timeframe (includes volume for VWAP + volume filter)
  let ohlcv: BinanceOHLCV | undefined;
  let closes: number[];
  try {
    ohlcv  = await fetchBinanceOHLCV({ symbol, interval: timeframe, limit: 200 });
    closes = ohlcv.closes;
  } catch {
    // Fallback to closes-only if OHLCV fails
    const candleRes = await fetchBinanceCloses({ symbol, interval: timeframe, limit: 200, withTimestamps: true });
    closes = Array.isArray(candleRes) ? candleRes : candleRes.closes;
    ohlcv  = undefined;
  }


  if (closes.length < 60) return;

  const last = closes[closes.length - 1]!;
  const priceWad = toWad(last);


  // 2) Config (admin-tunable via Redis)
  const cfg = deps.redis ? await loadUserConfig(deps.redis, userKey) : DEFAULT_CFG;

  // 3) Exit evaluation (5m only) if we have an active trade tracked locally
  const pk = posKeyOf(userKey, symbol);
  const t = activeTrades.get(pk);

  if (timeframe === "5m" && t && !t.pending && !t.closing) {
    // ── Regime-flip exit ────────────────────────────────────────────────────
    // If the 1h regime has flipped AGAINST the open position, close immediately.
    // Rationale: the entry was taken with a LONG regime signal. If the 1h EMA
    // regime is now SHORT, the position is contra-trend — holding it means
    // waiting for the stop-loss to fire at -10% while the market trends down.
    // Closing at the regime flip captures whatever residual value remains and
    // frees capital for a SHORT entry in the correct direction.
    const currentRegime = trendRegime.get(`${userKey}:${symbol}`);
    // Minimum hold time before regime-flip can trigger (60 seconds).
    // Prevents entering a LONG on a 5m signal and immediately closing it
    // 10 seconds later when the 1h regime updates to SHORT — wasted gas fees.
    const heldMs = Date.now() - t.openedAtMs;
    const MIN_HOLD_MS = 60_000; // 60 seconds

    const isContraRegime =
      heldMs >= MIN_HOLD_MS &&
      currentRegime != null && currentRegime.dir !== "NONE" &&
      ((t.isLong && currentRegime.dir === "SHORT") ||
       (!t.isLong && currentRegime.dir === "LONG"));

    if (isContraRegime) {
      t.closing = true;
      emit(deps, {
        type: "EXIT_SIGNAL", userKey, symbol, timeframe,
        reason: "regime_flip",
        regimeDir: currentRegime.dir,
        tradeDir: t.isLong ? "LONG" : "SHORT",
      });
      try {
        await deps.closePosition({ userKey, symbol, timeframe, exitPriceWad: priceWad });
      } catch (closeErr: any) {
        if (String(closeErr?.message ?? "").includes("no open pos")) {
          activeTrades.delete(pk);
          if (deps.redis) deleteActiveTrade(deps.redis, userKey, symbol).catch(() => {});
          emit(deps, { type: "GHOST_TRADE_CLEARED", userKey, symbol, timeframe });
          return;
        }
        t.closing = false;
        throw closeErr;
      }
      const exitPrice  = Number(priceWad) / 1e18;
      const entryPrice = Number(t.entryPriceWad) / 1e18;
      const rawMove    = t.isLong ? (exitPrice - entryPrice) / entryPrice : (entryPrice - exitPrice) / entryPrice;
      activeTrades.delete(pk);
      if (deps.redis) {
        deleteActiveTrade(deps.redis, userKey, symbol).catch(() => {});
        appendClosedTrade(deps.redis, userKey, {
          symbol, isLong: t.isLong, entryPrice, exitPrice,
          pnlPct: rawMove, leverage: t.leverage,
          durationMs: Date.now() - t.openedAtMs,
          reason: "regime_flip", closedAt: Date.now(),
        }).catch(() => {});
        recordDailyReturn(deps.redis, userKey, rawMove * t.leverage).catch(() => {});
      }
      if (deps.redis) await applyCooldown(deps.redis, userKey, symbol, cfg);
      emit(deps, { type: "POSITION_CLOSED", userKey, symbol, timeframe, pnlPct: rawMove * t.leverage, reason: "regime_flip" });
      return;
    }

    // Compute live ATR% for Tier 2 dynamic stop (40×–100×)
    const atrValExit = atrClose(closes, cfg.ATR_PERIOD);
    const liveAtrPct = atrValExit != null ? atrValExit / last : 0;

    // Derive candle extreme for trailing-stop advancement.
    // HIGH (LONG) / LOW (SHORT) from the latest completed kline captures intra-candle
    // peaks that the close price alone would miss — e.g. BTC spikes to +9% lev
    // mid-candle then closes at +4.5% lev; using the HIGH ensures bestPriceWad
    // is anchored at the +9% level so the 3% trail fires correctly at +6%.
    const candleExtreme: Wad | undefined = ohlcv
      ? toWad(t.isLong
          ? ohlcv.highs[ohlcv.highs.length - 1]
          : ohlcv.lows[ohlcv.lows.length - 1])
      : undefined;

    // ── Trailing-stop minimum hold time ─────────────────────────────────────
    // Prevent the profit-reversal trailing stop from EXITING in the first 60 s.
    // bestPriceWad is still advanced during the hold window (see updateBest call
    // below) so any peak that occurs in the first 60 s is captured and used the
    // moment trailReady flips true.
    // The hard stop-loss (rawMove ≤ -stop) is still allowed to fire at any age —
    // those protect against sudden crashes where waiting 60 s is dangerous.
    const trailHeldMs   = Date.now() - t.openedAtMs;
    const MIN_TRAIL_MS  = 60_000; // 60 seconds
    const trailReady    = trailHeldMs >= MIN_TRAIL_MS;

    // Always advance bestPriceWad from the kline extreme, even during the hold window.
    // Peaks that occur in the first 60 s are now tracked correctly so the trailing
    // floor is ready the moment the hold window expires.  The trailing EXIT itself
    // is still gated by trailReady (and the fast monitor has its own 60 s guard),
    // so no premature exits can happen — we just stop losing peak information.
    updateBest(t, candleExtreme ?? priceWad);

    const rawMoveCheck  = movePctWad(t, priceWad);
    const rawStopImm    = t.leverage >= 40
      ? Math.max(0.005, Math.min(0.008, 0.30 / t.leverage))
      : cfg.STOP_LOSS_PCT;
    const hardStopNow   = rawMoveCheck <= -toWad(rawStopImm);

    // advanceBestPrice=false: bestPriceWad already updated above; pass false so
    // shouldExit does not attempt a redundant second advance.
    if (hardStopNow || (trailReady && shouldExit(t, priceWad, cfg, liveAtrPct, false, candleExtreme))) {
      t.closing = true; // guard: prevents fast-exit monitor from double-closing
      emit(deps, { type: "EXIT_SIGNAL", userKey, symbol, timeframe, reason: "risk_exit" });

      try {
        await deps.closePosition({ userKey, symbol, timeframe, exitPriceWad: priceWad });
      } catch (closeErr: any) {
        // "no open pos" means the position was already closed externally (ghost trade).
        // Clean up our internal state silently instead of propagating a SCAN_ERROR.
        if (String(closeErr?.message ?? "").includes("no open pos")) {
          log.warn({ symbol }, "[botWorker] ghost trade detected (no open pos on-chain) — clearing local state");
          activeTrades.delete(pk);
          if (deps.redis) deleteActiveTrade(deps.redis, userKey, symbol).catch(() => {});
          emit(deps, { type: "GHOST_TRADE_CLEARED", userKey, symbol, timeframe });
          return;
        }
        throw closeErr; // re-throw all other errors (tx failure, network, etc.)
      }

      // Capture PnL before deleting (for performance history)
      const exitPrice = Number(priceWad) / 1e18;
      const entryPrice = Number(t.entryPriceWad) / 1e18;
      const rawMove = t.isLong
        ? (exitPrice - entryPrice) / entryPrice
        : (entryPrice - exitPrice) / entryPrice;

      activeTrades.delete(pk);
      // Remove from Redis
      if (deps.redis) {
        deleteActiveTrade(deps.redis, userKey, symbol).catch(() => {});
        // Record closed trade for performance tracking
        appendClosedTrade(deps.redis, userKey, {
          symbol, isLong: t.isLong, entryPrice, exitPrice,
          pnlPct: rawMove, leverage: t.leverage,
          durationMs: Date.now() - t.openedAtMs,
          reason: "risk_exit", closedAt: Date.now(),
        }).catch(() => {});

        // ── Phase 3a: Update daily drawdown tracker ────────────────────────
        recordDailyReturn(deps.redis, userKey, rawMove * t.leverage).catch(() => {});

        // ── Phase 3b: Record AI outcome (online learning) ──────────────────
        const fk = entryFeatureKeys.get(pk);
        if (fk) {
          recordTradeOutcome(deps.redis, fk, rawMove > 0).catch(() => {});
          entryFeatureKeys.delete(pk);
        }
      }

      // Apply cooldown after closing
      if (deps.redis) await applyCooldown(deps.redis, userKey, symbol, cfg);
      recordAct(pk);

      // Emit leveraged PnL (matches what dashboard shows: rawMove × leverage)
      emit(deps, { type: "POSITION_CLOSED", userKey, symbol, timeframe, pnlPct: rawMove * t.leverage });
      return;
    }

    // Position still open — persist confirmed bestPriceWad and pendingBestWad to Redis
    // so restarts correctly restore the 2-phase trailing stop state.
    if (deps.redis) {
      const snapshot: CachedTrade = {
        userKey: t.userKey, symbol: t.symbol, timeframe: t.timeframe,
        isLong: t.isLong, leverage: t.leverage,
        entryPriceWad:  t.entryPriceWad.toString(),
        bestPriceWad:   t.bestPriceWad.toString(),
        pendingBestWad: t.pendingBestWad.toString(),
        sizeWad:        t.sizeWad.toString(),
        openedAtMs: t.openedAtMs, pending: t.pending,
      };
      saveActiveTrade(deps.redis, userKey, symbol, snapshot).catch(() => {});
    }
  }

  // 4) Regime timeframe update (any non-5m, e.g. 1h) — votes only, no entry
  if (timeframe !== "5m") {
    const out = computeVotesFork(deps, closes, userKey, symbol, timeframe, cfg, ohlcv);
    if (!out) return;
    emit(deps, { type: "VOTES", userKey, symbol, timeframe, decided: out.decided, votes: out.votes });
    return;
  }

  // 5) 5m: run entry logic (this also emits VOTES internally)
  if (timeframe === "5m") {
    await maybeEnterTrade({
      deps,
      userKey,
      symbol,
      timeframe,
      closes,
      priceWad,
      requestedLeverage,
      cfg,
      ohlcv,
    });
  }
}

  // ENTRY (this worker only enters on 5m; regime TFs are handled above)
  async function maybeEnterTrade(args: {
  deps: EngineDeps;
  userKey: UserKey;
  symbol: string;
  timeframe: string;           // "5m"
  closes: number[];
  priceWad: Wad;
  requestedLeverage?: number;
  cfg?: BotConfig;
  ohlcv?: BinanceOHLCV;
}) {
  const { deps, userKey, symbol, timeframe, closes, priceWad, requestedLeverage, ohlcv } = args;

  // Config already loaded upstream (from evaluateUserSymbol); use passed cfg or reload
  const cfg = args.cfg ?? (deps.redis ? await loadUserConfig(deps.redis, userKey) : DEFAULT_CFG);

  const pk = posKeyOf(userKey, symbol);

  // ── Leverage resolved early — needed for tier-aware ATR gate below ──────────
  const leverage = pickLeverage(requestedLeverage, cfg, symbol);

  // ── ATR Volatility Filter — tier-aware ──────────────────────────────────────
  // Tier 1 (10×–30×): gate at cfg.ATR_VOLATILITY_THRESHOLD (default 0.5%)
  // Tier 2 (40×–100×): stricter gate at 60% of threshold (≈0.3%)
  //   → prevents high-leverage entries during dumps/pumps
  const last = closes[closes.length - 1]!;
  const atrVal = atrClose(closes, cfg.ATR_PERIOD);
  const atrPct = atrVal != null ? atrVal / last : 0;
  const atrGate = leverage >= 40
    ? cfg.ATR_VOLATILITY_THRESHOLD * 0.6   // ~0.3% for Tier 2
    : cfg.ATR_VOLATILITY_THRESHOLD;         //  0.5% for Tier 1
  if (atrPct > atrGate) {
    emit(deps, {
      type: "ATR_BLOCKED",
      userKey,
      symbol,
      timeframe,
      atrPct: Number(atrPct.toFixed(5)),
      threshold: atrGate,
      tier: leverage >= 40 ? 2 : 1,
      reason: `ATR% ${(atrPct * 100).toFixed(3)}% > Tier ${leverage >= 40 ? 2 : 1} threshold ${(atrGate * 100).toFixed(2)}% — skipping entry`,
    });
    return;
  }

  // Optional Redis cooldown (preferred). Fallback to in-memory cooldown.
  if (deps.redis) {
    const cd = await cooldownBlocksEntry(deps.redis, userKey, symbol);
    if (cd.blocked) return;
  } else {
    if (!canAct(pk, cfg)) return;
  }

  const out = computeVotesFork(deps, closes, userKey, symbol, timeframe, cfg, ohlcv);
  if (!out) return;

  emit(deps, { type: "VOTES", userKey, symbol, timeframe, decided: out.decided, votes: out.votes, atrPct });

  if (out.decided === "NONE") return;
  if (activeTrades.has(pk)) return;

  // leverage already resolved above (needed for ATR gate)
  const isLong = out.decided === "LONG";

  const vaultBal = await deps.getVaultBalanceWad({ userKey, symbol, isLong });

  // ── Position sizing ─────────────────────────────────────────────────────────
  // Two modes controlled by cfg.MANUAL_SIZE_PCT:
  //
  //  AUTO (MANUAL_SIZE_PCT === 0)  ← default
  //    Base collateral = 15% of vault, ATR-scaled:
  //      Tier 1 (10×–30×): atrScale = clamp(0.3%/ATR, 0.5×, 2.0×)  → 7.5%–30% collateral
  //      Tier 2 (40×–100×): atrScale = clamp(0.3%/ATR, 0.5×, 1.0×) → 7.5%–15% collateral
  //        (ATR scale capped at 1.0× for high leverage — never size up at 40×+)
  //    sizeWad = vaultBal × 15% × atrScale × leverage
  //    Max 3 concurrent: Tier 1 worst-case 3×30% = 90% ✅, Tier 2 worst-case 3×15% = 45% ✅
  //
  //  MANUAL (MANUAL_SIZE_PCT > 0)
  //    Fixed % of vault, ATR-scaling bypassed.
  //    sizeWad = vaultBal × MANUAL_SIZE_PCT × leverage
  // ───────────────────────────────────────────────────────────────────────────
  let sizeWad: bigint;
  let sizingMode: string;

  if (cfg.MANUAL_SIZE_PCT > 0) {
    // Manual sizing: fixed % of vault
    sizeWad    = mulWad(mulWad(vaultBal, toWad(cfg.MANUAL_SIZE_PCT)), toWad(leverage));
    sizingMode = `manual ${(cfg.MANUAL_SIZE_PCT * 100).toFixed(1)}%`;
  } else {
    // Auto ATR-scaled sizing — 15% vault base
    const TARGET_ATR_PCT = 0.003; // 0.3% baseline ATR (medium-volatility crypto)
    // Tier 2 caps ATR scale at 1.0× — never size up at 40×+ leverage
    const maxAtrScale = leverage >= 40 ? 1.0 : 2.0;
    const atrScale = atrPct > 0
      ? Math.min(maxAtrScale, Math.max(0.5, TARGET_ATR_PCT / atrPct))
      : 1.0;
    const riskPct     = toWad(0.15);                              // 15% base (up from 1%)
    const riskCapital = mulWad(vaultBal, riskPct);
    sizeWad    = mulWad(mulWad(riskCapital, toWad(leverage)), toWad(atrScale));
    const tier = leverage >= 40 ? "T2" : "T1";
    sizingMode = `auto ${tier} ATR×${atrScale.toFixed(2)} (${(0.15 * atrScale * 100).toFixed(1)}% vault)`;
  }

  log.debug(
    { symbol, leverage, sizingMode,
      atrPct: atrPct.toFixed(5),
      vaultBal: vaultBal.toString(), sizeWad: sizeWad.toString() },
    "[botWorker] sizing"
  );

if (sizeWad <= 0n) {

    emit(deps, { type: "ENTRY_BLOCKED", userKey, symbol, timeframe, reason: "Size is zero (vault too low)" });
    return;
  }

  const trade: ActiveTrade = {
    userKey,
    symbol,
    timeframe,
    isLong,
    leverage,
    entryPriceWad:  priceWad,
    bestPriceWad:   priceWad,
    pendingBestWad: priceWad, // starts at entry; advances via 2-phase confirmation
    sizeWad,
    openedAtMs: Date.now(),
    pending: true,
    closing: false,
  };

  // NOTE: do NOT set activeTrades before calling executeTrade.
  // The scan phase intercepts executeTrade (returns {paper:true}) so if we
  // set activeTrades here it would block the real execute phase that follows.
  // We only register the trade after a confirmed real on-chain execution.

  emit(deps, {
    type: "ENTRY_SIGNAL",
    userKey,
    symbol,
    timeframe,
    side: out.decided,
    leverage,
    sizeWad: sizeWad.toString(),
    entryPriceWad: priceWad.toString(),
    votes: out.votes,
  });

  try {
    const result = await deps.executeTrade({ userKey, symbol, timeframe, isLong, leverage, sizeWad, entryPriceWad: priceWad });

    // Contract-level cooldown guard: vault returned cooldown still active — skip silently.
    if ((result as any)?.skipped) {
      log.debug({ symbol, reason: (result as any).reason }, "[botWorker] entry skipped (contract cooldown)");
      return;
    }

    // Only register as an active tracked trade if this was a real on-chain tx
    // (scan phase returns {paper:true,intercepted:true} — skip those).
    if (!result?.paper) {
      trade.pending = false;
      activeTrades.set(pk, trade);
      // Persist to Redis immediately so a crash won't lose the position
      if (deps.redis) {
        const cached: CachedTrade = {
          userKey: trade.userKey, symbol: trade.symbol, timeframe: trade.timeframe,
          isLong: trade.isLong, leverage: trade.leverage,
          entryPriceWad:  trade.entryPriceWad.toString(),
          bestPriceWad:   trade.bestPriceWad.toString(),
          pendingBestWad: trade.pendingBestWad.toString(),
          sizeWad:        trade.sizeWad.toString(),
          openedAtMs: trade.openedAtMs, pending: false,
        };
        saveActiveTrade(deps.redis, userKey, symbol, cached).catch(() => {});
        await applyCooldown(deps.redis, userKey, symbol, cfg);

        // ── Phase 3: Capture AI feature key for this entry ─────────────────
        // Stored in-memory keyed by posKey; retrieved on close to record outcome.
        const features = extractFeatures(out.votes, atrPct);
        const aiKey    = featureKey(features, out.decided as "LONG" | "SHORT");
        entryFeatureKeys.set(pk, aiKey);

        // Log AI score at time of entry (informational — not blocking)
        getAiScore(deps.redis, features, out.decided as "LONG" | "SHORT")
          .then(ai => {
            if (ai.total > 0) {
              log.info(
                { symbol, aiKey, winRate: ai.bayesianWinRate.toFixed(2),
                  confidence: ai.confidence.toFixed(2), bonus: ai.bonus.toFixed(3), total: ai.total },
                "[botWorker] AI entry score"
              );
            }
          })
          .catch(() => {});
      } else {
        recordAct(pk);
      }
    }

    // Only emit POSITION_OPENED for real on-chain trades.
    // Paper/scan-phase candidates (result.paper === true) are not real positions.
    if (!result?.paper) {
      emit(deps, { type: "POSITION_OPENED", userKey, symbol, timeframe, side: out.decided, leverage, result });
    }
  } catch (e: any) {
    // activeTrades was never set, so no cleanup needed
    emit(deps, { type: "ENTRY_FAILED", userKey, symbol, timeframe, side: out.decided, leverage, error: e?.message ?? String(e) });
    throw e;
  }
}
