/**
 * logger.ts — Pino structured logger singleton
 *
 * Development  → pino-pretty (coloured, human-readable)
 * Production   → JSON (machine-readable, queryable by Grafana/Loki)
 *
 * Usage:
 *   import { log } from "./logger.js";
 *   log.info({ symbol: "BTCUSDT" }, "[runner] scan started");
 *   log.warn({ err: e.message }, "[redis] connection error");
 *   log.error({ stack: e.stack }, "[botWorker] unexpected crash");
 */

import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss",
            ignore: "pid,hostname",
          },
        },
      }
    : {}),
});
