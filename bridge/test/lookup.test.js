import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startLookup } from "../src/lookup.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Bật HTTP server bắt mọi POST /__register lại vào mảng `seen`. */
function withCaptureServer(seen) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ path: req.url, secret: req.headers["x-owm-secret"] ?? "", body: JSON.parse(body || "{}") });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("startLookup: đăng ký NGAY khi khởi động, body kèm tenant", async () => {
  const seen = [];
  const server = await withCaptureServer(seen);
  try {
    const { port } = server.address();
    let url = "https://abc123.trycloudflare.com";
    const lookup = startLookup({
      getUrl: () => url,
      workerUrl: `http://127.0.0.1:${port}`,
      secret: "s3cret",
      tenant: "Nam",
      tickMs: 30,
      heartbeatMs: 120,
      log: () => {},
    });
    await sleep(120);
    lookup.stop();
    url = "https://def456.trycloudflare.com"; // đổi sau stop -> không đăng ký nữa
    await sleep(80);

    assert.ok(seen.length >= 1, "phải đăng ký ít nhất 1 lần ngay khi khởi động");
    assert.equal(seen[0].path, "/__register");
    assert.equal(seen[0].secret, "s3cret");
    assert.equal(seen[0].body.tenant, "nam"); // chuẩn hóa chữ thường
    assert.match(seen[0].body.url, /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
  } finally {
    server.close();
  }
});

test("startLookup: không tenant thì body cũ {url}; cùng URL trong nhịp giữ ấm thì không ghi lặp", async () => {
  const seen = [];
  const server = await withCaptureServer(seen);
  try {
    const { port } = server.address();
    let url = "https://aaa.trycloudflare.com";
    const clock = { value: 1_000_000 }; // đồng hồ đóng băng: heartbeat không bao giờ kích hoạt
    const lookup = startLookup({
      getUrl: () => url,
      workerUrl: `http://127.0.0.1:${port}`,
      secret: "s",
      tickMs: 20,
      heartbeatMs: 100,
      log: () => {},
      now: () => clock.value,
    });
    await sleep(120);
    assert.ok(seen.length >= 1);
    assert.ok(!("tenant" in seen[0].body), "không tenant -> giữ body cũ");
    const afterFirst = seen.length;

    await sleep(80); // vài tick, cùng URL + chưa hết nhịp -> không đăng ký thêm
    assert.equal(seen.length, afterFirst);

    url = "https://bbb.trycloudflare.com"; // URL đổi -> đăng ký NGAY, không chờ nhịp
    await sleep(120);
    assert.ok(seen.length > afterFirst, "đổi URL phải đăng ký lại ngay");
    assert.equal(seen[seen.length - 1].body.url, "https://bbb.trycloudflare.com");
    lookup.stop();
  } finally {
    server.close();
  }
});

test("startLookup: tunnel chết -> báo tunnelDown theo bucket retryAt; sống lại -> đăng ký URL ngay", async () => {
  const seen = [];
  const server = await withCaptureServer(seen);
  try {
    const { port } = server.address();
    let url = "";
    let tstate = { phase: "backoff", url: "", streak: 2, nextRetryAt: 4000 };
    const lookup = startLookup({
      getUrl: () => url,
      getState: () => tstate,
      workerUrl: `http://127.0.0.1:${port}`,
      secret: "s",
      tenant: "pc-test",
      tickMs: 20,
      heartbeatMs: 1000,
      log: () => {},
    });
    await sleep(80);
    assert.ok(seen.length >= 1, "phải báo tunnelDown ngay tick đầu");
    assert.equal(seen[0].body.url, "");
    assert.equal(seen[0].body.tunnelDown, true);
    assert.equal(seen[0].body.retryAt, 4000);
    assert.equal(seen[0].body.tenant, "pc-test");
    const afterDown = seen.length;

    tstate = { phase: "backoff", url: "", streak: 2, nextRetryAt: 4200 }; // cùng bucket 4 -> không gửi lại
    await sleep(80);
    assert.equal(seen.length, afterDown, "cùng bucket retryAt không ghi lặp KV");

    tstate = { phase: "backoff", url: "", streak: 3, nextRetryAt: 8000 }; // bucket 8 -> báo lại
    await sleep(80);
    assert.ok(seen.length > afterDown, "retryAt đổi bucket phải báo lại");
    assert.equal(seen[seen.length - 1].body.retryAt, 8000);

    url = "https://ccc.trycloudflare.com"; // tunnel sống lại -> đăng ký URL NGAY
    tstate = { phase: "up", url, streak: 0, nextRetryAt: 0 };
    await sleep(80);
    const last = seen[seen.length - 1];
    assert.equal(last.body.url, "https://ccc.trycloudflare.com");
    assert.ok(!("tunnelDown" in last.body), "đăng ký URL bình thường, hết cờ tunnelDown");
    lookup.stop();
  } finally {
    server.close();
  }
});

test("startLookup: tunnel chết mà không có getState (instance cũ) thì KHÔNG tự bịa tunnelDown", async () => {
  const seen = [];
  const server = await withCaptureServer(seen);
  try {
    const { port } = server.address();
    const lookup = startLookup({
      getUrl: () => "", // không có URL, không getState
      workerUrl: `http://127.0.0.1:${port}`,
      secret: "s",
      tickMs: 20,
      heartbeatMs: 1000,
      log: () => {},
    });
    await sleep(100);
    assert.equal(seen.length, 0, "không có getState thì không gửi gì cả");
    lookup.stop();
  } finally {
    server.close();
  }
});

test("startLookup: 401 thì backoff — không hét mỗi tick một lần", async () => {
  const seen = [];
  const logs = [];
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push(JSON.parse(body || "{}"));
        res.writeHead(401, { "content-type": "application/json" });
        res.end('{"error":"unauthorized"}');
      });
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const { port } = server.address();
    const clock = { value: 1_000_000 }; // đồng hồ đóng băng: backoff không bao giờ hết
    const lookup = startLookup({
      getUrl: () => "https://xyz.trycloudflare.com",
      workerUrl: `http://127.0.0.1:${port}`,
      secret: "s",
      tickMs: 20,
      heartbeatMs: 100_000,
      log: (m) => logs.push(m),
      now: () => clock.value,
    });
    await sleep(150);
    lookup.stop();
    assert.equal(seen.length, 1, "401 liên tục vẫn chỉ 1 lần gửi trong cửa sổ backoff");
    assert.ok(
      logs.some((m) => m.includes("HTTP 401") && m.includes("lookupTenant")),
      "phải log 1 dòng rõ ràng kèm gợi ý kiểm tra config"
    );
  } finally {
    server.close();
  }
});
