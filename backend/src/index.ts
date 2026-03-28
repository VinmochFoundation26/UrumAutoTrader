import "dotenv/config";
import * as Sentry from "@sentry/node";

// ── Sentry — initialise before any other imports so it can instrument them ───
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? "production",
    tracesSampleRate: 0.1,       // 10% of requests traced — adjust as needed
    ignoreErrors: [
      // suppress transient network noise already handled locally
      "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "could not coalesce",
      "missing response", "bad response",
    ],
  });
}

import http from "node:http";
import { URL } from "node:url";
import { v4 as uuidv4 } from "uuid";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

import {
  createUser, getUserById, getUserByEmail, getUserByVerifyToken,
  updateUser, listAllUsers, deleteUser, seedAdminIfEmpty,
} from "./services/users/userStore.js";
import {
  getUserTradingConfig,
  patchUserTradingConfig,
  deleteUserTradingConfig,
  validateUserTradingConfig as validateUserTradingConfigInput,
} from "./services/users/userTradingConfig.js";
import {
  sendVerificationEmail, sendApprovalEmail, sendRejectionEmail,
  sendAdminNewUserAlert,
} from "./services/email/mailer.js";

import { log } from "./logger.js";
import { connectRedis, disconnectRedis, getRedis } from "./services/cache/redis.js";
import { restoreEventHistory } from "./services/bot/state.js";
import { startPriceStream, stopPriceStream, getLatestPrice, getAllPrices, updateStreamSymbols } from "./services/market/priceStream.js";
import { assertOnchainReady, getVaultReadContract } from "./services/onchain/contractInstance.js";
import { stopEngine } from "./services/bot/runner.js";
import { getState, setRunning, recordError, addSseClient, getEventHistory } from "./services/bot/state.js";
import { getVaultBalances } from "./services/onchain/vaultViews.js";
import { validateConfig, CFG_KEYS, symbolMaxLev } from "./botWorker.trend_range_fork.js";
import { closePositionVaultV2, depositStableToVault, withdrawStableFromVault, emergencyWithdrawFromVault, getWalletStableBalance, transferUsdcFee, waitWithFallback } from "./services/onchain/vaultAdapter.js";
import { getSigner, getVaultWriteContract, getProvider, getVaultAddress } from "./services/onchain/contractInstance.js";
import { recordDeposit, recordWithdrawal, recordSubscriptionPayment, checkSubscription, getUserFeeStats, FEE } from "./services/fees/feeEngine.js";
import { workerPool } from "./services/bot/workerPool.js";
import { getCandleCacheStats } from "./services/market/binanceCandles.js";
import { canOverrideUserQuery, hasValidAdminKeyHeader, validateWalletLinkMessage } from "./services/auth/security.js";
import { adminRouteHttpStatus, buildRetiredRouteResponse } from "./services/auth/routePolicies.js";

const PORT                = Number(process.env.PORT ?? "5050");
const ADMIN_KEY           = process.env.ADMIN_KEY ?? "";               // kept for internal CLI only
const ALLOWED_ORIGIN      = process.env.CORS_ORIGIN ?? "*";
const JWT_SECRET          = process.env.JWT_SECRET ?? "CHANGEME_REPLACE_BEFORE_LAUNCH";
const LOGIN_PASSWORD_HASH = process.env.LOGIN_PASSWORD_HASH ?? "";
const JWT_EXPIRES_IN      = "8h";
const ADMIN_EMAIL         = process.env.ADMIN_EMAIL ?? "";
const WALLET_LINK_PREFIX  = "UrumTrader wallet link";

// ── In-memory rate limiter (login endpoint) ───────────────────────────────────
const _rlMap = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(ip: string, max = 10): boolean {
  const now = Date.now();
  const e   = _rlMap.get(ip) ?? { count: 0, resetAt: now + 60_000 };
  if (now > e.resetAt) { e.count = 0; e.resetAt = now + 60_000; }
  e.count++;
  _rlMap.set(ip, e);
  return e.count <= max;
}

// Clean up stale rate-limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rlMap) if (now > v.resetAt) _rlMap.delete(k);
}, 5 * 60_000).unref();

// Source of truth: SYMBOLS only (no whitelist)
let currentSymbols: string[] = (process.env.SYMBOLS ?? "ETHUSDT")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

// Fork-only strategy (prevent config drift)
const currentStrategy = "trend_range_fork" as const;

// Trigger params (fork uses these for stoch settings)
let currentTrigger = {
  stochOS: Number(process.env.STOCH_OS ?? "20"),
  stochOB: Number(process.env.STOCH_OB ?? "80"),
  stochMid: Number(process.env.STOCH_MID ?? "50"),
  stochDLen: Number(process.env.STOCH_D_LEN ?? "3"),
};

function normalizeSymbols(list: any): string[] {
  const arr = Array.isArray(list)
    ? list
    : typeof list === "string"
      ? list.split(",")
      : [];
  return arr.map((s: any) => String(s).trim().toUpperCase()).filter(Boolean);
}

