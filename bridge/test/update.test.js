import { test } from "node:test";
import { once } from "node:events";
import { watchdogPaths } from "../scripts/ota-watchdog.mjs";
import assert from "node:assert/strict";
import fs, { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareVersions,
  shouldUpdateNow,
  sha256Hex,
  extractPayload,
  installRelease,
  restoreBackup,
  MIN_UPTIME_MS,
} from "../src/update.js";

test("compareVersions: số theo từng phần dấu chấm", () => {
  assert.equal(compareVersions("2026.09.15.1", "2026.09.15.2"), -1);
  assert.equal(compareVersions("2026.09.16.0", "2026.09.15.99"), 1);
  assert.equal(compareVersions("0.1.0", "0.1.0"), 0);
  assert.equal(compareVersions("0.2.0", "0.1.9"), 1);
  assert.equal(compareVersions("2026.09.15.1", "2025.12.31.0"), 1);
  assert.equal(compareVersions("1.0", "1.0.0"), 0); // phần thiếu = 0
});

test("shouldUpdateNow: đủ mọi cửa an toàn mới cho cập nhật", () => {
  const base = {
    remote: { version: "2026.09.16.0" },
    current: "2026.09.15.1",
    tunnel: { phase: "up", url: "https://x.trycloudflare.com" },
    uptimeMs: 10 * 60 * 1000,
  };
  assert.deepEqual(shouldUpdateNow(base), { ok: true });

  // Không có bản mới hơn
  assert.equal(shouldUpdateNow({ ...base, remote: { version: "0.1.0" } }).ok, false);
  assert.equal(shouldUpdateNow({ ...base, current: "2026.09.16.0" }).ok, false);

  // Bản này từng thất bại / rollback trước đó — chặn vòng lặp vô hạn
  assert.deepEqual(shouldUpdateNow({ ...base, failedVersion: "2026.09.16.0" }), {
    ok: false,
    reason: "version_failed_previously",
  });
  // Bản mới hơn bản đã hỏng thì vẫn cho phép cập nhật
  assert.equal(shouldUpdateNow({ ...base, failedVersion: "2026.09.15.9" }).ok, true);

  // Tunnel chưa lên / đang backoff
  assert.equal(shouldUpdateNow({ ...base, tunnel: { phase: "starting", url: "" } }).ok, false);
  assert.equal(shouldUpdateNow({ ...base, tunnel: { phase: "backoff", url: "" } }).ok, false);

  // Bridge vừa dậy chưa đủ 5 phút — không restart sớm (tránh 429)
  assert.equal(shouldUpdateNow({ ...base, uptimeMs: 1000 }).ok, false);
  assert.equal(shouldUpdateNow({ ...base, uptimeMs: MIN_UPTIME_MS }).ok, true);
});

