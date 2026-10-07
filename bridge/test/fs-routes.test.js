// Route test hành vi cho seam "duyệt thư mục" (/api/fs/ls + /api/fs/mkdir).
// Module fslist.js có unit test riêng (bridge.test.js), nhưng BẢN ĐỒ
// lỗi→status trên HTTP seam từng trần trụi: mọi lỗi không lường trước bị
// nén thành 403 "no permission" — lỗi nội bộ presenting as thiếu quyền.
// Test này bắn HTTP thật vào createApp (cùng harness với routes.test.js),
// ghim từng hàng của fsStatus trong bridge/src/routes/fs.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { PairingService } from "../src/pairing.js";
import { fsStatus } from "../src/routes/fs.js";

const MASTER = "owm_master_token_for_test";

async function withApp(run) {
  const dir = mkdtempSync(join(tmpdir(), "owm-fs-routes-"));
  const prevDir = process.env.OPENWORK_BRIDGE_DIR;
  process.env.OPENWORK_BRIDGE_DIR = dir;
  const { server } = createApp({
    config: { port: 8788, mobileToken: MASTER, ownerToken: "owner-token", lookupTenant: "", lookupSecret: "", machineName: "", openworkExe: "", publicUrl: "" },
    state: { server: null, tokenActive: false, restartRequired: false, tunnelUrl: "" },
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
    await run({ base, dir });
  } finally {
    await new Promise((r) => server.close(r));
    if (prevDir === undefined) delete process.env.OPENWORK_BRIDGE_DIR;
    else process.env.OPENWORK_BRIDGE_DIR = prevDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("fsStatus: từng hàng lỗi → status, lỗi lạ = 500 thay vì 403", () => {
  const e = (code) => Object.assign(new Error(code), { code });
  assert.equal(fsStatus(e("ENOENT"), 500), 404);
  assert.equal(fsStatus(e("ENOTDIR"), 500), 404);
  assert.equal(fsStatus(e("EEXIST"), 500), 400);
  assert.equal(fsStatus(e("EINVAL"), 500), 400);
  assert.equal(fsStatus(e("EACCES"), 500), 403);
  assert.equal(fsStatus(e("EPERM"), 500), 403);
  assert.equal(fsStatus(e("EIO"), 500), 500, "lỗi nội bộ phải là 500, không phải 403 giả dạng thiếu quyền");
  assert.equal(fsStatus({}, 500), 500);
});

test("khóa: /api/fs/* không token → 401", async () => {
  await withApp(async ({ base }) => {
    assert.equal((await fetch(`${base}/api/fs/ls`)).status, 401);
    assert.equal((await fetch(`${base}/api/fs/mkdir`, { method: "POST", body: "{}" })).status, 401);
  });
});

test("ls: gốc → 200; thư mục không tồn tại → 404 ENOENT; file → 404 ENOTDIR", async () => {
  await withApp(async ({ base, dir }) => {
    const ok = await fetch(`${base}/api/fs/ls`, { headers: { authorization: `Bearer ${MASTER}` } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).ok, true);

    const missing = await fetch(`${base}/api/fs/ls?path=${encodeURIComponent(join(dir, "khong-ton-tai"))}`,
      { headers: { authorization: `Bearer ${MASTER}` } });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, "ENOENT");

    const file = join(dir, "mot-file.txt");
    writeFileSync(file, "x");
    const notDir = await fetch(`${base}/api/fs/ls?path=${encodeURIComponent(file)}`,
      { headers: { authorization: `Bearer ${MASTER}` } });
    assert.equal(notDir.status, 404);
    assert.equal((await notDir.json()).code, "ENOTDIR");
  });
});

test("mkdir: tạo mới 200, trùng tên 400 EEXIST, tên rỗng/kém đạt 400 EINVAL", async () => {
  await withApp(async ({ base, dir }) => {
    const headers = { authorization: `Bearer ${MASTER}`, "content-type": "application/json" };
    const post = (body) => fetch(`${base}/api/fs/mkdir`, { method: "POST", headers, body: JSON.stringify(body) });

    const created = await post({ dir, name: "workspace-moi" });
    assert.equal(created.status, 200);
    assert.ok(statSync(join(dir, "workspace-moi")).isDirectory(), "thư mục phải tồn tại thật sau 200");

    const dup = await post({ dir, name: "workspace-moi" });
    assert.equal(dup.status, 400);
    assert.equal((await dup.json()).code, "EEXIST");

    const badName = await post({ dir, name: "co\\ky-tu.xlsx" });
    assert.equal(badName.status, 400);
    assert.equal((await badName.json()).code, "EINVAL");

    const empty = await post({ dir, name: "" });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).code, "EINVAL");
  });
});
