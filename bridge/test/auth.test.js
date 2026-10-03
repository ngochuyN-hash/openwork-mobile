import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Boots the REAL bridge process on a scratch port + scratch data dir, then
// proves the auth wall: every guarded route answers 401 without a token and
// POST /api/pair is the only door that opens without one.

const TOKEN = "owm_auth_test_master_token";

async function waitUntil(predicate, timeoutMs = 12_000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

test("không token: mọi route quản trị đều 401, /api/pair là cửa không xác thực duy nhất", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "owm-auth-"));
  const data = join(root, "bridge");
  const openwork = join(root, "openwork");
  mkdirSync(data);
  mkdirSync(openwork);
  const free = createServer();
  free.listen(0, "127.0.0.1");
  await once(free, "listening");
  const port = free.address().port;
  await new Promise((resolve) => free.close(resolve)); // hand the port to the bridge

  writeFileSync(
    join(data, "config.json"),
    JSON.stringify({
      mobileToken: TOKEN, port, lookupUrl: "", lookupSecret: "", lookupTenant: "",
      autoLaunchOpenWork: false,
    })
  );

  let child;
  let output = "";
  try {
    child = spawn(process.execPath, [fileURLToPath(new URL("../src/index.js", import.meta.url))], {
      env: {
        ...process.env,
        OPENWORK_BRIDGE_DIR: data,
        OPENWORK_DIR: openwork,
        OPENWORK_SERVER_URL: "",
        OPENWORK_PUBLIC_URL: "",
        OPENWORK_BRIDGE_TUNNEL: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    const up = await waitUntil(() => output.includes("listening on"));
    assert.ok(up, `bridge did not reach 'listening on'. Output:\n${output}`);
    const base = `http://127.0.0.1:${port}`;

    // TẤT CẢ route quản trị phải 401 khi không token (trước khi chạm handler)
    const guarded = [
      ["GET", "/api/fs/ls?path=C:/Windows"],
      ["POST", "/api/fs/mkdir"],
      ["POST", "/api/machine/name"],
      ["POST", "/api/tunnel/restart"],
      ["DELETE", "/api/devices/whatever-id"],
      ["GET", "/api/devices"],
      ["GET", "/api/state"],
      ["GET", "/api/pairing-code"],
    ];
    for (const [method, path] of guarded) {
      const res = await fetch(base + path, { method });
      assert.equal(res.status, 401, `${method} ${path} must be 401 without a token`);
      assert.equal((await res.json()).code, "unauthorized", `${method} ${path} must be the bridge's own 401`);
    }

    // Token sai vẫn 401
    const wrong = await fetch(`${base}/api/state`, { headers: { authorization: "Bearer owm_wrong_token" } });
    assert.equal(wrong.status, 401, "a wrong token must be 401 too");

    // /api/pair là cửa KHÔNG xác thực DUY NHẤT: body rác -> 400 invalid_body,
    // chứng minh request không-token chạm được handler thật thay vì bị deny.
    const open = await fetch(`${base}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    assert.equal(open.status, 400, "/api/pair must reach its handler without a token");
    assert.equal((await open.json()).code, "invalid_body");

    // Token ĐÚNG thì API sống thật — các 401 phía trên là do auth, không phải hỏng.
    const ok = await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).ok, true);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
