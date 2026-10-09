// Host contract — khoá CỘT chân lý shared/host-contract.js vào cả hai bên
// tiêu thụ (candidate 1, review 07/10). Bên C# không có test runner nên lớp
// phòng vệ của nó là: (1) bản sinh HostContract.cs đến từ cùng module này qua
// gen-host-contract.mjs, (2) test dưới đây khoá nội dung bản render + các
// điểm JS còn giữ literal có chủ ý (writer tunnel-state, snapshot /api/state).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_CONTRACT } from "../../shared/host-contract.js";
import { BRIDGE_ROUTES, OW_PROXY_PREFIX, TENANT_CREATE_PATH } from "../../shared/contract.js";
import { renderHostContractCs, renderRoutePathsCs } from "../../desktop/gen-host-contract.mjs";
import { bridgeDataDir, loadConfig } from "../src/config.js";
import { LOG_NAMES } from "../src/logwipe.js";
import { AUTOSTART_TASK_NAME, WATCHDOG_TASK_NAME } from "../src/autostart.js";
import { tunnelStateFile, loadTunnelState, saveTunnelState, tunnelStateSnapshot } from "../src/tunnel.js";

const SHARED_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "shared");

test("host contract module is pure — no imports, no node/browser API", () => {
  const source = readFileSync(join(SHARED_DIR, "host-contract.js"), "utf8");
  assert.equal(/^import |require\(|process\.|window\.|document\./m.test(source), false);
});

test("bridge data dir and config defaults come from the contract", () => {
  const savedEnv = process.env.OPENWORK_BRIDGE_DIR;
  delete process.env.OPENWORK_BRIDGE_DIR;
  const savedAppData = process.env.APPDATA;
  try {
    process.env.APPDATA = mkdtempSync(join(tmpdir(), "host-contract-"));
    assert.ok(bridgeDataDir().endsWith(HOST_CONTRACT.dataDirName));
    assert.equal(loadConfig().port, HOST_CONTRACT.bridgePort);
  } finally {
    if (savedEnv === undefined) delete process.env.OPENWORK_BRIDGE_DIR;
    else process.env.OPENWORK_BRIDGE_DIR = savedEnv;
    if (savedAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = savedAppData;
  }
});

test("loadConfig answers every config key the desktop GUI reads", () => {
  const config = loadConfig();
  for (const key of HOST_CONTRACT.configKeys) {
    assert.ok(key in config, `config.json key "${key}" must exist in loadConfig output`);
  }
});

test("log names and scheduler task names come from the contract", () => {
  assert.deepEqual(LOG_NAMES, Object.values(HOST_CONTRACT.logNames));
  assert.equal(AUTOSTART_TASK_NAME, HOST_CONTRACT.autostartTaskName);
  assert.equal(WATCHDOG_TASK_NAME, HOST_CONTRACT.watchdogTaskName);
});

test("tunnel-state.json writer keys match the contract (fallback file shape)", () => {
  const savedEnv = process.env.OPENWORK_BRIDGE_DIR;
  process.env.OPENWORK_BRIDGE_DIR = mkdtempSync(join(tmpdir(), "host-contract-"));
  try {
    saveTunnelState({ phase: "up", url: "https://x.trycloudflare.com", streak: 0, nextAttemptAt: 0 });
    const written = JSON.parse(readFileSync(tunnelStateFile(), "utf8"));
    assert.deepEqual(
      Object.keys(written).filter((k) => k !== "updatedAt").sort(),
      [...HOST_CONTRACT.tunnelStateKeys].sort()
    );
    assert.equal(loadTunnelState().phase, "up");
  } finally {
    rmSync(process.env.OPENWORK_BRIDGE_DIR, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.OPENWORK_BRIDGE_DIR;
    else process.env.OPENWORK_BRIDGE_DIR = savedEnv;
  }
});

test("tunnel state snapshot matches the /api/state tunnel shape", () => {
  const snapshot = tunnelStateSnapshot("backoff", "", 2, 12345);
  assert.deepEqual(Object.keys(snapshot), HOST_CONTRACT.stateTunnelKeys);
  assert.equal(snapshot.nextRetryAt, 12345);
});

test("generated HostContract.cs carries the same knowledge for the C# side", () => {
  const cs = renderHostContractCs();
  assert.ok(cs.includes("internal static class HostContract"));
  assert.ok(cs.includes(`public const int BridgePort = ${HOST_CONTRACT.bridgePort};`));
  assert.ok(cs.includes(`public const string DataDirName = "${HOST_CONTRACT.dataDirName}";`));
  assert.ok(cs.includes(`public const string PidFileName = "${HOST_CONTRACT.pidFileName}";`));
  for (const name of Object.values(HOST_CONTRACT.logNames)) {
    assert.ok(cs.includes(`"${name}"`), `log name ${name} must reach the C# side`);
  }
  assert.ok(cs.includes(`public const string AutostartTaskName = "${HOST_CONTRACT.autostartTaskName}";`));
  for (const key of HOST_CONTRACT.configKeys) {
    assert.ok(cs.includes(`"${key}";`), `config key ${key} must reach the C# side`);
  }
  assert.ok(cs.includes(`public const string TunnelStateFileName = "${HOST_CONTRACT.tunnelStateFileName}";`));
  for (const key of HOST_CONTRACT.tunnelStateKeys) {
    assert.ok(cs.includes(`"${key}";`), `tunnel-state key ${key} must reach the C# side`);
  }
  for (const phase of HOST_CONTRACT.tunnelPhases) {
    assert.ok(cs.includes(`"${phase}";`), `tunnel phase ${phase} must reach the C# side`);
  }
  assert.ok(cs.includes(`public const string StateTunnelField = "${HOST_CONTRACT.stateTunnelField}";`));
  for (const key of HOST_CONTRACT.stateTunnelKeys) {
    assert.ok(cs.includes(`"${key}";`), `/api/state tunnel key ${key} must reach the C# side`);
  }
});

// Route map (candidate 3, review 09/10): đường API bridge + worker mà web
// client lẫn exe desktop C# gọi. Trước đây web gõ tay 13 chuỗi, exe gõ tay 5 —
// bridge đổi đường là tụi nó gọi 404 không test nào bắt. Giờ cả hai đọc
// shared/contract.js (web import trực tiếp, exe nhận bản sinh RoutePaths.cs).
test("route map matches the bridge's declared route table", () => {
  const routesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "routes");
  // Gộp source 6 file route: mọi đường trong contract phải xuất hiện nguyên
  // văn là một `match:` string trong bảng route thật, kẻo contract bye-pass
  // thực tại (thêm đường vào contract mà quên khai báo route là 404 thầm lặng).
  let routeTable = "";
  for (const file of ["config.js", "fs.js", "openwork.js", "pairing.js", "proxy.js", "status.js"]) {
    routeTable += readFileSync(join(routesDir, file), "utf8");
  }
  for (const [key, path] of Object.entries(BRIDGE_ROUTES)) {
    assert.ok(
      routeTable.includes(`match: "${path}"`),
      `BRIDGE_ROUTES.${key} = "${path}" không có trong bảng route của bridge`
    );
  }
  // Prefix proxy khai báo dạng "*/api/ow/" — so nguyên văn luôn.
  assert.ok(routeTable.includes(`match: "*${OW_PROXY_PREFIX}/"`), `OW_PROXY_PREFIX ${OW_PROXY_PREFIX} phải khớp route prefix của bridge`);
});

test("generated RoutePaths.cs carries the same paths for the C# side", () => {
  const cs = renderRoutePathsCs();
  assert.ok(cs.includes("internal static class RoutePaths"));
  for (const [key, path] of Object.entries(BRIDGE_ROUTES)) {
    assert.ok(
      cs.includes(`public const string ${key.charAt(0).toUpperCase() + key.slice(1)} = "${path}";`),
      `route ${key} must reach the C# side`
    );
  }
  assert.ok(cs.includes(`public const string OwProxyPrefix = "${OW_PROXY_PREFIX}";`));
  assert.ok(cs.includes(`public const string TenantCreate = "${TENANT_CREATE_PATH}";`));
});
