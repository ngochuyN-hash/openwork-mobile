// GET /api/pairing-code — phân tách master vs device (FIX-1).
//
// Route này trả HAI loại thông tin khác bản chất:
//   - phần ghép (code / pairUrl / qr): ai có token cũng cần, kể cả thiết bị.
//   - phần master (masterUrl / masterQr): nhúng master token vào `/#t=`, tức
//     thứ VĨNH VIỄN — gỡ khóa thiết bị không thu hồi được nó.
//
// Nếu device key gọi được route này thì chỉ cần GỌI MỘT LẦN trước khi bị gỡ
// là cầm master vĩnh viễn, hỏng hẳn mô hình "mất máy → gỡ là sạch". Nên các
// test ở đây bắn HTTP thật vào createApp (cổng 0, deps giả) để đi qua đúng
// cổng khóa của app.js: master ⇔ `device` = null, device key ⇔ `device` ≠ null.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { PairingService } from "../src/pairing.js";

const MASTER = "owm_pairing_routes_master_token";

function makeConfig(extra = {}) {
  return {
    port: 8788,
    mobileToken: MASTER,
    ownerToken: "owner-token",
    lookupTenant: "",
    lookupSecret: "",
    machineName: "",
    openworkExe: "",
    publicUrl: "",
    ...extra,
  };
}

/** Mỗi test một app riêng (giống routes.test.js): rate-limit bám theo IP.
 *  QUAN TRỌNG: trỏ OPENWORK_BRIDGE_DIR vào thư mục tạm — PairingService ghi
 *  devices.json vào bridgeDataDir(), tức store THẬT của máy nếu không cô lập.
 */
async function withApp(configPatch, run) {
  const dir = mkdtempSync(join(tmpdir(), "owm-pairing-routes-"));
  const prevDir = process.env.OPENWORK_BRIDGE_DIR;
  process.env.OPENWORK_BRIDGE_DIR = dir;
  const config = makeConfig(configPatch);
  const pairing = new PairingService();
  const { server } = createApp({
    config,
    state: { server: null, tokenActive: false, restartRequired: false, tunnelUrl: "" },
    pairing,
    bridgeVersion: "0.0.0-test",
    handleStatic: (_req, res) => {
      res.writeHead(404);
      res.end();
    },
    refreshDiscovery: async () => {},
    tunnel: { getState: () => ({ phase: "starting", url: "", streak: 0, nextRetryAt: 0 }), restart: () => false },
    getBaseUrl: () => "http://127.0.0.1:8788",
  });
  server.requestTimeout = 0;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, config, pairing });
  } finally {
    await new Promise((r) => server.close(r));
    if (prevDir === undefined) delete process.env.OPENWORK_BRIDGE_DIR;
    else process.env.OPENWORK_BRIDGE_DIR = prevDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

function get(base, path, token) {
  return fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
}

test("master token gọi /api/pairing-code → có masterUrl nhúng đúng mobileToken và có masterQr", async () => {
  await withApp({}, async ({ base, config }) => {
    const res = await get(base, "/api/pairing-code", MASTER);
    assert.equal(res.status, 200);
    const body = await res.json();

    // baseUrl cố định của test → masterUrl dựng được và mang đúng master token.
    assert.equal(body.baseUrl, "http://127.0.0.1:8788");
    assert.equal(body.masterUrl, `http://127.0.0.1:8788/#t=${config.mobileToken}`);
    assert.ok(body.masterUrl.includes(MASTER), "masterUrl phải chứa đúng master token");
    assert.ok(body.masterQr.length > 0, "master phải có QR để quét");
  });
});

test("device key gọi /api/pairing-code → KHÔNG có masterUrl/masterQr, vẫn đủ phần ghép", async () => {
  await withApp({}, async ({ base, pairing }) => {
    // Mint bằng PairingService thật để khóa đi qua pairing.authenticate() như
    // app.js làm — không dựng device giả, test phải đúng đường thật.
    const minted = pairing.mintDevice("Điện thoại user");
    const res = await get(base, "/api/pairing-code", minted.token);
    assert.equal(res.status, 200);
    const body = await res.json();

    // THỨ NGUYÊN: thiếu hẳn 2 field master, không trả "" rỗng — dễ thấy bằng
    // mắt khi soi network tab, và không có chỗ nào chứa master token.
    assert.equal(Object.hasOwn(body, "masterUrl"), false, "device key không được thấy masterUrl");
    assert.equal(Object.hasOwn(body, "masterQr"), false, "device key không được thấy masterQr");
    assert.ok(
      !JSON.stringify(body).includes(MASTER),
      "không field nào của device được phép chứa master token"
    );

    // Phần ghép thì vẫn đủ: đây là thông tin đã dành cho thiết bị đó.
    assert.ok(body.code.length > 0);
    assert.equal(body.code, pairing.ensureCode());
    assert.equal(body.codeFormatted, `${body.code.slice(0, 4)}-${body.code.slice(4)}`);
    assert.equal(body.pairUrl, `http://127.0.0.1:8788/#p=${body.code}`);
    assert.ok(body.qr.length > 0, "device vẫn phải nhận được QR ghép");
    assert.ok(body.secondsLeft > 0);
  });
});

test("/api/pairing-code không token → 401 unauthorized (route KHÔNG public)", async () => {
  await withApp({}, async ({ base }) => {
    const res = await get(base, "/api/pairing-code");
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, "unauthorized");
  });
});