test("sha256Hex: đúng chuẩn đối chiếu payload", () => {
  assert.equal(
    sha256Hex(Buffer.from("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
  // Cùng payload → cùng hash (stable — điều worker manifest dựa vào)
  assert.equal(sha256Hex(Buffer.from("x")), sha256Hex(Buffer.from("x")));
});

test("extractPayload: giải nén đúng cấu trúc + chặn path traversal", () => {
  const stage = mkdtempSync(join(tmpdir(), "ota-stage-"));
  try {
    const payload = {
      files: {
        "src/index.js": Buffer.from("console.log(1)").toString("base64"),
        "package.json": Buffer.from("{}").toString("base64"),
      },
    };
    assert.equal(extractPayload(payload, stage), 2);
    assert.equal(readFileSync(join(stage, "src", "index.js"), "utf8"), "console.log(1)");

    // Path traversal ra ngoài stage bị từ chối
    assert.throws(() => extractPayload({ files: { "../escape.js": "aGk=" } }, stage));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

/** Dựng cây giả lập repo bridge trong temp: src/index.js + scripts/ + VERSION. */
function fakeBridgeRoot() {
  const root = mkdtempSync(join(tmpdir(), "ota-root-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "index.js"), 'console.log("old")');
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "ota-watchdog.mjs"), 'console.log("wd-old")');
  writeFileSync(join(root, "VERSION"), "2026.09.15.1");
  return root;
}

test("installRelease: swap atomic src→backup, cài bản mới, arm state", () => {
  const root = fakeBridgeRoot();
  try {
    const payload = {
      version: "2026.09.16.0",
      files: {
        "src/index.js": Buffer.from('console.log("new")').toString("base64"),
        "scripts/ota-watchdog.mjs": Buffer.from('console.log("wd")').toString("base64"),
        "VERSION": Buffer.from("2026.09.16.0").toString("base64"),
      },
    };
    const to = installRelease(payload, { bridgeRoot: root, from: "2026.09.15.1" });
    assert.equal(to, "2026.09.16.0");
    // src giờ là bản mới, backup giữ trọn gói src, scripts, VERSION
    assert.equal(readFileSync(join(root, "src", "index.js"), "utf8"), 'console.log("new")');
    assert.equal(readFileSync(join(root, ".ota-backup", "src", "index.js"), "utf8"), 'console.log("old")');
    assert.equal(readFileSync(join(root, ".ota-backup", "scripts", "ota-watchdog.mjs"), "utf8"), 'console.log("wd-old")');
    assert.equal(readFileSync(join(root, ".ota-backup", "VERSION"), "utf8"), "2026.09.15.1");
    // watchdog ngoài src/ cũng được thăng cấp — cài mới / OTA thiếu nó là mất rollback
    assert.equal(readFileSync(join(root, "scripts", "ota-watchdog.mjs"), "utf8"), 'console.log("wd")');
    assert.equal(readFileSync(join(root, "VERSION"), "utf8"), "2026.09.16.0");
    assert.equal(JSON.parse(readFileSync(join(root, ".ota", "state.json"), "utf8")).phase, "applying");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installRelease: từ chối khi đang có update chưa xác nhận", () => {
  const root = fakeBridgeRoot();
  try {
    const payload = {
      version: "2026.09.17.0",
      files: { "src/index.js": Buffer.from('x').toString("base64") },
    };
    installRelease(payload, { bridgeRoot: root });
    // Lần hai — state vẫn "applying" vì không ai markBootOk
    assert.throws(() => installRelease(payload, { bridgeRoot: root }), /đang có update/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoreBackup: bản mới vỡ → trả về đầy đủ bản cũ (src, scripts, VERSION) + blacklist", () => {
  const root = fakeBridgeRoot();
  try {
    installRelease(
      {
        version: "2026.09.16.0",
        files: {
          "src/index.js": Buffer.from('console.log("new")').toString("base64"),
          "scripts/ota-watchdog.mjs": Buffer.from('console.log("wd-new")').toString("base64"),
          "VERSION": Buffer.from("2026.09.16.0").toString("base64"),
        },
      },
      { bridgeRoot: root }
    );
    assert.equal(restoreBackup(root), true);
    // src, scripts, VERSION đều phải phục hồi về bản cũ
    assert.equal(readFileSync(join(root, "src", "index.js"), "utf8"), 'console.log("old")');
    assert.equal(readFileSync(join(root, "scripts", "ota-watchdog.mjs"), "utf8"), 'console.log("wd-old")');
    assert.equal(readFileSync(join(root, "VERSION"), "utf8"), "2026.09.15.1");
    assert.equal(existsSync(join(root, ".ota-backup")), false);

    // State phải ghi nhận failedVersion để không lặp lại
    const state = JSON.parse(readFileSync(join(root, ".ota", "state.json"), "utf8"));
    assert.equal(state.phase, "rollback");
    assert.equal(state.failedVersion, "2026.09.16.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("partial backup failure restores moved src and leaves scripts intact", () => {
  const root = fakeBridgeRoot();
  const rename = fs.renameSync;
  try {
    fs.renameSync = (from, to) => {
      if (from === join(root, "scripts")) throw new Error("injected scripts lock");
      return rename(from, to);
    };
    syncBuiltinESMExports();
    assert.throws(() => installRelease({ version: "2.0", files: {
      "src/index.js": Buffer.from("new").toString("base64"),
      "scripts/ota-watchdog.mjs": Buffer.from("new watchdog").toString("base64"),
    } }, { bridgeRoot: root }), /injected scripts lock/);
    assert.equal(readFileSync(join(root, "src/index.js"), "utf8"), 'console.log("old")');
    assert.equal(readFileSync(join(root, "scripts/ota-watchdog.mjs"), "utf8"), 'console.log("wd-old")');
    assert.equal(readFileSync(join(root, "VERSION"), "utf8"), "2026.09.15.1");
  } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("state write failure prevents all live-tree and previous-backup changes", () => {
  const root = fakeBridgeRoot();
  try {
    writeFileSync(join(root, ".ota"), "blocked");
    mkdirSync(join(root, ".ota-backup"));
    writeFileSync(join(root, ".ota-backup/keep"), "previous");
    assert.throws(() => installRelease({ version: "2.0", files: {
      "src/index.js": Buffer.from("new").toString("base64"),
    } }, { bridgeRoot: root }));
    assert.equal(readFileSync(join(root, "src/index.js"), "utf8"), 'console.log("old")');
    assert.equal(readFileSync(join(root, ".ota-backup/keep"), "utf8"), "previous");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("empty backup is not legacy src; omitted scripts survive install and rollback", () => {
  const root = fakeBridgeRoot();
  try {
    mkdirSync(join(root, ".ota-backup"));
    assert.equal(restoreBackup(root), false);
    assert.ok(existsSync(join(root, "src/index.js")));
    installRelease({ version: "2.0", files: {
      "src/index.js": Buffer.from("new").toString("base64"),
      "VERSION": Buffer.from("stale").toString("base64"),
    } }, { bridgeRoot: root });
    assert.equal(readFileSync(join(root, "VERSION"), "utf8"), "2.0");
    assert.equal(readFileSync(join(root, ".ota/ota-watchdog.mjs"), "utf8"), 'console.log("wd-old")');
    assert.equal(restoreBackup(root), true);
    assert.equal(readFileSync(join(root, "scripts/ota-watchdog.mjs"), "utf8"), 'console.log("wd-old")');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("watchdog logs use data directory with old-launcher fallback", () => {
  assert.equal(watchdogPaths(join("root", ".ota", "state.json"), "data").output, join("data", "ota.log"));
  assert.equal(watchdogPaths(join("root", ".ota", "state.json")).log, join("root", ".ota", "ota-watchdog.log"));
});


test("OTA downloads after three failures, installs and respawns the new version", { timeout: 20000 }, async () => {
  const root = fakeBridgeRoot();
  const data = join(root, "data");
  mkdirSync(data);
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  const updater = readFileSync(new URL("../src/update.js", import.meta.url), "utf8");
  const watchdog = readFileSync(new URL("../scripts/ota-watchdog.mjs", import.meta.url), "utf8");
  const config = `export function bridgeDataDir() { return ${JSON.stringify(data)}; }`;
  writeFileSync(join(root, "src/update.js"), updater);
  writeFileSync(join(root, "src/config.js"), config);
  writeFileSync(join(root, "scripts/ota-watchdog.mjs"), watchdog);
  const marker = join(root, "restarted.json");
  const entry = `import { markBootOk, currentVersion } from './update.js';
import { writeFileSync } from 'node:fs';
markBootOk();
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({version:currentVersion(), pid:process.pid}));`;
  const files = Object.fromEntries(Object.entries({
    "src/index.js": entry, "src/update.js": updater, "src/config.js": config,
    "scripts/ota-watchdog.mjs": watchdog + "\n// next release watchdog\n",
    "VERSION": "wrong stamp",
  }).map(([name, text]) => [name, Buffer.from(text).toString("base64")]));
  const payload = JSON.stringify({ version: "2099.1", files });
  let downloads = 0;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/bridge-release") {
      res.end(JSON.stringify({ version: "2099.1", sha256: sha256Hex(payload) }));
    } else if (req.url === "/bridge-release/files") {
      downloads += 1;
      if (downloads <= 3) { res.statusCode = 503; res.end('{}'); }
      else res.end(payload);
    } else { res.statusCode = 404; res.end('{}'); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  // Accelerate only the test launcher's clocks; fetch, install, watchdog and respawn are real.
  const launcher = `const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realTimeout(fn, [30000,1800000,21600000].includes(ms) ? 10 : ms, ...args);
process.uptime = () => 600;
const { startUpdater } = await import('./src/update.js');
startUpdater({config:{lookupUrl:${JSON.stringify(base)}}, getTunnelState:()=>({phase:'up',url:'test'})});`;
  writeFileSync(join(root, "launch.mjs"), launcher);
  let output = "";
  const child = spawn(process.execPath, [join(root, "launch.mjs")], {
    env: { ...process.env, OPENWORK_BRIDGE_OTA: "1", OPENWORK_BRIDGE_DIR: data },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  const exited = once(child, "exit");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  try {
    const deadline = Date.now() + 12000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert.ok(existsSync(marker), output);
    assert.equal(downloads, 4);
    const restarted = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(restarted.version, "2099.1");
    assert.notEqual(restarted.pid, child.pid);
    assert.equal(JSON.parse(readFileSync(join(root, ".ota/state.json"), "utf8")).phase, "done");
    assert.equal(readFileSync(join(root, ".ota/ota-watchdog.mjs"), "utf8"), watchdog);
    assert.ok(existsSync(join(data, "ota.log")));
    assert.deepEqual(await exited, [0, null]);
    await new Promise((r) => setTimeout(r, 1500));
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
    await new Promise((r) => server.close(r));
    rmSync(root, { recursive: true, force: true });
  }
});
