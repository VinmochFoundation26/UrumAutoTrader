/**
 * priceStream.ts — Binance USD-M Futures WebSocket price feed
 *
 * Connects to Binance's combined bookTicker stream for all configured symbols.
 * Pushes on every best-bid/ask change — effectively real-time (10–50× per second
 * for active symbols like ETHUSDT). This replaces the old miniTicker stream which
 * only updated once per second and caused ~$8 exit slippage on fast ETH reversals.
 *
 * Price used = mid-price (bid + ask) / 2, which closely tracks the last trade price.
 *
 * This replaces REST polling for real-time price reads (exit monitor, dashboard proxy).
 * Historical candle REST calls (fetchBinanceCloses) are unchanged — WS is for latest price only.
 *
 * Usage:
 *   startPriceStream(["BTCUSDT", "ETHUSDT"]);
 *   const price = getLatestPrice("BTCUSDT");  // number | null
 *   updateStreamSymbols(["BTCUSDT", "ETHUSDT", "TAOUSDT"]);  // hot-add symbol
 */

import WebSocket from "ws";
import { log } from "../../logger.js";

type PriceEntry = {
  price: number;
  ts: number;    // ms timestamp of last update
};

// Module-level price cache — read by getLatestPrice() anywhere in the process
const priceCache = new Map<string, PriceEntry>();

let ws: WebSocket | null = null;
let currentSymbols: string[] = [];
let reconnectTimer: NodeJS.Timeout | null = null;
let stopped = false;

const STALE_THRESHOLD_MS = 5_000;   // price older than 5s → treat as stale
const BASE_RECONNECT_MS  = 2_000;   // initial reconnect delay
const MAX_RECONNECT_MS   = 30_000;  // cap backoff at 30s

let reconnectAttempts = 0;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start the WebSocket price feed for the given symbols.
 * Safe to call multiple times — reconnects if already connected.
 */
export function startPriceStream(symbols: string[]): void {
  stopped = false;
  currentSymbols = symbols.map((s) => s.toUpperCase());
  reconnectAttempts = 0;
  connect();
}

/**
 * Gracefully stop the price stream (e.g. on bot shutdown).
 */
export function stopPriceStream(): void {
  stopped = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { ws.terminate(); ws = null; }
  log.info("[priceStream] stopped");
}

/**
 * Update the symbol list and reconnect to add/remove streams.
 * Call when symbols change via /bot/set.
 */
export function updateStreamSymbols(symbols: string[]): void {
  currentSymbols = symbols.map((s) => s.toUpperCase());
  if (ws) { ws.terminate(); ws = null; }  // will auto-reconnect with new symbols
}

/**
 * Get the latest price for a symbol.
 * Returns null if:
 *   - Symbol not in stream
 *   - No update received yet
 *   - Last update is older than STALE_THRESHOLD_MS
 */
export function getLatestPrice(symbol: string): number | null {
  const entry = priceCache.get(symbol.toUpperCase());
  if (!entry) return null;
  if (Date.now() - entry.ts > STALE_THRESHOLD_MS) return null;
  return entry.price;
}

/**
 * Get all cached prices (symbol → price). Only fresh entries included.
 */
export function getAllPrices(): Record<string, number> {
  const now = Date.now();
  const result: Record<string, number> = {};
  for (const [sym, entry] of priceCache) {
    if (now - entry.ts <= STALE_THRESHOLD_MS) result[sym] = entry.price;
  }
  return result;
}

// ── Internal connection logic ─────────────────────────────────────────────────

function buildWsUrl(symbols: string[]): string {
  // bookTicker: pushes on every best-bid/ask change (real-time, ~10–50×/s per symbol).
  // Previously used @miniTicker (once per second), which caused the fast exit monitor
  // to miss rapid price drops — e.g. ETH falling $8 in 1 second while the monitor
  // only sampled the price at T=0s and T=1s, missing the 5% gate crossing in between.
  const streams = symbols
    .map((s) => `${s.toLowerCase()}@bookTicker`)
    .join("/");
  return `wss://fstream.binance.com/stream?streams=${streams}`;
}

function connect(): void {
  if (stopped || !currentSymbols.length) return;

  const url = buildWsUrl(currentSymbols);
  log.info({ symbols: currentSymbols }, "[priceStream] connecting to Binance WS");

  ws = new WebSocket(url);

  ws.on("open", () => {
    reconnectAttempts = 0;
    log.info({ symbols: currentSymbols }, "[priceStream] connected ✓");
  });

  ws.on("message", (raw: Buffer | string) => {
    try {
      const data = JSON.parse(raw.toString());
      // Combined stream format: { stream: "btcusdt@bookTicker", data: { s, b, a, ... } }
      // bookTicker fields: s=symbol, b=bestBid, B=bidQty, a=bestAsk, A=askQty
      const ticker = data?.data ?? data;
      if (!ticker?.s || !ticker?.b || !ticker?.a) return;

      // Mid-price = (bid + ask) / 2 — tracks last trade price within a fraction of a cent.
      // Using mid rather than bid prevents the exit monitor from seeing an artificially
      // low price (bid is always slightly below last trade) which could fire exits early.
      const mid = (Number(ticker.b) + Number(ticker.a)) / 2;
      if (!Number.isFinite(mid) || mid <= 0) return;

      priceCache.set(ticker.s as string, {
        price: mid,
        ts: Date.now(),
      });
    } catch {
      // Ignore malformed frames
    }
  });

  ws.on("ping", (data) => {
    // Respond to server pings to keep connection alive
    ws?.pong(data);
  });

  ws.on("close", (code, reason) => {
    log.warn({ code, reason: reason?.toString() }, "[priceStream] WS closed");
    ws = null;
    if (!stopped) scheduleReconnect();
  });

  ws.on("error", (err: Error) => {
    log.warn({ err: err.message }, "[priceStream] WS error");
    // 'close' event fires after 'error', reconnect handled there
  });
}

function scheduleReconnect(): void {
  if (stopped || reconnectTimer) return;
  reconnectAttempts++;
  const delay = Math.min(BASE_RECONNECT_MS * Math.pow(1.5, reconnectAttempts - 1), MAX_RECONNECT_MS);
  log.info({ attempt: reconnectAttempts, delayMs: Math.round(delay) }, "[priceStream] reconnecting");
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}
