// Token KHÔNG được đi trong URL nữa — đây là test khóa lại điều đó.
//
// Lý do có file riêng: `?_t=` từng là đường thứ hai bên cạnh header Bearer,
// sinh ra từ lúc web dán token lên query cho <img>/<iframe>/EventSource vì các
// thẻ đó không set được header. Token trong query rò ra nhiều hơn header rất
// nhiều: nằm trong history/URL bar, trong access log của Cloudflare và reverse
// proxy trước mặt bridge, và trong header Referer của mọi request đi tiếp từ
// trang đó. Web đã bỏ hẳn phía gửi (blobUrlFor ở web/src/api.js, sse.js: mọi
// request đi bằng header, <img>/<iframe> thì fetch rồi gắn blob:), nên nhánh
// cũ chỉ còn phục vụ PWA đã cài từ bundle cache trước đây. Chủ nhà quyết bỏ
// hẳn, chấp nhận PWA cũ phải mở lại web cho xong.
//
// Ba test dưới đây là biên bản của quyết định đó: cùng một token đúng, chỉ khác
// chỗ đặt nó. Query phải chết, header phải sống, không có gì thì vẫn 401.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { PairingService } from "../src/pairing.js";

// Token giả, chỉ sống trong config tạm của test này — không phải token thật
// của máy, không đụng store thật.
const MASTER = "owm_test_master_token_query";

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

/** Mỗi test một app riêng + thư mục dữ liệu riêng.
 *
 *  QUAN TRỌNG: OPENWORK_BRIDGE_DIR phải trỏ vào thư mục tạm, vì PairingService
 *  và saveConfig ghi devices.json/config.json vào bridgeDataDir() — ghi vào
 *  store THẬT của máy đang chạy test nếu không cô lập. bridgeDataDir() đọc env
 *  lúc GỌI chứ không lúc import, nên gán ở đây là đủ.
 *
 *  Mỗi app một cổng riêng (listen(0)) vì rate-limit bám theo IP 127.0.0.1 —
 *  dùng chung sẽ làm test sau nhận dính 429 của test trước.
 */
async function withApp(configPatch, run) {
  const dir = mkdtempSync(join(tmpdir(), "owm-query-token-"));
  const prevDir = process.env.OPENWORK_BRIDGE_DIR;
  process.env.OPENWORK_BRIDGE_DIR = dir;
  const config = makeConfig(configPatch);
  const pairing = new PairingService();
  const state = { server: null, tokenActive: false, restartRequired: false, tunnelUrl: "" };
  const { server } = createApp({
    config,
    state,
    pairing,
    bridgeVersion: "0.0.0-test",
    handleStatic: (_req, res) => {
      res.writeHead(404);
      res.end();
    },
    refreshDiscovery: async () => {},
    tunnel: {
      getState: () => ({ phase: "starting", url: "", streak: 0, nextRetryAt: 0 }),
      restart: () => false,
    },
    getBaseUrl: () => "http://127.0.0.1:8788",
    tenantHashSuffix: () => "",
  });
  server.requestTimeout = 0;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, config, pairing, state });
  } finally {
    await new Promise((r) => server.close(r));
    if (prevDir === undefined) delete process.env.OPENWORK_BRIDGE_DIR;
    else process.env.OPENWORK_BRIDGE_DIR = prevDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** GET không set header — đúng kiểu request mà đường `?_t=` từng phục vụ. */
function getNoHeader(base, path) {
  return fetch(`${base}${path}`);
}

function getBearer(base, path, token) {
  return fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
}

test("token ĐÚNG nằm trong query ?_t= vẫn 401 — đường này đã bị bỏ", async () => {
  await withApp({}, async ({ base }) => {
    const res = await getNoHeader(base, `/api/state?_t=${encodeURIComponent(MASTER)}`);
    assert.equal(res.status, 401, "?_t= phải chết: token trong query rò vào history, log và Referer");
    const body = await res.json();
    assert.equal(body.code, "unauthorized");
  });
});

test("device token (owd_) trong query cũng 401 — không ngoại lệ nào cho <img>/EventSource", async () => {
  await withApp({}, async ({ base, pairing }) => {
    const minted = pairing.mintDevice("Máy ảnh");
    const res = await getNoHeader(base, `/api/state?_t=${encodeURIComponent(minted.token)}`);
    assert.equal(res.status, 401, "khóa thiết bị cũng phải đi qua header, không nằm trong URL");
  });
});

test("token ĐÚNG trong header Bearer vẫn 200 — đường sống không bị cắt nhầm", async () => {
  await withApp({}, async ({ base }) => {
    const res = await getBearer(base, "/api/state", MASTER);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.thisDevice.id, "master");
  });
});

test("không token gì cả vẫn 401 (query rác cũng không giúp gì)", async () => {
  await withApp({}, async ({ base }) => {
    assert.equal((await getNoHeader(base, "/api/state")).status, 401);
    assert.equal((await getNoHeader(base, "/api/state?_t=")).status, 401);
    assert.equal((await getNoHeader(base, "/api/state?_t=token_rac")).status, 401);
    assert.equal((await getNoHeader(base, "/api/state?_t=&authorization=Bearer+owm_khong_co_that")).status, 401);
  });
});
