# UrumAutoTrader — Backend Architecture

## Two-System Overview

The backend runs two parallel trading engine systems during the migration period:

### Legacy Single-User System (DEPRECATED)
- **Entry**: `POST /bot/start`
- **Engine**: `startEngine()` / `stopEngine()` in `runner.ts`
- **User context**: Global `currentUserAddress` variable in `index.ts`
- **Limitation**: Can only serve ONE user at a time. Not safe for multi-user.
- **Sunset**: 2026-12-31

### New Multi-User Pool System (PRODUCTION)
- **Entry**: `POST /pool/start`
- **Engine**: `workerPool.ts` → `BotWorkerInstance` per user
- **User context**: Explicit `userKey` per instance
- **Capacity**: Up to 50 concurrent users
- **Status**: Production ready

## Event Flow

```
Bot scan tick
  → deps.emit(event)
  → recordEvent() in state.ts
  → broadcastSse(event)
    → filtered by event.userKey → sent to that user's SSE clients
    → always sent to "*" admin SSE clients
  → stored in Redis botEvents (shared, admin-visible)
```

## Candle Rate Limiter

`services/market/candleRateLimiter.ts` — token bucket singleton.
- Shared across all BotWorkerInstance workers (same Node.js process)
- Capacity: 1200 calls/min (50% of Binance FAPI 2400 limit)
- Refill rate: 20 tokens/second

## Redis Key Namespaces

| Prefix | Purpose |
|--------|---------|
| `trade:{userKey}:{symbol}` | Active trade cache per user |
| `regime:{userKey}:{symbol}` | Trend regime cache per user |
| `cooldown:{userKey}:{symbol}` | Entry cooldown per user/symbol |
| `perf:{userKey}` | Closed trade performance history |
| `botcfg:global` | Global default bot config |
| `botcfg:user:{userKey}` | Per-user bot config overrides |
| `session:{jti}` | Active JWT sessions |
| `bot:engine:autostart` | Saved autostart user config |
| `dailyReturn:{userKey}:{date}` | Circuit breaker daily PnL |
| `accounting:{userId}` | Deposit/withdrawal/profit accounting |
| `botEvents` | Shared event history (admin) |

## Deprecated Endpoints

| Endpoint | Replacement | Sunset |
|----------|-------------|--------|
| `POST /bot/start` | `POST /pool/start` | 2026-12-31 |
| `POST /bot/stop` | `POST /pool/stop` | 2026-12-31 |

## currentUserAddress Migration

The global `currentUserAddress` in `index.ts` is deprecated. All routes are being
migrated to use `resolveUserKey()` which derives the user from (in priority order):
1. `?user=` query param
2. JWT-derived wallet address
3. `currentUserAddress` fallback (deprecated)
