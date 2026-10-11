// /api/state là kiến thức BA ĐẦU (bridge ghép — web poll đọc từng field — GUI
// C# ăn slice tunnel qua HostContract.cs), nhưng trước đây chỉ slice tunnel
// được ghim. Test này so response THẬT với STATE_SHAPE (shared/contract.js):
// HAI chiều ở cấp top-level, và hai chiều nested ở mọi object khác null.
// Đổi tên một field mà chưa sửa STATE_SHAPE là đỏ ngay — thay vì web đọc ra
// `undefined` im lặng.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { PairingService } from "../src/pairing.js";
import { STATE_SHAPE } from "../../shared/contract.js";
import { HOST_CONTRACT } from "../../shared/host-contract.js";

const MASTER = "owm_state_shape_master_token";

// So key HAI CHIỀU: shape không được hứa key ngoài response, response không
// được phát key ngoài shape (cùng cấp). Object lồng nhau thì so đệ quy khi CẢ
// HAI phía là object (runtime null/undefined thì bỏ qua — key top-level vẫn
// luôn hiện diện).
function assertSameKeys(actual, shape, path) {
  assert.deepEqual(
    Object.keys(actual ?? {}).sort(),
    Object.keys(shape).sort(),
    `key lệch tại ${path}`
  );
  for (const [key, sub] of Object.entries(shape)) {
    if (sub && typeof sub === "object" && !Array.isArray(sub) && actual?.[key] && typeof actual[key] === "object") {
      assertSameKeys(actual[key], sub, `${path}.${key}`);
    }
  }
}

async function withApp({ state }, run) {
  const dir = mkdtempSync(join(tmpdir(), "owm-state-shape-"));
  const dataDir = mkdtempSync(join(tmpdir(), "owm-state-shape-data-"));
  const prevBridge = process.env.OPENWORK_BRIDGE_DIR;
  const prevData = process.env.OPENWORK_DIR;
  process.env.OPENWORK_BRIDGE_DIR = dir;
  process.env.OPENWORK_DIR = dataDir;
  const { server } = createApp({
    config: { port: 8788, mobileToken: MASTER, ownerToken: "owner-token", lookupTenant: "pc-test", lookupSecret: "", machineName: "test-box", openworkExe: "", publicUrl: "" },
    state,
    pairing: new PairingService(),
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
    await run({ base, dataDir });
  } finally {
    await new Promise((r) => server.close(r));
    if (prevBridge === undefined) delete process.env.OPENWORK_BRIDGE_DIR;
    else process.env.OPENWORK_BRIDGE_DIR = prevBridge;
    if (prevData === undefined) delete process.env.OPENWORK_DIR;
    else process.env.OPENWORK_DIR = prevData;
    rmSync(dir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function fetchState(base) {
  const res = await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${MASTER}` } });
  assert.equal(res.status, 200);
  return res.json();
}

test("/api/state khớp STATE_SHAPE hai chiều (máy chưa thấy server/engine — các field null vẫn đủ key top-level)", async () => {
  await withApp(
    { state: { server: null, tokenActive: false, restartRequired: false, tunnelUrl: "" } },
    async ({ base }) => {
      const payload = await fetchState(base);
      assertSameKeys(payload, STATE_SHAPE, "state");
      // Các field có thể null vẫn phải present (chỉ key, giá trị nào cũng được).
      for (const key of ["server", "engine", "publicUrl"]) {
        assert.ok(key in payload, `${key} phải luôn hiện diện`);
      }
    }
  );
});

test("/api/state khớp nested khi server + engine đều có (registry giả trên đĩa)", async () => {
  await withApp(
    {
      state: {
        server: { baseUrl: "http://127.0.0.1:4090", version: "0.18.54", opencodeVersion: "0.18.54" },
        tokenActive: true,
        restartRequired: false,
        tunnelUrl: "https://tunnel.example",
      },
    },
    async ({ base, dataDir }) => {
      // readEngineRegistry đọc openworkFilePath("engine-instances.json") — ghi
      // registry giả để nhánh engine khác null cũng được ghim nested.
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(
        join(dataDir, "engine-instances.json"),
        JSON.stringify({ entries: [{ role: "primary", ownerPid: 4321, port: 4090 }] })
      );
      const payload = await fetchState(base);
      assertSameKeys(payload, STATE_SHAPE, "state");
      assert.equal(payload.engine.pid, 4321);
      assert.equal(payload.engine.enginePort, 4090);
      assert.deepEqual(Object.keys(payload.server).sort(), ["baseUrl", "opencodeVersion", "version"]);
    }
  );
});

test("STATE_SHAPE.tunnel khớp stateTunnelKeys của host-contract (hai tên KHÁC có chủ đích vẫn phải đồng bộ)", () => {
  // host-contract dùng `nextAttemptAt` cho FILE, /api/state dùng `nextRetryAt`
  // — hai nguồn phải được đổi CÙNG nhau khi tunnel đổi shape.
  assert.deepEqual(Object.keys(STATE_SHAPE.tunnel).sort(), [...HOST_CONTRACT.stateTunnelKeys].sort());
});
