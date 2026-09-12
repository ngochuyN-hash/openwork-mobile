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
