import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

process.env.BACKEND_DISABLE_AUTO_START = "1";

const { handleRequest } = await import("./index.js");

class MockReq extends Readable {
  method: string;
  url: string;
  headers: Record<string, string>;
  socket: { remoteAddress: string };
  private sent = false;
  private payload: Buffer;

  constructor(params: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
  }) {
    super();
    this.method = params.method;
    this.url = params.url;
    this.headers = params.headers ?? {};
    this.socket = { remoteAddress: "127.0.0.1" };
    this.payload = Buffer.from(params.body ?? "");
  }

  override _read() {
    if (this.sent) {
      this.push(null);
      return;
    }
    this.sent = true;
    if (this.payload.length) this.push(this.payload);
    this.push(null);
  }
}

class MockRes {
  statusCode = 200;
  headers = new Map<string, string>();
  body = "";

  setHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value);
  }

  end(chunk?: string) {
    if (chunk) this.body += chunk;
    return this;
  }
}

async function invoke(params: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}) {
  const req = new MockReq({
    method: params.method,
    url: params.path,
    headers: params.headers,
    body: params.body,
  });
  const res = new MockRes();

  await handleRequest(req as any, res as any);

  return {
    status: res.statusCode,
    body: res.body ? JSON.parse(res.body) : null,
    headers: Object.fromEntries(res.headers.entries()),
  };
}

test("POST /bot/start returns 410 Gone with replacement path", async () => {
  const res = await invoke({ method: "POST", path: "/bot/start" });
  assert.equal(res.status, 410);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.replacement, "/pool/start");
});

test("POST /bot/stop returns 410 Gone with replacement path", async () => {
  const res = await invoke({ method: "POST", path: "/bot/stop" });
  assert.equal(res.status, 410);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.replacement, "/pool/stop");
});

test("POST /bot/set rejects anonymous callers", async () => {
  const res = await invoke({
    method: "POST",
    path: "/bot/set",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ symbols: ["BTCUSDT"] }),
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, "unauthorized");
});

test("POST /vault/send-to-wallet rejects anonymous callers", async () => {
  const res = await invoke({
    method: "POST",
    path: "/vault/send-to-wallet",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ toAddress: "0x0000000000000000000000000000000000000000", amount: 1 }),
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, "unauthorized");
});

test("PATCH /me/bot/config rejects anonymous callers", async () => {
  const res = await invoke({
    method: "PATCH",
    path: "/me/bot/config",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ symbols: ["BTCUSDT"] }),
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, "unauthorized");
});

test("GET /bot/config rejects anonymous callers", async () => {
  const res = await invoke({
    method: "GET",
    path: "/bot/config",
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, "unauthorized");
});

test("GET /bot/state rejects anonymous callers", async () => {
  const res = await invoke({
    method: "GET",
    path: "/bot/state",
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, "unauthorized");
});

test("POST /me/bot/start rejects anonymous callers", async () => {
  const res = await invoke({
    method: "POST",
    path: "/me/bot/start",
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, "unauthorized");
});

test("POST /me/bot/stop rejects anonymous callers", async () => {
  const res = await invoke({
    method: "POST",
    path: "/me/bot/stop",
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, "unauthorized");
});
