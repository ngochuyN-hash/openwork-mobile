// Bảng route của bridge (src/app.js + src/routes/*) — thứ trước đây nằm
// trong một if-chain 500 dòng bên trong index.js, file KHÔNG export gì nên
// không test nào chạm tới được. Từ khi tách ra, handleRequest chạy được với
// deps giả: test này bắn HTTP thật vào createApp, không cần bridge chạy thật
// (không đụng config máy, không spawn tiến trình, không mở tunnel).
//
// Ranh giới quan trọng nhất phủ ở đây — và dễ bị phá nhất khi tách code:
//   1. /api/pair và /api/pair/tenant là DUY NHẤT chạy trước cổng khóa.
//   2. Đường /api/ KHÔNG tồn tại vẫn phải trả 401 khi thiếu token (không rò
//      đường dẫn), chỉ 404 not_found khi token hợp lệ.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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

/** Mỗi test một app riêng: rate-limit bám theo IP (127.0.0.1) nên dùng chung
 *  sẽ làm các test sau nhận dính 429 của test trước.
 *
 *  QUAN TRỌNG: mọi test ở đây phải trỏ OPENWORK_BRIDGE_DIR vào thư mục tạm.
 *  PairingService ghi devices.json và saveConfig ghi config.json vào
 *  bridgeDataDir() — vào store THẬT của máy đang chạy test nếu không cô lập.
 *  bridgeDataDir() đọc env lúc GỌI chứ không lúc import, nên gán ở đây là đủ.
 */
async function withApp(configPatch, run, depsPatch = {}) {
  const dir = mkdtempSync(join(tmpdir(), "owm-routes-"));
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
  const tunnel = depsPatch.tunnel ?? {
    getState: () => ({ phase: "starting", url: "", streak: 0, nextRetryAt: 0 }),
    restart: () => false,
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
    tunnel,
    getBaseUrl: () => "http://127.0.0.1:8788",
    ...depsPatch,
  });
  server.requestTimeout = 0;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, config, pairing, state, tunnel, ctx });
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

test("cổng khóa: /api/ không token → 401, không lộ đường dẫn", async () => {
  await withApp({}, async ({ base }) => {
    const res = await get(base, "/api/state");
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.code, "unauthorized");
  });
});

test("đường /api/ KHÔNG tồn tại: 401 khi thiếu token, 404 not_found khi có token", async () => {
  await withApp({}, async ({ base }) => {
    assert.equal((await get(base, "/api/khong-ton-tai")).status, 401);

    const res = await get(base, "/api/khong-ton-tai", MASTER);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).code, "not_found");
  });
});

test("sai verb trên đường có: POST /api/state không khớp route nào → 404", async () => {
  await withApp({}, async ({ base }) => {
    const res = await fetch(`${base}/api/state`, {
      method: "POST",
      headers: { authorization: `Bearer ${MASTER}` },
    });
    assert.equal(res.status, 404);
  });
});

test("master token vào được /api/state; body đủ trường web cần", async () => {
  await withApp({}, async ({ base }) => {
    const res = await get(base, "/api/state", MASTER);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.bridgeVersion, "0.0.0-test");
    // thisDevice phải báo đúng để web hiện "Master token" thay vì trống.
    assert.equal(body.thisDevice.id, "master");
    assert.equal(body.devices, 0);
  });
});

test("token thiết bị (owd_) vào được và thisDevice báo đúng id", async () => {
  await withApp({}, async ({ base, pairing }) => {
    const minted = pairing.mintDevice("Điện thoại Tester");
    const res = await get(base, "/api/state", minted.token);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.thisDevice.id, minted.device.id);
    assert.equal(body.thisDevice.label, "Điện thoại Tester");
  });
});

test("token rác bị chặn, token thu hồi chết ngay lập tức", async () => {
  await withApp({}, async ({ base, pairing }) => {
    assert.equal((await get(base, "/api/state", "owd_ban_dung_rac")).status, 401);

    const minted = pairing.mintDevice("Máy cũ");
    assert.equal((await get(base, "/api/state", minted.token)).status, 200);
    pairing.revoke(minted.device.id);
    assert.equal((await get(base, "/api/state", minted.token)).status, 401);
  });
});

