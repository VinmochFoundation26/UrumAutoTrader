import type http from "node:http";
import { log } from "../../logger.js";
import { getRedis } from "../cache/redis.js";
import { appendEvent as redisPushEvent, loadEventHistory } from "../cache/tradeCache.js";

export type BotEvent = Record<string, any>;

export type StrategyMode = "votes" | "filters_triggers" | "premium";

export type TriggerConfig = {
  stochOS: number;
  stochOB: number;
  stochMid: number;
  stochDLen: number;
};

type Store = {
  running: boolean;
  startedAt?: number;
  strategy?: StrategyMode;
  trigger?: TriggerConfig;
  lastEvent?: BotEvent;
  lastVotesByKey: Record<string, BotEvent>;
  lastError?: { ts: number; message: string };
  eventHistory: BotEvent[];   // in-memory ring buffer (fast reads)
};

const store: Store = {
  running: false,
  lastVotesByKey: {},
  eventHistory: [],
};

// ── SSE subscribers ───────────────────────────────────────────────────────────

const sseClients = new Set<http.ServerResponse>();

export function addSseClient(res: http.ServerResponse) {
  sseClients.add(res);
  res.on("close", () => sseClients.delete(res));
}

function broadcastSse(event: BotEvent) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch { sseClients.delete(res); }
  }
}

// ── State mutators ────────────────────────────────────────────────────────────

export function setRunning(running: boolean) {
  store.running = running;
  if (running) store.startedAt = Date.now();
  else store.startedAt = undefined;
}

export function setConfig(cfg: { strategy?: StrategyMode; trigger?: TriggerConfig }) {
  if (cfg.strategy) store.strategy = cfg.strategy;
  if (cfg.trigger) store.trigger = cfg.trigger;
}

export function recordEvent(e: BotEvent) {
  store.lastEvent = e;

  // In-memory ring buffer — last 500 events for fast SSE replay
  store.eventHistory.push(e);
  if (store.eventHistory.length > 100) store.eventHistory.shift();

  // Persist to Redis (fire-and-forget — never block SSE broadcast)
  redisPushEvent(getRedis(), e).catch(() => {/* Redis errors already logged inside */});

  // Broadcast to live SSE clients
  broadcastSse(e);

  // Track latest vote per symbol:timeframe for dashboard display
  if (e?.type === "VOTES" && e?.userKey && e?.symbol && e?.timeframe) {
    const k = `${e.userKey}:${e.symbol}:${e.timeframe}`;
    store.lastVotesByKey[k] = e;
  }

  // Auto-extract strategy/trigger config if embedded in event
  if (typeof e?.strategy === "string") {
    const s = e.strategy as StrategyMode;
    if (s === "votes" || s === "filters_triggers" || s === "premium") store.strategy = s;
  }
  if (e?.trigger && typeof e.trigger === "object") {
    const t = e.trigger as Partial<TriggerConfig>;
    const merged: TriggerConfig = {
      stochOS:  Number.isFinite(t.stochOS  as number) ? (t.stochOS  as number) : (store.trigger?.stochOS  ?? 20),
      stochOB:  Number.isFinite(t.stochOB  as number) ? (t.stochOB  as number) : (store.trigger?.stochOB  ?? 80),
      stochMid: Number.isFinite(t.stochMid as number) ? (t.stochMid as number) : (store.trigger?.stochMid ?? 50),
      stochDLen:Number.isFinite(t.stochDLen as number) ? (t.stochDLen as number): (store.trigger?.stochDLen ?? 3),
    };
    store.trigger = merged;
  }

  if (e?.type?.endsWith?.("FAILED") || e?.type === "EXIT_FAILED") {
    store.lastError = { ts: Date.now(), message: e?.error ?? "unknown error" };
  }
}

export function recordError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  store.lastError = { ts: Date.now(), message: msg };
  log.warn({ err: msg }, "[state] error recorded");
}

export function getState() {
  return store;
}

export function getEventHistory() {
  return store.eventHistory;
}

/**
 * Restore event history from Redis into the in-memory ring buffer.
 * Call once at server startup so dashboard immediately shows recent events.
 */
export async function restoreEventHistory(): Promise<void> {
  try {
    const events = await loadEventHistory(getRedis());
    // Keep only the last 500 to match ring buffer size
    const tail = events.slice(-500);
    store.eventHistory = tail;
    log.info({ count: tail.length }, "[state] event history restored from Redis");
  } catch (e: any) {
    log.warn({ err: e?.message }, "[state] could not restore event history from Redis");
  }
}