function setCors(res: http.ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

function json(res: http.ServerResponse, status: number, body: any) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/** Decode and verify JWT — returns payload or null */
function decodeToken(req: http.IncomingMessage): { userId?: string; role?: string; jti?: string } | null {
  const auth = String(req.headers["authorization"] ?? "");
  if (!auth.startsWith("Bearer ")) return null;
  try { return jwt.verify(auth.slice(7), JWT_SECRET) as any; }
  catch { return null; }
}

/** JWT bearer auth — used by all protected endpoints */
function requireAuth(req: http.IncomingMessage): string | null {
  return decodeToken(req) ? null : "unauthorized";
}

/** Check that session:{jti} key exists in Redis (revocation support) */
async function checkSession(jti: string | undefined): Promise<boolean> {
  if (!jti) return false;
  try { return (await getRedis().exists(`session:${jti}`)) === 1; }
  catch { return true; } // Redis failure → non-blocking, allow
}

/** Require admin role in JWT + valid session */
async function requireAdminRole(req: http.IncomingMessage): Promise<{ error: string } | { userId: string; jti: string; role: string }> {
  const payload = decodeToken(req);
  if (!payload) return { error: "unauthorized" };
  if (payload.role !== "admin" && payload.role !== "support") return { error: "forbidden" };
  if (!(await checkSession(payload.jti))) return { error: "session expired" };
  return { userId: payload.userId ?? "", jti: payload.jti ?? "", role: payload.role };
}

/** Write an audit log entry (admin actions) */
async function auditLog(adminId: string, action: string, targetUserId: string, details?: string) {
  try {
    const entry = JSON.stringify({ ts: Date.now(), adminId, action, targetUserId, details: details ?? "" });
    await getRedis().lpush("audit:log", entry);
    await getRedis().ltrim("audit:log", 0, 9999);
  } catch { /* non-fatal */ }
}

/**
 * Resolves the active userKey for a request using priority:
 *   1. ?user= query param
 *   2. JWT-derived wallet address from the authenticated user record
 */
async function resolveUserKey(
  req: http.IncomingMessage,
  u: URL,
  opts: { allowQueryOverride?: boolean } = {}
): Promise<string> {
  const payload = decodeToken(req);

  // 1. Query param
  const q = u.searchParams.get("user");
  if (q && opts.allowQueryOverride) {
    const isPrivileged = canOverrideUserQuery(payload, hasValidAdminKey(req));
    if (isPrivileged) return q;
  }

  // 2. JWT
  try {
    if (payload?.userId) {
      const user = await getUserById(getRedis(), payload.userId).catch(() => null);
      if (user?.walletAddress) return user.walletAddress.toLowerCase();
    }
  } catch { /* non-fatal */ }

  return "";
}

/** Legacy ADMIN_KEY check — kept only for internal CLI scripts */
function hasValidAdminKey(req: http.IncomingMessage) {
  return hasValidAdminKeyHeader(ADMIN_KEY, String(req.headers["x-admin-key"] ?? "") || undefined);
}

function requireAdmin(req: http.IncomingMessage) {
  if (!ADMIN_KEY) return null;
  if (!hasValidAdminKey(req)) return "unauthorized";
  return null;
}

async function readJson(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  return raw ? JSON.parse(raw) : {};
}

export async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    setCors(res);
    if (req.method === "OPTIONS") return res.end();

    try {
      const u = new URL(req.url ?? "/", `http://localhost:${PORT}`);

      if (u.pathname === "/health") {
        let redisOk = false;
        try { await getRedis().ping(); redisOk = true; } catch { /* non-fatal */ }
        return json(res, 200, {
          ok: true,
          version: "1.1.0",
          uptime: Math.floor(process.uptime()),
          redis: redisOk ? "ok" : "degraded",
          bot: getState().running ? "running" : "stopped",
          ts: Date.now(),
        });
      }

      // ── POST /auth/login ── JWT login (rate-limited, 10 attempts/min/IP) ──────
      if (u.pathname === "/auth/login" && req.method === "POST") {
        const ip = req.socket?.remoteAddress ?? "unknown";
        if (!checkRateLimit(ip)) {
          log.warn({ ip }, "[auth] rate limit exceeded on /auth/login");
          return json(res, 429, { ok: false, error: "Too many login attempts. Try again in a minute." });
        }
        try {
          const b        = await readJson(req);
          const password = String(b.password ?? "").trim();
          const email    = String(b.email ?? "").trim().toLowerCase();

          if (!password) return json(res, 401, { ok: false, error: "Invalid credentials" });

          const redis = getRedis();

          // ── Multi-user path: email + password ────────────────────────────────
          if (email) {
            // Seed admin on first-ever login if users:list is empty
            if (LOGIN_PASSWORD_HASH && ADMIN_EMAIL) {
              await seedAdminIfEmpty(redis, ADMIN_EMAIL, LOGIN_PASSWORD_HASH);
            }

            const user = await getUserByEmail(redis, email);
            if (!user) {
              log.warn({ ip, email }, "[auth] login: user not found");
              return json(res, 401, { ok: false, error: "Invalid credentials" });
            }
            const valid = await bcrypt.compare(password, user.passwordHash);
            if (!valid) {
              log.warn({ ip, email }, "[auth] login: wrong password");
              return json(res, 401, { ok: false, error: "Invalid credentials" });
            }
            if (user.status === "pending_email") {
              return json(res, 403, { ok: false, error: "Please verify your email first." });
            }
            if (user.status === "pending_approval") {
              return json(res, 403, { ok: false, error: "Your account is pending admin approval.", status: "pending_approval" });
            }
            if (user.status === "suspended") {
              return json(res, 403, { ok: false, error: "Your account has been suspended." });
            }

            const jti = uuidv4();
            const token = jwt.sign(
              { userId: user.id, role: user.role, jti },
              JWT_SECRET,
              { expiresIn: JWT_EXPIRES_IN }
            );
            await redis.set(`session:${jti}`, user.id, "EX", 8 * 3600);
            await auditLog(user.id, "login", user.id);
            log.info({ ip, email, role: user.role }, "[auth] login successful");
            return json(res, 200, { ok: true, token, expiresIn: JWT_EXPIRES_IN, role: user.role, userId: user.id });
          }

          // ── Legacy path: password-only (existing admin dashboard) ────────────
          if (!LOGIN_PASSWORD_HASH) return json(res, 401, { ok: false, error: "Invalid credentials" });
          const valid = await bcrypt.compare(password, LOGIN_PASSWORD_HASH);
          if (!valid) {
            log.warn({ ip }, "[auth] failed legacy login attempt");
            return json(res, 401, { ok: false, error: "Invalid credentials" });
          }
          // Seed admin user and resolve userId for JWT
          if (LOGIN_PASSWORD_HASH && ADMIN_EMAIL) {
            await seedAdminIfEmpty(redis, ADMIN_EMAIL, LOGIN_PASSWORD_HASH);
          }
          const adminUser = ADMIN_EMAIL ? await getUserByEmail(redis, ADMIN_EMAIL) : null;
          const jti = uuidv4();
          const token = jwt.sign(
            { userId: adminUser?.id ?? "admin", role: "admin", jti },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES_IN }
          );
          await redis.set(`session:${jti}`, adminUser?.id ?? "admin", "EX", 8 * 3600);
          log.info({ ip }, "[auth] legacy admin login successful — token issued (8h)");
          return json(res, 200, { ok: true, token, expiresIn: JWT_EXPIRES_IN, role: "admin" });
        } catch (e: any) {
          return json(res, 400, { ok: false, error: e?.message ?? "bad request" });
        }
      }

      // ── POST /auth/refresh ── extend session without re-entering password ────
      if (u.pathname === "/auth/refresh" && req.method === "POST") {
        const payload = decodeToken(req);
        if (!payload) return json(res, 401, { ok: false, error: "unauthorized" });
        const jti = uuidv4();
        const token = jwt.sign(
          { userId: payload.userId, role: payload.role ?? "admin", jti },
          JWT_SECRET,
          { expiresIn: JWT_EXPIRES_IN }
        );
        // Revoke old session, start new one
        if (payload.jti) await getRedis().del(`session:${payload.jti}`);
        await getRedis().set(`session:${jti}`, payload.userId ?? "admin", "EX", 8 * 3600);
        return json(res, 200, { ok: true, token, expiresIn: JWT_EXPIRES_IN });
      }

      // ── POST /auth/register ─────────────────────────────────────────────────
      if (u.pathname === "/auth/register" && req.method === "POST") {
        const ip = req.socket?.remoteAddress ?? "unknown";
        if (!checkRateLimit(ip, 5)) {
          return json(res, 429, { ok: false, error: "Too many registration attempts. Try again in a minute." });
        }
        try {
          const b = await readJson(req);
          const email         = String(b.email ?? "").trim().toLowerCase();
          const password      = String(b.password ?? "").trim();
          const walletAddress = String(b.walletAddress ?? "").trim();

          if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
            return json(res, 400, { ok: false, error: "Valid email required" });
          if (!password || password.length < 8)
            return json(res, 400, { ok: false, error: "Password must be at least 8 characters" });
          // Wallet address is optional at registration — user can link later via /auth/wallet
          if (walletAddress && !/^0x[0-9a-fA-F]{40}$/.test(walletAddress))
            return json(res, 400, { ok: false, error: "Invalid wallet address format" });

          const redis = getRedis();
          const existing = await getUserByEmail(redis, email);
          if (existing) return json(res, 409, { ok: false, error: "Email already registered" });

          const passwordHash = await bcrypt.hash(password, 12);
          const user = await createUser(redis, { email, passwordHash, walletAddress });
          // Email is best-effort — don't fail registration if email provider errors
          try {
            await sendVerificationEmail(user.email, user.emailVerifyToken);
          } catch (emailErr: any) {
            log.warn({ email, err: emailErr?.message }, "[auth] verification email failed — user still created");
          }
          log.info({ email, userId: user.id }, "[auth] new user registered");
          return json(res, 201, { ok: true, message: "Registration successful. Check your email to verify your address." });
        } catch (e: any) {
          return json(res, 400, { ok: false, error: e?.message ?? "bad request" });
        }
      }

      // ── GET /auth/verify-email?token=xxx ────────────────────────────────────
      if (u.pathname === "/auth/verify-email" && req.method === "GET") {
        const token = u.searchParams.get("token") ?? "";
        if (!token) return json(res, 400, { ok: false, error: "Missing token" });
        const redis = getRedis();
        const user = await getUserByVerifyToken(redis, token);
        if (!user) return json(res, 400, { ok: false, error: "Invalid or expired verification link" });
        if (user.status !== "pending_email") return json(res, 400, { ok: false, error: "Email already verified" });
        await updateUser(redis, user.id, { status: "pending_approval", emailVerifyToken: "" });
        await sendAdminNewUserAlert(user.email);
        log.info({ email: user.email }, "[auth] email verified — pending approval");
        return json(res, 200, { ok: true, message: "Email verified. Your application is under review." });
      }

      // ── GET /auth/me ─────────────────────────────────────────────────────────
      if (u.pathname === "/auth/me" && req.method === "GET") {
        const payload = decodeToken(req);
        if (!payload?.userId) return json(res, 401, { ok: false, error: "unauthorized" });
        const user = await getUserById(getRedis(), payload.userId);
        if (!user) return json(res, 404, { ok: false, error: "user not found" });
        const { passwordHash: _, emailVerifyToken: __, ...safe } = user;
        return json(res, 200, { ok: true, user: safe });
      }

      // ── POST /auth/wallet ── link/update wallet after MetaMask sign ──────────
      if (u.pathname === "/auth/wallet" && req.method === "POST") {
        const payload = decodeToken(req);
        if (!payload?.userId) return json(res, 401, { ok: false, error: "unauthorized" });
        try {
          const b = await readJson(req);
          const walletAddress = String(b.walletAddress ?? "").trim();
          const message = String(b.message ?? "");
          const signature = String(b.signature ?? "");
          if (!walletAddress || !/^0x[0-9a-fA-F]{40}$/.test(walletAddress))
            return json(res, 400, { ok: false, error: "Valid wallet address required" });
          if (!message || !signature) {
            return json(res, 400, { ok: false, error: "Wallet signature is required" });
          }
          if (!validateWalletLinkMessage({
            message,
            walletAddress,
            userId: payload.userId,
            prefix: WALLET_LINK_PREFIX,
          })) {
            return json(res, 400, { ok: false, error: "Invalid wallet-link message" });
          }
          const { ethers } = await import("ethers");
          const recovered = ethers.verifyMessage(message, signature);
          if (recovered.toLowerCase() !== walletAddress.toLowerCase())
            return json(res, 400, { ok: false, error: "Signature verification failed" });
          await updateUser(getRedis(), payload.userId, { walletAddress });
          return json(res, 200, { ok: true, walletAddress });
        } catch (e: any) {
          return json(res, 400, { ok: false, error: e?.message ?? "bad request" });
        }
      }

      // ── POST /auth/forgot-password ── request a password reset email ─────────
      if (u.pathname === "/auth/forgot-password" && req.method === "POST") {
        const ip = req.socket?.remoteAddress ?? "unknown";
        if (!checkRateLimit(ip, 5)) return json(res, 429, { ok: false, error: "Too many attempts. Try again in a minute." });
        try {
          const b     = await readJson(req);
          const email = String(b.email ?? "").trim().toLowerCase();
          if (!email) return json(res, 400, { ok: false, error: "Email required" });
          const redis = getRedis();
          const user  = await getUserByEmail(redis, email);
          // Always return 200 — prevents email enumeration
          if (user && user.status === "active") {
            const token = uuidv4();
            await redis.set(`pwd-reset:${token}`, user.id, "EX", 3600); // 1h TTL
            const { sendPasswordResetEmail } = await import("./services/email/mailer.js");
            await sendPasswordResetEmail(user.email, token);
            log.info({ email }, "[auth] password reset email sent");
          }
          return json(res, 200, { ok: true, message: "If that email is registered and active, a reset link has been sent." });
        } catch (e: any) {
          return json(res, 400, { ok: false, error: e?.message ?? "bad request" });
        }
      }

      // ── POST /auth/reset-password ── set new password using token ────────────
      if (u.pathname === "/auth/reset-password" && req.method === "POST") {
        try {
          const b           = await readJson(req);
          const token       = String(b.token ?? "").trim();
          const newPassword = String(b.newPassword ?? "").trim();
          if (!token)       return json(res, 400, { ok: false, error: "Reset token required" });
          if (!newPassword || newPassword.length < 8) return json(res, 400, { ok: false, error: "Password must be at least 8 characters" });
          const redis  = getRedis();
          const userId = await redis.get(`pwd-reset:${token}`);
          if (!userId) return json(res, 400, { ok: false, error: "Invalid or expired reset link" });
          const passwordHash = await bcrypt.hash(newPassword, 12);
          await updateUser(redis, userId, { passwordHash });
          await redis.del(`pwd-reset:${token}`); // one-time use
          log.info({ userId }, "[auth] password reset successful");
          return json(res, 200, { ok: true, message: "Password updated. You can now sign in." });
        } catch (e: any) {
          return json(res, 400, { ok: false, error: e?.message ?? "bad request" });
        }
      }

      // ── GET /admin/users ────────────────────────────────────────────────────
      if (u.pathname === "/admin/users" && req.method === "GET") {
        const auth = await requireAdminRole(req);
        if ("error" in auth) return json(res, auth.error === "forbidden" ? 403 : 401, { ok: false, error: auth.error });
        const users = await listAllUsers(getRedis());
        const safe = users.map(({ passwordHash: _, emailVerifyToken: __, ...u }) => u);
        return json(res, 200, { ok: true, users: safe });
      }

      // ── POST /admin/users/:id/approve ───────────────────────────────────────
      if (/^\/admin\/users\/[^/]+\/approve$/.test(u.pathname) && req.method === "POST") {
        const auth = await requireAdminRole(req);
        if ("error" in auth) return json(res, auth.error === "forbidden" ? 403 : 401, { ok: false, error: auth.error });
        const userId = u.pathname.split("/")[3];
        try {
          const user = await updateUser(getRedis(), userId, {
            status: "active",
            approvedAt: new Date().toISOString(),
          });
          if (!user) return json(res, 404, { ok: false, error: "user not found" });
          // Wallet is connected by the user after login — no vault address needed at approval
          try {
            await sendApprovalEmail(user.email, user.walletAddress ?? "");
          } catch (emailErr: any) {
            log.warn({ email: user.email, err: emailErr?.message }, "[admin] approval email failed");
          }
          await auditLog(auth.userId, "approve", userId);
          log.info({ adminId: auth.userId, userId }, "[admin] user approved");
          return json(res, 200, { ok: true, message: "User approved" });
        } catch (e: any) {
          return json(res, 400, { ok: false, error: e?.message ?? "bad request" });
        }
      }

      // ── POST /admin/users/:id/reject ────────────────────────────────────────
      if (/^\/admin\/users\/[^/]+\/reject$/.test(u.pathname) && req.method === "POST") {
        const auth = await requireAdminRole(req);
        if ("error" in auth) return json(res, auth.error === "forbidden" ? 403 : 401, { ok: false, error: auth.error });
        const userId = u.pathname.split("/")[3];
        const user = await getUserById(getRedis(), userId);
        if (!user) return json(res, 404, { ok: false, error: "user not found" });
        await sendRejectionEmail(user.email);
        await auditLog(auth.userId, "reject", userId);
        log.info({ adminId: auth.userId, userId }, "[admin] user rejected");
        return json(res, 200, { ok: true, message: "User rejected — email sent" });
      }

      // ── GET /admin/users/:id/fees — per-user fee stats (admin) ───────────────
      if (/^\/admin\/users\/[^/]+\/fees$/.test(u.pathname) && req.method === "GET") {
        const auth = await requireAdminRole(req);
        if ("error" in auth) return json(res, auth.error === "forbidden" ? 403 : 401, { ok: false, error: auth.error });
        const userId = u.pathname.split("/")[3];
        const user = await getUserById(getRedis(), userId);
        if (!user) return json(res, 404, { ok: false, error: "User not found" });
        const stats = await getUserFeeStats(getRedis(), userId, user.trialExpiresAt);
        return json(res, 200, { ok: true, userId, ...stats });
      }

      // ── POST /admin/users/:id/suspend ───────────────────────────────────────
      if (/^\/admin\/users\/[^/]+\/suspend$/.test(u.pathname) && req.method === "POST") {
        const auth = await requireAdminRole(req);
        if ("error" in auth) return json(res, auth.error === "forbidden" ? 403 : 401, { ok: false, error: auth.error });
        const userId = u.pathname.split("/")[3];
        const user = await updateUser(getRedis(), userId, { status: "suspended" });
        if (!user) return json(res, 404, { ok: false, error: "user not found" });
        // Revoke all active sessions for this user (scan session: keys — limited scan)
        try {
          const keys = await getRedis().keys("session:*");
          const pipeline = getRedis().pipeline();
          for (const k of keys) {
            const v = await getRedis().get(k);
            if (v === userId) pipeline.del(k);
          }
          await pipeline.exec();
        } catch { /* non-fatal */ }
        await auditLog(auth.userId, "suspend", userId);
        log.info({ adminId: auth.userId, userId }, "[admin] user suspended");
        return json(res, 200, { ok: true, message: "User suspended — session revoked" });
      }

      // ── DELETE /admin/users/:id ─────────────────────────────────────────────
      if (/^\/admin\/users\/[^/]+$/.test(u.pathname) && req.method === "DELETE") {
        const auth = await requireAdminRole(req);
        if ("error" in auth) return json(res, auth.error === "forbidden" ? 403 : 401, { ok: false, error: auth.error });
        const userId = u.pathname.split("/")[3];
        const deleted = await deleteUser(getRedis(), userId);
        if (!deleted) return json(res, 404, { ok: false, error: "user not found" });
        await auditLog(auth.userId, "delete", userId);
        log.info({ adminId: auth.userId, userId }, "[admin] user deleted");
        return json(res, 200, { ok: true, message: "User deleted" });
      }

      // ── GET /admin/users/:id/trading-config ─────────────────────────────────
      if (/^\/admin\/users\/[^/]+\/trading-config$/.test(u.pathname) && req.method === "GET") {
        const auth = await requireAdminRole(req);
        if ("error" in auth) return json(res, auth.error === "forbidden" ? 403 : 401, { ok: false, error: auth.error });
        const userId = u.pathname.split("/")[3];
        const cfg = await getUserTradingConfig(getRedis(), userId);
        return json(res, 200, { ok: true, config: cfg });
      }

      // ── PATCH /admin/users/:id/trading-config ────────────────────────────────
      if (/^\/admin\/users\/[^/]+\/trading-config$/.test(u.pathname) && req.method === "PATCH") {
        const auth = await requireAdminRole(req);
        if ("error" in auth) return json(res, auth.error === "forbidden" ? 403 : 401, { ok: false, error: auth.error });
        const userId = u.pathname.split("/")[3];
        try {
          const body    = await readJson(req);
          const patch   = validateUserTradingConfigInput(body);
          const saved   = await patchUserTradingConfig(getRedis(), userId, patch);
          await auditLog(auth.userId, "update_trading_config", userId);
          log.info({ adminId: auth.userId, userId, patch }, "[admin] user trading config updated");
          return json(res, 200, { ok: true, config: saved });
        } catch (e: any) {
          return json(res, 400, { ok: false, error: e?.message ?? "bad request" });
        }
      }

      // ── DELETE /admin/users/:id/trading-config ───────────────────────────────
      if (/^\/admin\/users\/[^/]+\/trading-config$/.test(u.pathname) && req.method === "DELETE") {
        const auth = await requireAdminRole(req);
        if ("error" in auth) return json(res, auth.error === "forbidden" ? 403 : 401, { ok: false, error: auth.error });
        const userId = u.pathname.split("/")[3];
        await deleteUserTradingConfig(getRedis(), userId);
        await auditLog(auth.userId, "delete_trading_config", userId);
        return json(res, 200, { ok: true, message: "Trading config reset to global defaults" });
      }

      // ── POST /admin/users/:id/grant-subscription — admin grants sub manually ─
      if (/^\/admin\/users\/[^/]+\/grant-subscription$/.test(u.pathname) && req.method === "POST") {
        const auth = await requireAdminRole(req);
        if ("error" in auth) return json(res, auth.error === "forbidden" ? 403 : 401, { ok: false, error: auth.error });
        const userId = u.pathname.split("/")[3];
        try {
          const b      = await readJson(req);
          const amount = parseFloat(b.amount ?? FEE.SUBSCRIPTION_USDC);
          const { paidUntil } = await recordSubscriptionPayment(getRedis(), userId, amount);
          await auditLog(auth.userId, "grant_subscription", userId, `amount=${amount} paidUntil=${paidUntil}`);
          log.info({ adminId: auth.userId, userId, amount, paidUntil }, "[admin] subscription granted");
          return json(res, 200, { ok: true, paidUntil, amount, message: `Subscription granted until ${paidUntil}` });
        } catch (e: any) {
          return json(res, 500, { ok: false, error: e?.message ?? String(e) });
        }
      }

      // ── GET /admin/stats ────────────────────────────────────────────────────
      if (u.pathname === "/admin/stats" && req.method === "GET") {
        const auth = await requireAdminRole(req);
        if ("error" in auth) return json(res, auth.error === "forbidden" ? 403 : 401, { ok: false, error: auth.error });
        const users = await listAllUsers(getRedis());
        return json(res, 200, {
          ok: true,
          totalUsers:      users.length,
          active:          users.filter(u => u.status === "active").length,
          pendingApproval: users.filter(u => u.status === "pending_approval").length,
          pendingEmail:    users.filter(u => u.status === "pending_email").length,
          suspended:       users.filter(u => u.status === "suspended").length,
          uptime:          Math.floor(process.uptime()),
          botRunning:      getState().running,
        });
      }

      // ── GET /admin/audit ────────────────────────────────────────────────────
      if (u.pathname === "/admin/audit" && req.method === "GET") {
        const auth = await requireAdminRole(req);
        if ("error" in auth) return json(res, auth.error === "forbidden" ? 403 : 401, { ok: false, error: auth.error });
        const limit = Math.min(Number(u.searchParams.get("limit") ?? "100"), 1000);
        const raw = await getRedis().lrange("audit:log", 0, limit - 1);
        const entries = raw.map(r => { try { return JSON.parse(r); } catch { return r; } });
        return json(res, 200, { ok: true, count: entries.length, entries });
      }

      // ── GET /admin/support-tickets ──────────────────────────────────────────
      if (u.pathname === "/admin/support-tickets" && req.method === "GET") {
        const auth = await requireAdminRole(req);
        if ("error" in auth) return json(res, auth.error === "forbidden" ? 403 : 401, { ok: false, error: auth.error });
        const limit = Math.min(Number(u.searchParams.get("limit") ?? "50"), 200);
        const raw = await getRedis().lrange("support:tickets", 0, limit - 1);
        const tickets = raw.map(r => { try { return JSON.parse(r); } catch { return r; } });
        return json(res, 200, { ok: true, count: tickets.length, tickets });
      }

      if (u.pathname === "/bot/config") {
        if (req.method === "GET" || req.method === "HEAD") {
          const userKey = await resolveUserKey(req, u);
          return json(res, 200, {
            userAddress: userKey,
            symbols: currentSymbols,
            strategy: currentStrategy,
            trigger: currentTrigger,
          });
        }
      }

      if (u.pathname === "/bot/state") {
        const userKey = await resolveUserKey(req, u);
        const baseState = getState();
        const workerRunning = userKey ? workerPool.isRunning(userKey) : false;
        const workerStatus  = userKey ? workerPool.getUserStatus(userKey) : null;
        return json(res, 200, {
          ok: true,
          config: {
            userAddress: userKey,
            symbols: currentSymbols,
            strategy: currentStrategy,
            trigger: currentTrigger,
          },
          state: {
            ...baseState,
            running:   workerRunning,
            startedAt: workerStatus?.startedAt ?? baseState.startedAt,
          },
        });
      }

      // View vault balances (read-only)
      if (u.pathname === "/vault/balances") {
        const authErr = requireAuth(req);
        if (authErr) return json(res, 401, { ok: false, error: authErr });
        const adminResult = await requireAdminRole(req);
        const user = await resolveUserKey(req, u, { allowQueryOverride: !("error" in adminResult) });
        if (!user) return json(res, 400, { ok: false, error: "missing user" });
        const r = await getVaultBalances(user);
        return json(res, 200, { ok: true, user, balances: r });
      }

      // Debug: see all open positions for a user
      if (u.pathname === "/vault/position") {
        const authErr = requireAuth(req);
        if (authErr) return json(res, 401, { ok: false, error: authErr });
        const adminResult = await requireAdminRole(req);
        const user = await resolveUserKey(req, u, { allowQueryOverride: !("error" in adminResult) });
        if (!user) return json(res, 400, { ok: false, error: "no user configured" });
        const c = getVaultReadContract();
        const markets: string[] = await c.getOpenMarkets(user);
        const positions: Record<string, any> = {};
        for (const mId of markets) {
          const p = await c.positionOf(user, mId);
          positions[mId] = {
            isOpen: p.isOpen,
            isLong: p.isLong,
            sizeX18: p.sizeX18.toString(),
            entryPriceX18: p.entryPriceX18.toString(),
            collateralX18: p.collateralX18.toString(),
            openedAt: p.openedAt.toString(),
          };
        }
        return json(res, 200, { ok: true, user, openCount: markets.length, positions });
      }

      if (u.pathname === "/bot/set" && req.method === "POST") {
        const adminResult = await requireAdminRole(req);
        if ("error" in adminResult) {
          return json(res, adminRouteHttpStatus(adminResult.error as "unauthorized" | "forbidden" | "session expired"), { ok: false, error: adminResult.error });
        }
        try {
          const b = await readJson(req);
          if (b.symbols != null) {
            const next = normalizeSymbols(b.symbols);
            if (!next.length) return json(res, 400, { ok: false, error: "no valid symbols after normalization" });
            currentSymbols = next;
            // Update WebSocket stream to new symbol set
            updateStreamSymbols(currentSymbols);
          }
          if (b.trigger && typeof b.trigger === "object") {
            const t: any = b.trigger;
            if (typeof t.stochOS === "number") currentTrigger.stochOS = t.stochOS;
            if (typeof t.stochOB === "number") currentTrigger.stochOB = t.stochOB;
            if (typeof t.stochMid === "number") currentTrigger.stochMid = t.stochMid;
            if (typeof t.stochDLen === "number") currentTrigger.stochDLen = t.stochDLen;
          }
          const userKey = await resolveUserKey(req, u);
          await auditLog(adminResult.userId, "bot:set", userKey || "*", `symbols=${currentSymbols.join(",")}`);
          return json(res, 200, {
            ok: true,
            config: { userAddress: userKey, symbols: currentSymbols, strategy: currentStrategy, trigger: currentTrigger },
          });
        } catch (e: any) {
          return json(res, 400, { ok: false, error: e?.message ?? "bad request" });
        }
      }

      // ── /bot/config — save leverage / sizing to user Redis config ───────────
      if (u.pathname === "/bot/config" && req.method === "POST") {
        const err = requireAuth(req);
        if (err) return json(res, 401, { ok: false, error: err });
        try {
          const b = await readJson(req);
          const redis = getRedis();
          const userKey = await resolveUserKey(req, u);
          // Load existing user config, merge, validate, save
          const existing = await (async () => {
            try { const s = await redis.get(CFG_KEYS.user(userKey)); return s ? JSON.parse(s) : {}; }
            catch { return {}; }
          })();
          const merged = { ...existing, ...b };
          const validated = validateConfig(merged);
          // Per-symbol cap enforcement: cap DEFAULT_LEVERAGE against each active symbol
          for (const sym of currentSymbols) {
            const cap = symbolMaxLev(sym);
            if (validated.DEFAULT_LEVERAGE > cap) validated.DEFAULT_LEVERAGE = cap;
            if (validated.MAX_LEVERAGE > cap) validated.MAX_LEVERAGE = cap;
          }
          await redis.set(CFG_KEYS.user(userKey), JSON.stringify(validated));
          log.info({ leverage: validated.DEFAULT_LEVERAGE, manualSizePct: validated.MANUAL_SIZE_PCT }, "[config] user bot config saved");
          return json(res, 200, { ok: true, config: validated });
        } catch (e: any) {
          return json(res, 400, { ok: false, error: e?.message ?? "bad request" });
        }
      }

      // @deprecated — migrate to POST /pool/start. This route uses the global
      // @retired — use POST /pool/start. The old /bot/start route is intentionally disabled
      // to avoid reintroducing single-user route semantics.
      if (u.pathname === "/bot/start") {
        res.setHeader("Deprecation", "true");
        res.setHeader("Sunset", "2026-12-31");
        log.warn("[RETIRED] POST /bot/start called — use POST /pool/start");
        const retired = buildRetiredRouteResponse(u.pathname)!;
        return json(res, retired.status, retired.body);
      }

      // @retired — use POST /pool/stop. The old /bot/stop route is intentionally disabled
      // to avoid reintroducing single-user route semantics.
      if (u.pathname === "/bot/stop") {
        res.setHeader("Deprecation", "true");
        res.setHeader("Sunset", "2026-12-31");
        log.warn("[RETIRED] POST /bot/stop called — use POST /pool/stop");
        const retired = buildRetiredRouteResponse(u.pathname)!;
        return json(res, retired.status, retired.body);
      }

      // ── POST /pool/start — start bot for a specific user (admin) ─────────
      if (u.pathname === "/pool/start" && req.method === "POST") {
        const adminResult = await requireAdminRole(req);
        if ("error" in adminResult) return json(res, adminResult.error === "unauthorized" ? 401 : 403, { ok: false, error: adminResult.error });
        try {
          const b         = await readJson(req);
          const userKey   = String(b.userKey   ?? "").trim();
          const userId    = String(b.userId    ?? "").trim();
          const rawSyms   = b.symbols ?? currentSymbols;
          const symbols   = normalizeSymbols(rawSyms);
          const trigger   = b.trigger ?? currentTrigger;
          const strategy  = (b.strategy ?? "trend_range_fork") as import("./services/bot/botWorkerInstance.js").StrategyMode;

          if (!userKey) return json(res, 400, { ok: false, error: "userKey required" });
          if (!symbols.length) return json(res, 400, { ok: false, error: "at least one symbol required" });

          const r = await workerPool.startUser({
            userKey,
            symbols,
            trigger,
            strategy,
            userId:        userId  || undefined,
            skipSubCheck:  !userId,   // skip if no userId provided (admin override)
          });
          if (r.ok) {
            await getRedis().set("bot:engine:autostart", JSON.stringify({ running: true, userKey, symbols, trigger, strategy }));
          }
          await auditLog(adminResult.userId, "pool:start", userKey, `symbols=${symbols.join(",")}`);
          return json(res, r.ok ? 200 : 400, r);
        } catch (e: any) {
          return json(res, 500, { ok: false, error: e?.message ?? String(e) });
        }
      }

      // ── POST /pool/stop — stop bot for a specific user (admin) ───────────
      if (u.pathname === "/pool/stop" && req.method === "POST") {
        const adminResult = await requireAdminRole(req);
        if ("error" in adminResult) return json(res, adminResult.error === "unauthorized" ? 401 : 403, { ok: false, error: adminResult.error });
        try {
          const b       = await readJson(req);
          const userKey = String(b.userKey ?? "").trim();
          if (!userKey) return json(res, 400, { ok: false, error: "userKey required" });

          const r = workerPool.stopUser(userKey);
          await getRedis().del("bot:engine:autostart");
          await auditLog(adminResult.userId, "pool:stop", userKey);
          return json(res, 200, r);
        } catch (e: any) {
          return json(res, 500, { ok: false, error: e?.message ?? String(e) });
        }
      }

      // ── POST /pool/stopall — stop all user workers (admin emergency) ──────
      if (u.pathname === "/pool/stopall" && req.method === "POST") {
        const adminResult = await requireAdminRole(req);
        if ("error" in adminResult) return json(res, adminResult.error === "unauthorized" ? 401 : 403, { ok: false, error: adminResult.error });
        const r = workerPool.stopAll();
        await auditLog(adminResult.userId, "pool:stopall", "*", `stopped=${r.stopped}`);
        return json(res, 200, r);
      }

      // ── GET /pool/status — list all active workers (admin) ────────────────
      if (u.pathname === "/pool/status") {
        const adminResult = await requireAdminRole(req);
        if ("error" in adminResult) return json(res, adminResult.error === "unauthorized" ? 401 : 403, { ok: false, error: adminResult.error });
        return json(res, 200, {
          ok:           true,
          workerCount:  workerPool.size,
          workers:      workerPool.getStatus(),
          candleCache:  getCandleCacheStats(),
        });
      }

      // ── GET /pool/status/:userKey — single-user worker status (admin) ─────
      if (u.pathname.startsWith("/pool/status/")) {
        const adminResult = await requireAdminRole(req);
        if ("error" in adminResult) return json(res, adminResult.error === "unauthorized" ? 401 : 403, { ok: false, error: adminResult.error });
        const userKey = decodeURIComponent(u.pathname.slice("/pool/status/".length)).trim();
        if (!userKey) return json(res, 400, { ok: false, error: "userKey required in path" });
        const status  = workerPool.getUserStatus(userKey);
        if (!status)  return json(res, 404, { ok: false, error: "No worker found for this userKey" });
        return json(res, 200, { ok: true, ...status });
      }

      // ── Close all open on-chain positions (admin) ─────────────────────────
      if (u.pathname === "/bot/closeall" && req.method === "POST") {
        const adminResult = await requireAdminRole(req);
        const legacyAdmin = hasValidAdminKey(req);
        if (!legacyAdmin && "error" in adminResult) {
          return json(res, adminResult.error === "unauthorized" ? 401 : 403, { ok: false, error: adminResult.error });
        }
        try {
          const user = await resolveUserKey(req, u, { allowQueryOverride: true });
          if (!user) return json(res, 400, { ok: false, error: "no user configured" });
          const readC  = getVaultReadContract();
          const markets: string[] = await readC.getOpenMarkets(user);
          if (!markets.length) return json(res, 200, { ok: true, closed: 0, results: [] });

          const signer   = getSigner();
          const writeC   = getVaultWriteContract();
          const results: any[] = [];

          for (const marketId of markets) {
            try {
              // Use current mid-price from WS cache as exit price
              const MARKET_SYMBOLS: Record<string, string> = {
                "0xcd423b16b64109a0492eab881d06ef1d6470d25f8e3d6f04f5acc111f176939c": "BTCUSDT",
                "0xaeb17180ec6df0d643751cbbe82ac67166a910f4092c23f781cd39e46582ec9c": "ETHUSDT",
                "0xae9c0146ab64b81aae7608dc5ffddfa320640d5dece2ab37ecf0809dcc5f0c2a": "TAOUSDT",
                "0x23c6a2c43f92acac35ed89f352fa5f2e30496347aeb1aafb8e0a14766b47dbf1": "RENDERUSDT",
                "0x3db5e9fb22b6f66ce6550ab2b9d3872f875f575780c6abb9c95f9ce03845a83e": "SOLUSDT",
                "0xaeee40e849f19d8b8252d9e750ed2ff6fa233c95aa4a1d3da9858a3b18ade5df": "BNBUSDT",
              };
              const symbol    = MARKET_SYMBOLS[marketId] ?? null;
              // Try WS cache first; fall back to Binance Futures REST
              let priceNum: number | null = symbol ? getLatestPrice(symbol) : null;
              if (!priceNum && symbol) {
                try {
                  const pr = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`, { signal: AbortSignal.timeout(4000) });
                  const pj = await pr.json() as { price: string };
                  priceNum = parseFloat(pj.price);
                } catch { /* leave null */ }
              }
              if (!priceNum) {
                results.push({ marketId, symbol, ok: false, error: "no live price — retry shortly" });
                continue;
              }
              const exitPriceX18 = BigInt(Math.round(priceNum * 1e18));
              const r = await closePositionVaultV2(writeC, signer, { user, marketId, exitPriceX18 });
              log.info({ marketId, symbol, txHash: r.txHash }, "[closeall] position closed");
              results.push({ marketId, symbol, ok: true, txHash: r.txHash });
            } catch (e: any) {
              results.push({ marketId, ok: false, error: e?.reason ?? e?.message ?? String(e) });
            }
          }

          const closed = results.filter(r => r.ok).length;
          if (!legacyAdmin && !("error" in adminResult)) {
            await auditLog(adminResult.userId, "bot:closeall", user, `closed=${closed}/${markets.length}`);
          }
          return json(res, 200, { ok: true, closed, total: markets.length, results });
        } catch (e: any) {
          return json(res, 500, { ok: false, error: e?.message ?? String(e) });
        }
      }

      // ── Close a single position by symbol ────────────────────────────────
      if (u.pathname === "/vault/close-position" && req.method === "POST") {
        const adminResult = await requireAdminRole(req);
        const legacyAdmin = hasValidAdminKey(req);
        const authErr = requireAuth(req);
        if (authErr && !legacyAdmin) return json(res, 401, { ok: false, error: authErr });
        try {
          const b: any = await readJson(req);
          const symbol: string | undefined = b?.symbol?.toUpperCase();
          if (!symbol) return json(res, 400, { ok: false, error: "symbol required" });

          const user = await resolveUserKey(req, u, {
            allowQueryOverride: legacyAdmin || !("error" in adminResult),
          });
          if (!user) return json(res, 400, { ok: false, error: "no user configured" });

          const { symbolToMarketId } = await import("./services/onchain/vaultAdapter.js");
          const marketId = symbolToMarketId(symbol);

          // Get live price — WS cache first, then Binance REST fallback
          let priceNum: number | null = getLatestPrice(symbol);
          if (!priceNum) {
            try {
              const pr = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`, { signal: AbortSignal.timeout(4000) });
              const pj = await pr.json() as { price: string };
              priceNum = parseFloat(pj.price);
            } catch { /* leave null */ }
          }
          if (!priceNum) return json(res, 503, { ok: false, error: "no live price — retry shortly" });

          const exitPriceX18 = BigInt(Math.round(priceNum * 1e18));
          const signer = getSigner();
          const writeC = getVaultWriteContract();
          const r = await closePositionVaultV2(writeC, signer, { user, marketId, exitPriceX18 });
          log.info({ symbol, marketId, txHash: r.txHash }, "[close-position] closed");
          return json(res, 200, { ok: true, symbol, txHash: r.txHash, exitPrice: priceNum });
        } catch (e: any) {
          return json(res, 500, { ok: false, error: e?.reason ?? e?.message ?? String(e) });
        }
      }

      // SSE: live event stream for dashboard
      if (u.pathname === "/bot/events") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");

        // Determine userKey for filtering:
        // 1. Admin/support role → use "*" (all events) or ?userKey= param
        // 2. User role → derive from JWT-linked wallet address
        // 3. No token → show all events ("*")
        let sseUserKey: string = "*";
        const ssePayload = decodeToken(req);
        if (ssePayload?.userId) {
          if (ssePayload.role === "admin" || ssePayload.role === "support") {
            // Admin sees all, but can filter via ?userKey=
            sseUserKey = u.searchParams.get("userKey") ?? "*";
          } else {
            // Regular user: look up wallet address from user record
            try {
              const sseUser = await getUserById(getRedis(), ssePayload.userId).catch(() => null);
              sseUserKey = sseUser?.walletAddress || "*";
            } catch { /* non-fatal */ }
          }
        }

        addSseClient(res, sseUserKey);
        // Send recent history so client is immediately populated
        const history = getEventHistory(sseUserKey);
        for (const e of history) res.write(`data: ${JSON.stringify(e)}\n\n`);
        // Keep alive ping every 15s
        const ping = setInterval(() => {
          try { res.write(`: ping\n\n`); } catch { clearInterval(ping); }
        }, 15_000);
        res.on("close", () => clearInterval(ping));
        return;
      }

      // REST: last N events
      if (u.pathname === "/bot/history") {
        const limit = Math.min(Number(u.searchParams.get("limit") ?? "50"), 500);
        const history = getEventHistory().slice(-limit);
        return json(res, 200, { ok: true, count: history.length, events: history });
      }

      // ── Market price: WS cache first, REST fallback ──────────────────────────
      if (u.pathname === "/market/price") {
        const symbol = (u.searchParams.get("symbol") ?? "").toUpperCase();
        if (!symbol) return json(res, 400, { ok: false, error: "missing symbol" });

        // Try WS cache first (sub-second latency)
        const cached = getLatestPrice(symbol);
        if (cached !== null) {
          return json(res, 200, { ok: true, symbol, price: String(cached), source: "ws" });
        }

        // Fallback to REST if WS cache is empty or stale
        try {
          const r = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`, {
            signal: AbortSignal.timeout(8000),
          });
          const data: any = await r.json();
          return json(res, 200, { ok: true, symbol: data.symbol, price: data.price, source: "rest" });
        } catch (e: any) {
          return json(res, 502, { ok: false, error: e?.message ?? "price fetch failed" });
        }
      }

      // ── Batch market prices: WS cache first, REST fallback ───────────────────
      if (u.pathname === "/market/prices") {
        const symbols = (u.searchParams.get("symbols") ?? "")
          .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
        if (!symbols.length) return json(res, 400, { ok: false, error: "missing symbols" });

        const results: Record<string, string> = {};
        const wsHits: string[] = [];
        const restNeeded: string[] = [];

        // Check WS cache for each symbol
        for (const sym of symbols) {
          const p = getLatestPrice(sym);
          if (p !== null) { results[sym] = String(p); wsHits.push(sym); }
          else restNeeded.push(sym);
        }

        // REST fallback for any symbols not in WS cache
        if (restNeeded.length) {
          try {
            await Promise.all(restNeeded.map(async (sym) => {
              const r = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${sym}`, {
                signal: AbortSignal.timeout(8000),
              });
              const d: any = await r.json();
              results[sym] = d.price;
            }));
          } catch (e: any) {
            return json(res, 502, { ok: false, error: e?.message ?? "price fetch failed" });
          }
        }

        return json(res, 200, { ok: true, prices: results, wsHits, restFallback: restNeeded });
      }

      // ── Performance / closed trade history ───────────────────────────────────
      if (u.pathname === "/bot/performance") {
        const { loadClosedTrades } = await import("./services/cache/tradeCache.js");
        const { getRedis } = await import("./services/cache/redis.js");
        const limit = Math.min(Number(u.searchParams.get("limit") ?? "200"), 2000);
        const userKey = await resolveUserKey(req, u);
        if (!userKey) return json(res, 401, { ok: false, error: "authentication required" });
        const trades = await loadClosedTrades(getRedis(), userKey, limit);
        // Also compute summary metrics over all closed trades
        const { computeMetrics } = await import("./services/backtest/metrics.js");
        const metrics = computeMetrics(
          (trades as any[]).map(t => ({
            symbol: t.symbol ?? "?",
            isLong: t.isLong ?? false,
            entryPrice: t.entryPrice ?? 0,
            exitPrice: t.exitPrice ?? 0,
            pnlPct: t.pnlPct ?? 0,
            leverage: t.leverage ?? 5,
            durationMs: t.durationMs ?? 0,
            reason: t.reason ?? "?",
            closedAt: t.closedAt ?? 0,
          }))
        );
        return json(res, 200, { ok: true, count: trades.length, trades, metrics });
      }

      // ── Backtest: walk-forward strategy simulation ────────────────────────────
      if (u.pathname === "/backtest/run") {
        const symbol   = (u.searchParams.get("symbol") ?? "BTCUSDT").toUpperCase();
        const days     = Math.min(Math.max(Number(u.searchParams.get("days") ?? "7"), 1), 30);
        const leverage = Math.min(Math.max(Number(u.searchParams.get("leverage") ?? "5"), 1), 20);
        const stochOS  = Number(u.searchParams.get("stochOS") ?? currentTrigger.stochOS);
        const stochOB  = Number(u.searchParams.get("stochOB") ?? currentTrigger.stochOB);

        // Redis cache key: avoid re-running the same backtest within 1h
        const cacheKey = `backtest:${symbol}:${days}:${leverage}:${stochOS}:${stochOB}`;
        try {
          const cached = await getRedis().get(cacheKey);
          if (cached) {
            log.info({ cacheKey }, "[backtest] cache hit");
            return json(res, 200, { ok: true, cached: true, ...JSON.parse(cached) });
          }
        } catch { /* ignore Redis errors */ }

        try {
          const { runBacktest } = await import("./services/backtest/backtestRunner.js");
          const result = await runBacktest({ symbol, days, leverage, stochOS, stochOB });

          // Cache result in Redis for 1 hour
          try {
            await getRedis().set(cacheKey, JSON.stringify(result), "EX", 3600);
          } catch { /* ignore */ }

          return json(res, 200, { ok: true, cached: false, ...result });
        } catch (e: any) {
          log.error({ err: e?.message }, "[backtest] run failed");
          return json(res, 500, { ok: false, error: e?.message ?? "backtest failed" });
        }
      }

      // ── Phase 3: Risk / Circuit Breaker status ────────────────────────────────
      if (u.pathname === "/bot/risk") {
        const { checkCircuitBreaker, getDailyReturn } = await import("./services/bot/drawdownGuard.js");
        const maxLoss    = Math.abs(Number(process.env.MAX_DAILY_LOSS_PCT ?? "0.10"));
        const userKey    = await resolveUserKey(req, u);
        if (!userKey) return json(res, 401, { ok: false, error: "authentication required" });
        const cb         = await checkCircuitBreaker(getRedis(), userKey, maxLoss);
        const dailyReturn = await getDailyReturn(getRedis(), userKey);
        return json(res, 200, {
          ok: true,
          dailyReturn,
          dailyReturnPct: +(dailyReturn * 100).toFixed(2),
          circuitBreaker: {
            triggered: cb.triggered,
            limit:     cb.limit,
            limitPct:  +(cb.limit * 100).toFixed(2),
          },
          maxDailyLossPct: maxLoss,
          date: cb.date,
        });
      }

      // ── Phase 3: Circuit breaker manual reset (JWT-protected) ───────────────
      if (u.pathname === "/bot/risk/reset" && req.method === "POST") {
        const err = requireAuth(req);
        if (err) return json(res, 401, { ok: false, error: err });
        const { resetCircuitBreaker } = await import("./services/bot/drawdownGuard.js");
        const userKey = await resolveUserKey(req, u);
        if (!userKey) return json(res, 401, { ok: false, error: "authentication required" });
        await resetCircuitBreaker(getRedis(), userKey);
        return json(res, 200, { ok: true, message: "Circuit breaker reset for today" });
      }

      // ── Phase 3: AI model stats ───────────────────────────────────────────────
      if (u.pathname === "/ai/model") {
        const { getModelStats } = await import("./services/ai/signalScorer.js");
        const stats = await getModelStats(getRedis());
        return json(res, 200, { ok: true, ...stats });
      }

      // ── GET /vault/wallet-balance — wallet USDC + vault + fees + pending ──────
      if (u.pathname === "/vault/wallet-balance") {
        const authErr = requireAuth(req);
        if (authErr) return json(res, 401, { ok: false, error: authErr });
        try {
          const adminResult = await requireAdminRole(req);
          const user = await resolveUserKey(req, u, { allowQueryOverride: !("error" in adminResult) });
          if (!user) return json(res, 400, { ok: false, error: "no user configured" });
          const STABLE_DECIMALS = Number(process.env.STABLE_DECIMALS ?? "6");
          const readC = getVaultReadContract();

          // Fetch everything in parallel
          const [
            stableAddr,
            stableX18,
            pendingX18,
            minDeposit,
            depositFeeBps,
            withdrawFeeBps,
            emergencyFeeBps,
          ] = await Promise.all([
            readC.stable() as Promise<string>,
            readC.stableBalanceX18(user) as Promise<bigint>,
            readC.pendingStableWithdrawalX18(user) as Promise<bigint>,
            readC.minStableDeposit() as Promise<bigint>,
            readC.depositFeeBps() as Promise<bigint>,
            readC.withdrawFeeBps() as Promise<bigint>,
            readC.emergencyFeeBps() as Promise<bigint>,
          ]);

          // Wallet balance — shows the bot signer's USDC balance, since deposit
          // uses the bot signer wallet (getSigner()) to approve + depositStable.
          // User must first transfer USDC to the bot signer address before depositing.
          const signerAddress = getSigner().address;
          const wallet = await getWalletStableBalance(getProvider(), stableAddr, signerAddress, STABLE_DECIMALS);

          const BPS_DENOM = 10_000n;
          const fmtX18 = (x: bigint) => +(Number(x) / 1e18).toFixed(2);
          const fmtRaw = (x: bigint) => +(Number(x) / 10 ** STABLE_DECIMALS).toFixed(2);
          const fmtBps = (b: bigint) => +(Number(b) / 100).toFixed(2); // e.g. 1000 → 10.00%

          return json(res, 200, {
            ok: true,
            user,
            stableToken: stableAddr,
            vaultAddress: getVaultAddress(),
            wallet:    { raw: wallet.raw, formatted: wallet.formatted, decimals: STABLE_DECIMALS },
            vault:     { wad: stableX18.toString(), formatted: fmtX18(stableX18) },
            pending:   { wad: pendingX18.toString(), formatted: fmtX18(pendingX18) },
            minDeposit:{ raw: minDeposit.toString(), formatted: fmtRaw(minDeposit) },
            fees: {
              depositPct:   fmtBps(depositFeeBps),
              withdrawPct:  fmtBps(withdrawFeeBps),
              emergencyPct: fmtBps(emergencyFeeBps),
              depositNet:   +(Number(BPS_DENOM - depositFeeBps) / 100).toFixed(2),
              withdrawNet:  +(Number(BPS_DENOM - withdrawFeeBps) / 100).toFixed(2),
              emergencyNet: +(Number(BPS_DENOM - emergencyFeeBps) / 100).toFixed(2),
            },
          });
        } catch (e: any) {
          return json(res, 500, { ok: false, error: e?.message ?? String(e) });
        }
      }

      // ── POST /vault/deposit — ERC20 approve + depositStable ──────────────────
      if (u.pathname === "/vault/deposit" && req.method === "POST") {
        const err = requireAuth(req);
        if (err) return json(res, 401, { ok: false, error: err });
        try {
          const payload    = decodeToken(req);
          const userId     = payload?.userId ?? "legacy";
          const b = await readJson(req);
          const amountUsdc = parseFloat(b.amount);
          if (!amountUsdc || amountUsdc <= 0) return json(res, 400, { ok: false, error: "invalid amount" });
          const STABLE_DECIMALS = Number(process.env.STABLE_DECIMALS ?? "6");
          const amountRaw  = BigInt(Math.round(amountUsdc * 10 ** STABLE_DECIMALS));
          const readC      = getVaultReadContract();
          const stableAddr: string = await readC.stable();
          const minDeposit: bigint = await readC.minStableDeposit();
          if (amountRaw < minDeposit) {
            return json(res, 400, { ok: false, error: `Amount below minimum deposit of ${Number(minDeposit) / 10 ** STABLE_DECIMALS} USDC` });
          }
          const signer    = getSigner();
          const writeC    = getVaultWriteContract();
          const vaultAddr = getVaultAddress();

          // ── Platform fee: transfer 5% to FEE_WALLET before vault deposit ─────────
          // Splits the deposit: 5% to platform fee wallet, 95% to user vault.
          // FEE_WALLET_ADDRESS must be set in .env — skipped (with warning) if not set.
          const STABLE_DECIMALS_NUM = Number(process.env.STABLE_DECIMALS ?? "6");
          const feeRaw = BigInt(Math.round(Number(amountRaw) * FEE.DEPOSIT_BPS / FEE.BPS_DENOM));
          const netRaw = amountRaw - feeRaw;
          await transferUsdcFee(stableAddr, signer, feeRaw, "deposit-5pct");

          log.info({ amount: amountUsdc, netRaw: netRaw.toString(), feeRaw: feeRaw.toString(), stableAddr }, "[vault] deposit initiated");
          const r = await depositStableToVault(writeC, signer, stableAddr, vaultAddr, netRaw);
          log.info({ txHash: r.txHash, amount: amountUsdc }, "[vault] deposit confirmed");
          // Record platform fee
          const { fee: platformFee, net: netAfterFee } = await recordDeposit(getRedis(), userId, amountUsdc, r.txHash);
          const depositFeeBps: bigint = await readC.depositFeeBps();
          const netPct = +(Number(10_000n - depositFeeBps) / 100).toFixed(2);
          return json(res, 200, {
            ok: true,
            txHash: r.txHash,
            amount: amountUsdc,
            amountRaw: amountRaw.toString(),
            contractFee: `${100 - netPct}%`,
            platformFee: `${FEE.DEPOSIT_BPS / 100}%`,
            platformFeeUsdc: platformFee,
            netCredited: +(amountUsdc * netPct / 100).toFixed(2),
            netAfterAllFees: netAfterFee,
          });
        } catch (e: any) {
          log.error({ err: e?.message }, "[vault] deposit failed");
          return json(res, 500, { ok: false, error: e?.reason ?? e?.message ?? String(e) });
        }
      }

      // ── POST /vault/send-to-wallet — transfer USDC from bot signer to any address ─
      // Used to move "Wallet Balance" (held at bot signer address) to user's MetaMask.
      if (u.pathname === "/vault/send-to-wallet" && req.method === "POST") {
        const adminResult = await requireAdminRole(req);
        if ("error" in adminResult) {
          return json(res, adminResult.error === "unauthorized" ? 401 : 403, { ok: false, error: adminResult.error });
        }
        try {
          const b           = await readJson(req);
          const toAddress: string = String(b.toAddress ?? "").trim();
          const amountUsdc  = parseFloat(b.amount);
          if (!toAddress || !/^0x[0-9a-fA-F]{40}$/.test(toAddress))
            return json(res, 400, { ok: false, error: "Invalid destination address" });
          if (!amountUsdc || amountUsdc <= 0)
            return json(res, 400, { ok: false, error: "Invalid amount" });

          const STABLE_DECIMALS = Number(process.env.STABLE_DECIMALS ?? "6");
          const amountRaw = BigInt(Math.round(amountUsdc * 10 ** STABLE_DECIMALS));
          const readC     = getVaultReadContract();
          const stableAddr: string = await readC.stable();
          const signer    = getSigner();

          const { Contract } = await import("ethers");
          const { ERC20_ABI } = await import("./services/onchain/contractInstance.js");
          const stable = new Contract(stableAddr, ERC20_ABI, signer);
          const tx = await (stable as any).transfer(toAddress, amountRaw);
          const receipt = await waitWithFallback(tx);

          await auditLog(adminResult.userId, "vault:send-to-wallet", toAddress, `amount=${amountUsdc}`);
          log.info({ toAddress, amountUsdc, txHash: receipt.hash }, "[vault] send-to-wallet ✓");
          return json(res, 200, { ok: true, txHash: receipt.hash, amount: amountUsdc, toAddress });
        } catch (e: any) {
          log.error({ err: e?.message }, "[vault] send-to-wallet failed");
          return json(res, 500, { ok: false, error: e?.reason ?? e?.message ?? String(e) });
        }
      }

      // ── POST /vault/withdraw — normal 2-step (initiate+approve) or emergency ─
      if (u.pathname === "/vault/withdraw" && req.method === "POST") {
        const err = requireAuth(req);
        if (err) return json(res, 401, { ok: false, error: err });
        try {
          const payload  = decodeToken(req);
          const userId   = payload?.userId ?? "legacy";
          const b = await readJson(req);
          const mode: "normal" | "emergency" = b.emergency === true ? "emergency" : "normal";
          const signer   = getSigner();
          const writeC   = getVaultWriteContract();
          const readC    = getVaultReadContract();
          const user     = await resolveUserKey(req, u);
          if (!user) return json(res, 400, { ok: false, error: "no user configured" });

          // Resolve amount: number or "all"
          let amountRaw: bigint;
          const stableX18: bigint = await readC.stableBalanceX18(user);
          const vaultBalanceUsdc = +(Number(stableX18) / 1e18).toFixed(6);

          if (b.amount === "all" || b.all === true) {
            // Convert x18 → raw (6 decimals): divide by 1e12
            amountRaw = stableX18 / 1_000_000_000_000n;
            if (amountRaw === 0n) return json(res, 400, { ok: false, error: "vault balance is zero" });
          } else {
            const amountUsdc = parseFloat(b.amount);
            if (!amountUsdc || amountUsdc <= 0) return json(res, 400, { ok: false, error: 'invalid amount — send a number or "all"' });
            const STABLE_DECIMALS = Number(process.env.STABLE_DECIMALS ?? "6");
            amountRaw = BigInt(Math.round(amountUsdc * 10 ** STABLE_DECIMALS));
          }

          const amountUsdc = Number(amountRaw) / 1_000_000;

          // ── Calculate platform fees BEFORE initiating the withdrawal ──────────────
          // We approve only the NET amount to the user — the fee portion stays in the
          // vault and is swept to the platform fee wallet by the admin periodically.
          // This prevents the user from receiving the full gross while avoiding the
          // complexity of intercepting a direct vault-to-user USDC transfer.
          const fees = await recordWithdrawal(getRedis(), userId, amountUsdc, vaultBalanceUsdc, mode, undefined);
          const STABLE_DECIMALS_W = Number(process.env.STABLE_DECIMALS ?? "6");
          const netRawW  = BigInt(Math.max(0, Math.round(fees.net  * 10 ** STABLE_DECIMALS_W)));
          // Guard: never initiate a zero withdrawal
          if (netRawW === 0n) {
            return json(res, 400, { ok: false, error: "Withdrawal amount is fully consumed by fees", fees });
          }

          if (mode === "emergency") {
            // Emergency: single call, bypasses approval — higher fee (15%)
            log.info({ amount: amountUsdc, netRaw: netRawW.toString(), fees }, "[vault] emergency withdraw initiated");
            const r = await emergencyWithdrawFromVault(writeC, signer, netRawW);
            const feeBps: bigint = await readC.emergencyFeeBps();
            const contractNetReceived = +(fees.net * Number(10_000n - feeBps) / 10_000).toFixed(2);
            // Update fee log with txHash now that we have it
            await recordWithdrawal(getRedis(), userId, 0, vaultBalanceUsdc, "emergency", r.txHash).catch(() => {});
            log.info({ txHash: r.txHash, contractNetReceived, platformFees: fees }, "[vault] emergency withdraw confirmed");
            return json(res, 200, {
              ok: true, txHash: r.txHash, type: "emergency",
              amount: amountUsdc,
              contractFee: `${Number(feeBps)/100}%`,
              contractNetReceived,
              platformWithdrawFee: fees.withdrawFee,
              profitShare: fees.profitShare,
              totalPlatformFee: fees.totalFee,
              netReceived: fees.net,
            });
          } else {
            // Normal: initiate + approve for NET amount only (fee stays in vault)
            log.info({ amount: amountUsdc, netRaw: netRawW.toString(), fees }, "[vault] normal withdraw initiated");
            const r = await withdrawStableFromVault(writeC, signer, user, netRawW);
            const feeBps: bigint = await readC.withdrawFeeBps();
            const contractNetReceived = +(fees.net * Number(10_000n - feeBps) / 10_000).toFixed(2);
            log.info({ initTxHash: r.initTxHash, txHash: r.txHash, contractNetReceived, platformFees: fees }, "[vault] normal withdraw confirmed");
            return json(res, 200, {
              ok: true, initTxHash: r.initTxHash, txHash: r.txHash, type: "normal",
              amount: amountUsdc,
              contractFee: `${Number(feeBps)/100}%`,
              contractNetReceived,
              platformWithdrawFee: fees.withdrawFee,
              profitShare: fees.profitShare,
              totalPlatformFee: fees.totalFee,
              netReceived: fees.net,
            });
          }
        } catch (e: any) {
          log.error({ err: e?.message }, "[vault] withdraw failed");
          return json(res, 500, { ok: false, error: e?.reason ?? e?.message ?? String(e) });
        }
      }

      // ── POST /vault/approve-withdraw — Step 2 of normal withdrawal ──────────
      // Called by frontend AFTER user has already called initiateWithdrawStable()
      // via MetaMask (Step 1). Bot signer completes the approval.
      if (u.pathname === "/vault/approve-withdraw" && req.method === "POST") {
        const authErr = requireAuth(req);
        if (authErr) return json(res, 401, { ok: false, error: authErr });
        try {
          const payload  = decodeToken(req);
          const userId   = payload?.userId ?? "legacy";
          const b        = await readJson(req);
          const netAmountRaw = BigInt(b.netAmountRaw); // net after platform fee, as string
          const grossAmount  = parseFloat(b.grossAmount);
          const mode         = (b.mode ?? "normal") as "normal" | "emergency";
          const user         = await resolveUserKey(req, u);
          if (!user) return json(res, 400, { ok: false, error: "no user configured" });

          const signer  = getSigner();
          const writeC  = getVaultWriteContract();
          const readC   = getVaultReadContract();
          const stableX18: bigint = await readC.stableBalanceX18(user);
          const vaultBalanceUsdc  = +(Number(stableX18) / 1e18).toFixed(6);

          // Record platform fee
          const fees = await recordWithdrawal(getRedis(), userId, grossAmount, vaultBalanceUsdc, mode, undefined);

          // Bot approves the withdrawal — sends net USDC to user
          const approveTx = await (writeC.connect(signer) as any).approveWithdrawStable(user, netAmountRaw);
          const receipt   = await waitWithFallback(approveTx);
          const feeBps: bigint = await readC.withdrawFeeBps();
          const contractNetReceived = +(Number(netAmountRaw) / 1e6 * Number(10_000n - feeBps) / 10_000).toFixed(2);

          await recordWithdrawal(getRedis(), userId, 0, vaultBalanceUsdc, mode, receipt.hash).catch(() => {});
          log.info({ txHash: receipt.hash, contractNetReceived, platformFees: fees }, "[vault] approve-withdraw confirmed");
          return json(res, 200, {
            ok: true, txHash: receipt.hash, type: "normal",
            amount: grossAmount,
            platformWithdrawFee: fees.withdrawFee,
            profitShare: fees.profitShare,
            totalPlatformFee: fees.totalFee,
            netReceived: contractNetReceived,
          });
        } catch (e: any) {
          log.error({ err: e?.message }, "[vault] approve-withdraw failed");
          return json(res, 500, { ok: false, error: e?.reason ?? e?.message ?? String(e) });
        }
      }

      // ── POST /vault/record-emergency-withdraw — record emergency fee after user TX ─
      if (u.pathname === "/vault/record-emergency-withdraw" && req.method === "POST") {
        const authErr = requireAuth(req);
        if (authErr) return json(res, 401, { ok: false, error: authErr });
        try {
          const payload = decodeToken(req);
          const userId  = payload?.userId ?? "legacy";
          const b       = await readJson(req);
          const grossAmount = parseFloat(b.grossAmount);
          const txHash      = b.txHash as string;
          const readC       = getVaultReadContract();
          const user        = await resolveUserKey(req, u);
          if (!user) return json(res, 400, { ok: false, error: "no user configured" });
          const stableX18: bigint = await readC.stableBalanceX18(user);
          const vaultBalanceUsdc   = +(Number(stableX18) / 1e18).toFixed(6);
          const fees = await recordWithdrawal(getRedis(), userId, grossAmount, vaultBalanceUsdc, "emergency", txHash);
          return json(res, 200, { ok: true, txHash, fees });
        } catch (e: any) {
          return json(res, 500, { ok: false, error: e?.message ?? String(e) });
        }
      }

      // ── GET /fees/stats — per-user fee accounting + subscription status ──────
      if (u.pathname === "/fees/stats") {
        const authErr = requireAuth(req);
        if (authErr) return json(res, 401, { ok: false, error: authErr });
        try {
          const payload = decodeToken(req);
          const userId  = payload?.userId ?? "legacy";
          const user    = userId !== "legacy" ? await getUserById(getRedis(), userId) : null;
          const stats   = await getUserFeeStats(getRedis(), userId, user?.trialExpiresAt ?? null);
          return json(res, 200, { ok: true, ...stats });
        } catch (e: any) {
          return json(res, 500, { ok: false, error: e?.message ?? String(e) });
        }
      }

      // ── POST /subscription/pay — record subscription payment (20 USDC/month) ─
      if (u.pathname === "/subscription/pay" && req.method === "POST") {
        const authErr = requireAuth(req);
        if (authErr) return json(res, 401, { ok: false, error: authErr });
        try {
          const payload = decodeToken(req);
          const userId  = payload?.userId ?? "legacy";
          const b       = await readJson(req);
          const amount  = parseFloat(b.amount ?? FEE.SUBSCRIPTION_USDC);
          if (amount < FEE.SUBSCRIPTION_USDC) {
            return json(res, 400, { ok: false, error: `Minimum subscription payment is ${FEE.SUBSCRIPTION_USDC} USDC` });
          }
          const { paidUntil } = await recordSubscriptionPayment(getRedis(), userId, amount);
          log.info({ userId, amount, paidUntil }, "[subscription] payment recorded");
          return json(res, 200, { ok: true, paidUntil, amount, message: `Subscription active until ${paidUntil}` });
        } catch (e: any) {
          return json(res, 500, { ok: false, error: e?.message ?? String(e) });
        }
      }

      // ── GET /subscription/status — quick subscription check ──────────────────
      if (u.pathname === "/subscription/status") {
        const authErr = requireAuth(req);
        if (authErr) return json(res, 401, { ok: false, error: authErr });
        try {
          const payload = decodeToken(req);
          const userId  = payload?.userId ?? "legacy";
          const user    = userId !== "legacy" ? await getUserById(getRedis(), userId) : null;
          const status  = await checkSubscription(getRedis(), userId, user?.trialExpiresAt ?? null);
          return json(res, 200, { ok: true, userId, ...status, subscriptionUSDC: FEE.SUBSCRIPTION_USDC });
        } catch (e: any) {
          return json(res, 500, { ok: false, error: e?.message ?? String(e) });
        }
      }

      // ── GET /support/status — live system health for support widget ──────────
      if (u.pathname === "/support/status") {
        const botState = getState();
        // Check Redis connectivity
        let redisOk = false;
        try { await getRedis().ping(); redisOk = true; } catch { /* */ }
        // Check on-chain connectivity
        let chainOk = false;
        let blockNumber = 0;
        try {
          const provider = getProvider();
          blockNumber = Number(await provider.getBlockNumber());
          chainOk = blockNumber > 0;
        } catch { /* */ }
        // Open positions count
        let openPositions = 0;
        try {
          const c = getVaultReadContract();
          const userKey = await resolveUserKey(req, u);
          if (userKey) {
            const markets: string[] = await (c as any).getOpenMarkets(userKey);
            openPositions = Array.isArray(markets) ? markets.length : 0;
          }
        } catch { /* */ }
        return json(res, 200, {
          ok: true,
          services: {
            bot:   { status: botState.running ? "operational" : "stopped", running: botState.running },
            redis: { status: redisOk ? "operational" : "degraded" },
            chain: { status: chainOk ? "operational" : "degraded", blockNumber },
          },
          activeWorkers: workerPool.size,
          timestamp: Date.now(),
        });
      }

      // ── POST /support/ticket — submit a support request ───────────────────────
      if (u.pathname === "/support/ticket" && req.method === "POST") {
        try {
          const b = await readJson(req);
          if (!b.message || String(b.message).trim().length < 5)
            return json(res, 400, { ok: false, error: "message too short" });
          const ticket = {
            id: `TKT-${Date.now()}`,
            name:     String(b.name     ?? "Anonymous").slice(0, 80),
            email:    String(b.email    ?? "").slice(0, 120),
            category: String(b.category ?? "general").slice(0, 40),
            message:  String(b.message).slice(0, 2000),
            createdAt: Date.now(),
          };
          await getRedis().lpush("support:tickets", JSON.stringify(ticket));
          await getRedis().ltrim("support:tickets", 0, 999); // keep latest 1000
          log.info({ ticketId: ticket.id, category: ticket.category }, "[support] ticket submitted");
          return json(res, 200, { ok: true, ticketId: ticket.id, message: "Support request received. We'll respond within 24 hours." });
        } catch (e: any) {
          return json(res, 400, { ok: false, error: e?.message ?? "bad request" });
        }
      }

      return json(res, 404, { ok: false, error: "not found" });
    } catch (e: any) {
      recordError(e?.message ?? String(e));
      log.error({ err: e?.message, stack: e?.stack }, "[server] unhandled error");
      Sentry.captureException(e);
      return json(res, 500, { ok: false, error: e?.message ?? "internal error" });
    }
}