// Đường `?_t=` (dành cho <img>/EventSource không set được header) đã bị bỏ
// vì token trên URL lọt vào history trình duyệt, access log proxy và Referer.
// <img>/<iframe> giờ fetch bằng header rồi gắn `blob:` — xem blobUrlFor ở
// web/src/api.js. Test này khóa lại cả hai phía: query chết, header sống.
test("device token trên query ?_t= → 401; qua header Bearer vẫn 200", async () => {
  await withApp({}, async ({ base, pairing }) => {
    const minted = pairing.mintDevice("Máy ảnh");
    // Không set header — chỉ query, đúng kiểu request mà đường này từng phục vụ.
    const res = await fetch(`${base}/api/state?_t=${encodeURIComponent(minted.token)}`);
    assert.equal(res.status, 401, "device token trong query phải chết, không có ngoại lệ nào");
    assert.equal((await get(base, "/api/state", minted.token)).status, 200, "đường header không bị cắt nhầm");
  });
});

test("/api/pair là route công khai: mã sai → 401 invalid_code (không phải unauthorized)", async () => {
  await withApp({}, async ({ base, pairing }) => {
    const res = await fetch(`${base}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "ZZZZ-ZZZZ", label: "x" }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.code, "invalid_code");
    assert.ok(pairing.ensureCode());
  });
});

test("/api/pair mã đúng → 200 và trả khóa thiết bị", async () => {
  await withApp({}, async ({ base, pairing }) => {
    const code = pairing.ensureCode();
    const res = await fetch(`${base}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, label: "Điện thoại mới" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.token.startsWith("owd_"));
  });
});

test("/api/pair body JSON hỏng → 400 invalid_body", async () => {
  await withApp({}, async ({ base }) => {
    const res = await fetch(`${base}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{khong phai json",
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "invalid_body");
  });
});

test("rate limit /api/pair: lần 11 trong cùng phút bị chặn (đổi mã lỗi trong code)", async () => {
  await withApp({}, async ({ base }) => {
    const call = () =>
      fetch(`${base}/api/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "ZZZZ-ZZZZ", label: "x" }),
      });
    for (let i = 0; i < 10; i++) {
      const res = await call();
      // 10 lần đầu đi qua rate limit → dừng ở tầng kiểm tra mã.
      assert.equal((await res.json()).code, "invalid_code", `lần ${i + 1}`);
    }
    // Lần 11 đụng trần → deny chung, KHÔNG phải invalid_code nữa.
    const blocked = await call();
    assert.equal(blocked.status, 401);
    assert.equal((await blocked.json()).code, "unauthorized");
  });
});

test("/api/pair/tenant: chưa join phòng → 404 not_joined", async () => {
  await withApp({}, async ({ base }) => {
    const res = await fetch(`${base}/api/pair/tenant`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: "tester", secret: "x" }),
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).code, "not_joined");
  });
});

test("/api/pair/tenant: sai mật khẩu → 401 invalid_credentials; đúng → 200 kèm tenant", async () => {
  const patch = { lookupTenant: "tester", lookupSecret: "secret-phong" };
  await withApp(patch, async ({ base }) => {
    const post = (body) =>
      fetch(`${base}/api/pair/tenant`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const wrong = await post({ user: "tester", secret: "sai" });
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).code, "invalid_credentials");

    const ok = await post({ user: "TESTER", secret: "secret-phong", label: "ĐT" });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.tenant, "tester");
    assert.equal(body.machineName, "tester");
  });
});

test("/api/pairing-code cần token và trả cả mã lẫn QR", async () => {
  await withApp({}, async ({ base, pairing }) => {
    assert.equal((await get(base, "/api/pairing-code")).status, 401);

    const res = await get(base, "/api/pairing-code", MASTER);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.code, pairing.ensureCode());
    assert.equal(body.codeFormatted, `${body.code.slice(0, 4)}-${body.code.slice(4)}`);
    assert.ok(body.qr.length > 0);
    assert.ok(body.masterQr.length > 0);
  });
});

