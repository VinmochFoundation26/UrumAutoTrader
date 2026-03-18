#!/usr/bin/env node
/**
 * Generate a bcrypt hash for your dashboard login password.
 * Usage:  node scripts/hash-password.js <your-new-password>
 * Then paste the output into backend/.env as LOGIN_PASSWORD_HASH=<hash>
 */
const bcrypt = require("bcryptjs");
const password = process.argv[2];
if (!password || password.length < 8) {
  console.error("Usage: node scripts/hash-password.js <password>  (min 8 chars)");
  process.exit(1);
}
bcrypt.hash(password, 10).then((hash) => {
  console.log("\nAdd this to backend/.env:\n");
  console.log(`LOGIN_PASSWORD_HASH=${hash}\n`);
});
