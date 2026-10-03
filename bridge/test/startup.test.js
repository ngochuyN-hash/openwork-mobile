import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("background bridge retries occupied port, serves API and does not log pairing secrets", { timeout: 20000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "owm-startup-"));
  const data = join(root, "bridge");
  const openwork = join(root, "openwork");
  mkdirSync(data);
  mkdirSync(openwork);
  const blocker = createServer();
  blocker.listen(0, "127.0.0.1");
  await once(blocker, "listening");
  const port = blocker.address().port;
  const token = "owm_test_background_secret";
  writeFileSync(join(data, "config.json"), JSON.stringify({
    mobileToken: token, port, lookupUrl: "", lookupSecret: "", lookupTenant: "",
    autoLaunchOpenWork: false,
  }));
  let child;
  let output = "";
  let released = false;
  try {
    child = spawn(process.execPath, [fileURLToPath(new URL("../src/index.js", import.meta.url))], {
      env: { ...process.env, OPENWORK_BRIDGE_DIR: data, OPENWORK_DIR: openwork,
        OPENWORK_SERVER_URL: "", OPENWORK_PUBLIC_URL: "", OPENWORK_BRIDGE_TUNNEL: "0" },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const deadline = Date.now() + 12000;
    while (!output.includes("thử lại lần 1/10") && Date.now() < deadline && child.exitCode === null) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.match(output, /thử lại lần 1\/10/);
    await new Promise((resolve) => blocker.close(resolve));
    released = true;
    while (!output.includes("listening on") && Date.now() < deadline && child.exitCode === null) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.match(output, /listening on/);
    const url = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${url}/api/state`)).status, 401);
    const headers = { authorization: `Bearer ${token}` };
    const state = await fetch(`${url}/api/state`, { headers });
    assert.equal(state.status, 200);
    assert.equal((await state.json()).ok, true);
    const pair = await fetch(`${url}/api/pairing-code`, { headers });
    assert.equal(pair.status, 200);
    const pairing = await pair.json();
    assert.equal(pairing.code.length, 8);
    assert.ok(pairing.masterUrl.includes(token));
    assert.ok(!output.includes(token));
    assert.ok(!output.includes(pairing.code));
    assert.ok(!output.includes(`${pairing.code.slice(0, 4)}-${pairing.code.slice(4)}`));
    assert.ok(!output.includes("QR MASTER"));
  } finally {
    if (!released) await new Promise((resolve) => blocker.close(resolve));
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
