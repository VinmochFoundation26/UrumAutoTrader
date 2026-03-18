/**
 * redis.ts — ioredis singleton with auto-reconnect
 *
 * A single Redis client is shared across the entire process.
 * Uses lazy connect so the module can be imported freely — connection
 * only opens when connectRedis() is called at server boot.
 *
 * Env:
 *   REDIS_URL — default "redis://localhost:6379"
 */

import { Redis } from "ioredis";
import { log } from "../../logger.js";

let _client: Redis | null = null;

export function getRedis(): Redis {
  if (_client) return _client;

  _client = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    retryStrategy: (times: number) => Math.min(times * 200, 5_000), // exponential backoff, cap 5s
    // NOTE: do NOT set reconnectOnError — it fires on every command error (not just
    // connection errors) and causes a rapid reconnect storm when Redis is busy.
    // ioredis built-in retryStrategy handles connection drops automatically.
    enableOfflineQueue: true,                                         // queue commands while reconnecting
    keepAlive: 10_000,                                                // TCP keepalive every 10s
  });

  _client.on("connect", () => log.info("[redis] connected"));
  _client.on("ready",   () => log.info("[redis] ready"));
  _client.on("error",   (e: Error) => log.warn({ err: e.message }, "[redis] error"));
  _client.on("close",   () => log.warn("[redis] connection closed"));
  _client.on("reconnecting", () => log.info("[redis] reconnecting..."));

  return _client;
}

/**
 * Open the Redis connection. Call once at server startup.
 * Safe to call multiple times — resolves immediately if already connected.
 */
export async function connectRedis(): Promise<void> {
  const r = getRedis();
  if (r.status === "ready") return;
  await r.connect();
}

/**
 * Graceful shutdown — flushes pending commands and closes connection.
 * Call in SIGTERM handler.
 */
export async function disconnectRedis(): Promise<void> {
  if (_client) {
    await _client.quit();
    _client = null;
    log.info("[redis] disconnected");
  }
}

export { Redis };
