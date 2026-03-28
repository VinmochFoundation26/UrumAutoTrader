import test from "node:test";
import assert from "node:assert/strict";

import {
  canOverrideUserQuery,
  hasValidAdminKeyHeader,
  validateWalletLinkMessage,
} from "./security.js";

const PREFIX = "UrumTrader wallet link";

test("hasValidAdminKeyHeader only accepts exact configured key", () => {
  assert.equal(hasValidAdminKeyHeader("secret", "secret"), true);
  assert.equal(hasValidAdminKeyHeader("secret", "wrong"), false);
  assert.equal(hasValidAdminKeyHeader("", "secret"), false);
});

test("canOverrideUserQuery only allows admin/support or valid admin key", () => {
  assert.equal(canOverrideUserQuery({ role: "admin" }, false), true);
  assert.equal(canOverrideUserQuery({ role: "support" }, false), true);
  assert.equal(canOverrideUserQuery({ role: "user" }, false), false);
  assert.equal(canOverrideUserQuery(null, true), true);
});

test("validateWalletLinkMessage requires bound user id and wallet address", () => {
  const wallet = "0xAbCDEF1234567890abcdef1234567890ABCDef12";
  const validMessage = `${PREFIX}
User ID: user-123
Wallet: ${wallet.toLowerCase()}`;

  assert.equal(validateWalletLinkMessage({
    message: validMessage,
    walletAddress: wallet,
    userId: "user-123",
    prefix: PREFIX,
  }), true);

  assert.equal(validateWalletLinkMessage({
    message: `${PREFIX}
User ID: another-user
Wallet: ${wallet.toLowerCase()}`,
    walletAddress: wallet,
    userId: "user-123",
    prefix: PREFIX,
  }), false);

  assert.equal(validateWalletLinkMessage({
    message: `${PREFIX}
User ID: user-123
Wallet: 0x0000000000000000000000000000000000000000`,
    walletAddress: wallet,
    userId: "user-123",
    prefix: PREFIX,
  }), false);
});
