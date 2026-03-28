import test from "node:test";
import assert from "node:assert/strict";

import {
  adminRouteHttpStatus,
  buildRetiredRouteResponse,
  getRetiredLegacyBotRoute,
} from "./routePolicies.js";

test("adminRouteHttpStatus maps auth failures to expected HTTP codes", () => {
  assert.equal(adminRouteHttpStatus("unauthorized"), 401);
  assert.equal(adminRouteHttpStatus("forbidden"), 403);
  assert.equal(adminRouteHttpStatus("session expired"), 403);
});

test("getRetiredLegacyBotRoute exposes replacements for retired single-user routes", () => {
  assert.deepEqual(getRetiredLegacyBotRoute("/bot/start"), { replacement: "/pool/start" });
  assert.deepEqual(getRetiredLegacyBotRoute("/bot/stop"), { replacement: "/pool/stop" });
  assert.equal(getRetiredLegacyBotRoute("/pool/start"), null);
});

test("buildRetiredRouteResponse returns 410 contract for retired legacy routes", () => {
  assert.deepEqual(buildRetiredRouteResponse("/bot/start"), {
    status: 410,
    body: {
      ok: false,
      error: "POST /bot/start has been retired. Use POST /pool/start instead.",
      replacement: "/pool/start",
    },
  });

  assert.deepEqual(buildRetiredRouteResponse("/bot/stop"), {
    status: 410,
    body: {
      ok: false,
      error: "POST /bot/stop has been retired. Use POST /pool/stop instead.",
      replacement: "/pool/stop",
    },
  });
});