export function createHttpServer() {
  return http.createServer(handleRequest);
}

if (process.env.BACKEND_DISABLE_AUTO_START !== "1") {
  createHttpServer().listen(PORT, async () => {
    try {
      // ── Startup sequence ─────────────────────────────────────────────────────
      // 1. Connect Redis
      await connectRedis();

      // 2. Restore event history from Redis into in-memory ring buffer
      await restoreEventHistory();

      // 3. Start Binance WebSocket price stream for configured symbols
      startPriceStream(currentSymbols);

      // 4. Verify on-chain connection
      await assertOnchainReady();

      // 5. Auto-restart engine if it was running before crash/restart
      try {
        const redis = getRedis();
        const saved = await redis.get("bot:engine:autostart");
        if (saved) {
          const s = JSON.parse(saved);
          if (s.running && s.userKey) {
            if (Array.isArray(s.symbols) && s.symbols.length) currentSymbols = s.symbols;
            if (s.trigger) currentTrigger = s.trigger;
            updateStreamSymbols(currentSymbols);
            log.info({ userKey: s.userKey, symbols: currentSymbols }, "[server] auto-resuming engine after restart");
            await workerPool.startUser({
              userKey: s.userKey,
              symbols: currentSymbols,
              trigger: currentTrigger,
              strategy: s.strategy ?? "trend_range_fork",
              skipSubCheck: true,
            });
          }
        }
      } catch (e: any) {
        log.warn({ err: e?.message }, "[server] auto-restart check failed (non-fatal)");
      }

      log.info({ port: PORT, symbols: currentSymbols }, "[server] ready ✓");
    } catch (e: any) {
      log.error({ err: e?.message }, "[server] startup error");
    }
  });
}