test("thu hồi thiết bị qua DELETE /api/devices/:id", async () => {
  await withApp({}, async ({ base, pairing }) => {
    const minted = pairing.mintDevice("Máy cũ");

    const res = await fetch(`${base}/api/devices/${minted.device.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${MASTER}` },
    });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).devices, []);

    // Thu hồi lần hai id đã chết → 404 not_found.
    const again = await fetch(`${base}/api/devices/${minted.device.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${MASTER}` },
    });
    assert.equal(again.status, 404);
  });
});

test("/api/machine/name: tên rỗng → 400, tên hợp lệ → 200 và ghi config", async () => {
  await withApp({}, async ({ base, config }) => {
    const post = (body) =>
      fetch(`${base}/api/machine/name`, {
        method: "POST",
        headers: { authorization: `Bearer ${MASTER}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const empty = await post({ name: "   " });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).code, "invalid_name");

    const ok = await post({ name: 'Máy "chính"\r\n' });
    assert.equal(ok.status, 200);
    // Dấu xuống dòng, CR và nháy kép bị bóc, không giữ lại trong tên lưu xuống đĩa.
    assert.equal((await ok.json()).machineName, "Máy chính");
    assert.equal(config.machineName, "Máy chính");
  });
});

test("/api/tunnel/restart khi tunnel không chạy → 409 tunnel_inactive", async () => {
  await withApp({}, async ({ base }) => {
    const res = await fetch(`${base}/api/tunnel/restart`, {
      method: "POST",
      headers: { authorization: `Bearer ${MASTER}` },
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "tunnel_inactive");
  });
});

test("tunnel của app đổi được sau khi dựng (ô ghi trống, không bắt cứng lúc create)", async () => {
  // Giống hệt lúc index.js nhận được controller từ startQuickTunnel.
  const tunnel = { getState: () => ({ phase: "starting" }), restart: () => false };
  await withApp({}, async ({ base, ctx }) => {
    tunnel.restart = () => true;
    tunnel.getState = () => ({ phase: "connected", url: "https://x.trycloudflare.com" });
    assert.equal(ctx.tunnel.getState().phase, "connected");

    const res = await fetch(`${base}/api/tunnel/restart`, {
      method: "POST",
      headers: { authorization: `Bearer ${MASTER}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.tunnel.url, "https://x.trycloudflare.com");
  }, { tunnel });
});

test("/api/recheck ép quét lại rồi báo trạng thái", async () => {
  let forced = 0;
  await withApp({}, async ({ base }) => {
    const res = await fetch(`${base}/api/recheck`, {
      method: "POST",
      headers: { authorization: `Bearer ${MASTER}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(forced, 1);
    assert.equal(body.restartRequired, true);
  }, {
    state: { restartRequired: true },
    refreshDiscovery: async ({ force }) => {
      if (force) forced += 1;
    },
  });
});

test("/api/ow/: chưa có server → 503, và nói đúng lý do (restart vs mất kết nối)", async () => {
  await withApp({}, async ({ base, state }) => {
    const down = await get(base, "/api/ow/session", MASTER);
    assert.equal(down.status, 503);
    assert.equal((await down.json()).code, "upstream_unavailable");

    state.restartRequired = true;
    const restart = await get(base, "/api/ow/session", MASTER);
    assert.equal(restart.status, 503);
    assert.equal((await restart.json()).code, "restart_required");
  });
});

test("/api/ow/ cũng nằm sau cổng khóa", async () => {
  await withApp({}, async ({ base }) => {
    assert.equal((await get(base, "/api/ow/session")).status, 401);
  });
});

test("đường không phải /api/ rơi về static (GET) hoặc 405 (POST)", async () => {
  await withApp({}, async ({ base }) => {
    assert.equal((await get(base, "/")).status, 404); // stub static trả 404

    const posted = await fetch(`${base}/`, { method: "POST" });
    assert.equal(posted.status, 405);
  });
});

test("lỗi trong route → 500 JSON sạch, không làm chết tiến trình", async () => {
  await withApp({}, async ({ base }) => {
    const res = await fetch(`${base}/api/recheck`, {
      method: "POST",
      headers: { authorization: `Bearer ${MASTER}` },
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.code, "internal_error");
    assert.equal(body.message, "boom");
  }, {
    // Ném lỗi giả để bắt nhánh catch ở createServer.
    refreshDiscovery: async () => {
      throw new Error("boom");
    },
  });
});