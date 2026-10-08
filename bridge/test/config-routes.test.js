// POST /api/config/identity — cửa hẹp để GUI desktop lưu định danh máy qua
// bridge thay vì ghi config.json trực tiếp (candidate 3, 06/10). Khóa ở đây:
//   1. Master token ghi được ĐÚNG 4 key whitelist, xuống đĩa thật (temp dir).
//   2. Token thiết bị (owd_) bị chặn 403 master_only — lookupSecret là mật
//      khẩu phòng, điện thoại đã ghép không được đụng.
//   3. Key ngoài whitelist (mobileToken!) bị bỏ qua — route không phải cửa sau.
//   4. machineName đi cùng phép làm sạch với /api/machine/name.
//   5. Body hỏng / không có key hợp lệ → 400, không ghi gì.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { PairingService } from "../src/pairing.js";

const MASTER = "owm_master_token_for_test";

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

// Mỗi test một app riêng (rate-limit bám IP) + OPENWORK_BRIDGE_DIR trỏ temp:
// saveConfig ghi config.json vào bridgeDataDir() theo env LÚC GỌI — không cô
// lập là ghi vào store thật của máy đang chạy test.
async function withApp(configPatch, run, depsPatch = {}) {
  const dir = mkdtempSync(join(tmpdir(), "owm-config-routes-"));
  const prevDir = process.env.OPENWORK_BRIDGE_DIR;
  process.env.OPENWORK_BRIDGE_DIR = dir;
  const config = makeConfig(configPatch);
  const pairing = new PairingService();
  const state = {
    server: null,
    tokenActive: false,
    restartRequired: false,
    tunnelUrl: "",
    ...(depsPatch.state ?? {}),
  };
  const { server, ctx } = createApp({
    config,
    state,
    pairing,
    bridgeVersion: "0.0.0-test",
    handleStatic: (_req, res) => {
      res.writeHead(404);
      res.end();
    },
    refreshDiscovery: async () => {},
    tunnel: depsPatch.tunnel ?? {
      getState: () => ({ phase: "starting", url: "", streak: 0, nextRetryAt: 0 }),
      restart: () => false,
    },
    getBaseUrl: () => "http://127.0.0.1:8788",
    ...depsPatch,
  });
  server.requestTimeout = 0;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, config, pairing, state, ctx, dir });
  } finally {
    await new Promise((r) => server.close(r));
    if (prevDir === undefined) delete process.env.OPENWORK_BRIDGE_DIR;
    else process.env.OPENWORK_BRIDGE_DIR = prevDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

function post(base, path, token, body) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function storedIdentity(dir) {
  // undefined = chưa có file nào được ghi (tức route không ghi gì — cũng là
  // một kết quả cần khẳng định được, nên helper không ném ENOENT)
  const file = join(dir, "config.json");
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

test("master token ghi được đúng 4 key whitelist, xuống config.json trên đĩa", async () => {
  await withApp({}, async ({ base, config, dir }) => {
    const res = await post(base, "/api/config/identity", MASTER, {
      lookupUrl: "https://openpocket.example.workers.dev",
      lookupTenant: "pc-testroom1",
      lookupSecret: "ows_abcd",
      machineName: "DESK-OP",
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.applied.length, 4);

    // Cả RAM lẫn đĩa phải thấy cùng giá trị
    assert.equal(config.lookupTenant, "pc-testroom1");
    const stored = storedIdentity(dir);
    assert.equal(stored.lookupTenant, "pc-testroom1");
    assert.equal(stored.lookupSecret, "ows_abcd");
    assert.equal(stored.lookupUrl, "https://openpocket.example.workers.dev");
    assert.equal(stored.machineName, "DESK-OP");
  });
});

test("token thiết bị (owd_) bị chặn 403 master_only, không ghi gì", async () => {
  await withApp({}, async ({ base, pairing, dir }) => {
    const minted = pairing.mintDevice("Điện thoại Tester");
    const res = await post(base, "/api/config/identity", minted.token, {
      lookupSecret: "ows_hijack",
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "master_only");
    assert.equal(storedIdentity(dir)?.lookupSecret, undefined, "403 thì không được ghi gì xuống đĩa");
  });
});

test("key ngoài whitelist bị bỏ qua — mobileToken không đổi được qua đây", async () => {
  await withApp({}, async ({ base, dir }) => {
    const res = await post(base, "/api/config/identity", MASTER, {
      mobileToken: "owm_hijack",
      ownerToken: "hijack",
      port: 9999,
      lookupTenant: "pc-okroom22",
    });
    assert.equal(res.status, 200);
    const stored = storedIdentity(dir);
    assert.equal(stored.lookupTenant, "pc-okroom22");
    assert.equal(stored.mobileToken, MASTER, "mobileToken phải giữ nguyên");
    assert.equal(stored.ownerToken, "owner-token");
    assert.equal(stored.port, 8788);
  });
});

test("machineName được làm sạch như /api/machine/name (bỏ [\r\n\"'], cắt 60)", async () => {
  await withApp({}, async ({ base, dir }) => {
    const res = await post(base, "/api/config/identity", MASTER, {
      machineName: 'bad"\r\nname' + "x".repeat(80),
    });
    assert.equal(res.status, 200);
    const stored = storedIdentity(dir);
    assert.equal(stored.machineName, "badname" + "x".repeat(53));
    assert.ok(stored.machineName.length <= 60);
  });
});

test("body hỏng → 400 invalid_body; body rỗng → 400 no_valid_keys, không ghi", async () => {
  await withApp({}, async ({ base, dir }) => {
    const bad = await post(base, "/api/config/identity", MASTER, "{not json");
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, "invalid_body");

    const empty = await post(base, "/api/config/identity", MASTER, {});
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).code, "no_valid_keys");
    assert.equal(storedIdentity(dir), undefined, "không được ghi config.json khi không có key hợp lệ");
  });
});

test("thiếu token → 401 như mọi route kín khác", async () => {
  await withApp({}, async ({ base }) => {
    const res = await post(base, "/api/config/identity", null, { lookupTenant: "pc-anon" });
    assert.equal(res.status, 401);
  });
});