// ── Global safety net ─────────────────────────────────────────────────────────
process.on("uncaughtException", (err: any) => {
  const code = err?.code ?? "";
  const msg  = err?.message ?? String(err);
  // Standard POSIX network error codes
  const networkCodes = ["EADDRNOTAVAIL", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND"];
  // ethers.js v6 messages for transient RPC connectivity issues (e.g. dead backend node)
  const networkMsgs  = ["could not coalesce", "connection refused", "missing response", "bad response", "timeout"];
  const isNetwork = networkCodes.includes(code) || networkMsgs.some(p => msg.toLowerCase().includes(p));
  if (isNetwork) {
    log.warn({ code, err: msg }, "[process] network error suppressed");
    recordError(`network: ${code || "RPC"} — ${msg}`);
  } else {
    log.error({ err: msg, stack: err?.stack }, "[process] uncaughtException");
    recordError(msg);
    Sentry.captureException(err);
  }
});

process.on("unhandledRejection", (reason: any) => {
  const msg = reason?.message ?? String(reason);
  log.warn({ err: msg }, "[process] unhandledRejection suppressed");
  recordError(msg);
  Sentry.captureException(reason instanceof Error ? reason : new Error(msg));
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on("SIGTERM", async () => {
  log.info("[process] SIGTERM received — shutting down");
  stopPriceStream();
  workerPool.stopAll();
  stopEngine();
  await disconnectRedis();
  process.exit(0);
});

process.on("SIGINT", async () => {
  log.info("[process] SIGINT received — shutting down");
  stopPriceStream();
  workerPool.stopAll();
  stopEngine();
  await disconnectRedis();
  process.exit(0);
});
