// ── User Store — Redis CRUD ────────────────────────────────────────────────────
// Redis key schema:
//   user:{userId}           → JSON user object
//   user:by-email:{email}   → userId (lookup index)
//   users:list              → Redis SET of all userIds

import { v4 as uuidv4 } from "uuid";
import type { Redis } from "ioredis";

// ── Types ──────────────────────────────────────────────────────────────────────

export type UserRole = "admin" | "support" | "user";
export type UserStatus =
  | "pending_email"
  | "pending_approval"
  | "active"
  | "suspended";

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  walletAddress: string;        // MetaMask wallet (EVM address)
  vaultAddress: string;         // Assigned vault contract (set on approval)
  role: UserRole;
  status: UserStatus;
  emailVerifyToken: string;     // UUID token, cleared after verification
  trialExpiresAt: string | null; // ISO timestamp — 14 days from registration
  createdAt: string;            // ISO timestamp
  approvedAt: string | null;    // ISO timestamp
}

export type CreateUserData = Pick<
  User,
  "email" | "passwordHash" | "walletAddress"
> & { role?: UserRole };

// ── Key helpers ────────────────────────────────────────────────────────────────

const key = (id: string) => `user:${id}`;
const emailKey = (email: string) => `user:by-email:${email.toLowerCase()}`;
const LIST_KEY = "users:list";

// ── CRUD functions ────────────────────────────────────────────────────────────

export async function createUser(
  redis: Redis,
  data: CreateUserData
): Promise<User> {
  const id = uuidv4();
  const now = new Date().toISOString();

  // 14-day trial from registration
  const trialExpiresAt = new Date(
    Date.now() + 14 * 24 * 60 * 60 * 1000
  ).toISOString();

  const user: User = {
    id,
    email: data.email.toLowerCase(),
    passwordHash: data.passwordHash,
    walletAddress: data.walletAddress,
    vaultAddress: "",
    role: data.role ?? "user",
    status: "pending_email",
    emailVerifyToken: uuidv4(),
    trialExpiresAt,
    createdAt: now,
    approvedAt: null,
  };

  const pipeline = redis.pipeline();
  pipeline.set(key(id), JSON.stringify(user));
  pipeline.set(emailKey(user.email), id);
  pipeline.sadd(LIST_KEY, id);
  await pipeline.exec();

  return user;
}

export async function getUserById(
  redis: Redis,
  id: string
): Promise<User | null> {
  const raw = await redis.get(key(id));
  return raw ? (JSON.parse(raw) as User) : null;
}

export async function getUserByEmail(
  redis: Redis,
  email: string
): Promise<User | null> {
  const id = await redis.get(emailKey(email.toLowerCase()));
  if (!id) return null;
  return getUserById(redis, id);
}

export async function getUserByVerifyToken(
  redis: Redis,
  token: string
): Promise<User | null> {
  const ids = await redis.smembers(LIST_KEY);
  for (const id of ids) {
    const user = await getUserById(redis, id);
    if (user?.emailVerifyToken === token) return user;
  }
  return null;
}

export async function updateUser(
  redis: Redis,
  id: string,
  patch: Partial<User>
): Promise<User | null> {
  const user = await getUserById(redis, id);
  if (!user) return null;

  // Handle email change: update email index
  if (patch.email && patch.email.toLowerCase() !== user.email) {
    const pipeline = redis.pipeline();
    pipeline.del(emailKey(user.email));
    pipeline.set(emailKey(patch.email.toLowerCase()), id);
    await pipeline.exec();
    patch.email = patch.email.toLowerCase();
  }

  const updated = { ...user, ...patch };
  await redis.set(key(id), JSON.stringify(updated));
  return updated;
}

export async function listAllUsers(redis: Redis): Promise<User[]> {
  const ids = await redis.smembers(LIST_KEY);
  const users = await Promise.all(ids.map((id) => getUserById(redis, id)));
  return (users.filter(Boolean) as User[]).sort(
    (a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export async function deleteUser(redis: Redis, id: string): Promise<boolean> {
  const user = await getUserById(redis, id);
  if (!user) return false;

  const pipeline = redis.pipeline();
  pipeline.del(key(id));
  pipeline.del(emailKey(user.email));
  pipeline.srem(LIST_KEY, id);
  await pipeline.exec();

  return true;
}

// ── Admin seeding ─────────────────────────────────────────────────────────────
// Called on first login with the legacy password hash when users:list is empty.
// Creates a single admin user so the admin can log in and manage others.

export async function seedAdminIfEmpty(
  redis: Redis,
  email: string,
  passwordHash: string
): Promise<User | null> {
  const count = await redis.scard(LIST_KEY);
  if (count > 0) return null; // already seeded

  const user = await createUser(redis, {
    email,
    passwordHash,
    walletAddress: "",
    role: "admin",
  });

  // Admin is pre-approved — mark active immediately
  return updateUser(redis, user.id, {
    status: "active",
    emailVerifyToken: "",
    approvedAt: new Date().toISOString(),
  });
}
