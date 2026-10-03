import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { createStaticHandler } from "../src/static.js";

// Minimal Writable double: records writeHead/end/destroy so assertions can
// judge status + body without a real socket.
function mockRes() {
  const res = new Writable({
    write(chunk, _enc, cb) {
      res.body.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      cb();
    },
  });
  res.body = [];
  res.status = 0;
  res.headers = null;
  res.headersSent = false;
  res.ended = false;
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers ?? null;
    res.headersSent = true;
    return res;
  };
  res.end = (chunk) => {
    if (chunk) res.body.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    res.ended = true;
    return res;
  };
  res.destroy = () => {
    res.destroyed = true;
    return res;
  };
  return res;
}

// File serving is async (stream opens on the threadpool) — wait for the
// response to actually END (the piped body lands in later ticks than the
// 200 status), with a hard cap so a regression cannot hang the suite.
const settled = (res) =>
  new Promise((resolve) => {
    const started = Date.now();
    const iv = setInterval(() => {
      if (res.ended || Date.now() - started > 2000) {
        clearInterval(iv);
        resolve();
      }
    }, 2);
  });

const bodyText = (res) => Buffer.concat(res.body).toString("utf8");

test("static: %2e%2e và ../ ra ngoài root bị chặn, file chính thống + SPA fallback vẫn chạy", async () => {
  const parent = mkdtempSync(join(tmpdir(), "owm-static-"));
  const root = join(parent, "dist");
  try {
    mkdirSync(root);
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "index.html"), "<html>app shell</html>");
    writeFileSync(join(root, "assets", "app.css"), "body{color:red}");
    // Sibling whose name EXTENDS the root name: the old startsWith(root)
    // prefix check let "C:...\\dist-old\\x" through as "inside C:...\\dist".
    mkdirSync(join(parent, "dist-old"));
    writeFileSync(join(parent, "dist-old", "file.txt"), "DIST-OLD SECRET");
    writeFileSync(join(parent, "outside-secret.txt"), "TOP SECRET");

    const handler = createStaticHandler(root);

    // Encoded "%2e%2e" — the handler must decode BEFORE judging the path.
    let res = mockRes();
    handler({}, res, "/%2e%2e/outside-secret.txt");
    await settled(res);
    assert.equal(res.status, 403, "%2e%2e traversal must be 403");
    assert.ok(!bodyText(res).includes("TOP SECRET"));

    // Encoded "%2e%2e%2f" into the prefix-colliding sibling
    res = mockRes();
    handler({}, res, "/%2e%2e%2fdist-old%2ffile.txt");
    await settled(res);
    assert.equal(res.status, 403, "%2e%2e%2f traversal must be 403");
    assert.ok(!bodyText(res).includes("DIST-OLD SECRET"));

    // Plain ../ out of the root
    res = mockRes();
    handler({}, res, "/../outside-secret.txt");
    await settled(res);
    assert.equal(res.status, 403, "../ traversal must be 403");
    assert.ok(!bodyText(res).includes("TOP SECRET"));

    // ../ into the sibling whose name starts with the root name — the exact
    // case the old startsWith(root) check silently passed (200 + file body).
    res = mockRes();
    handler({}, res, "/../dist-old/file.txt");
    await settled(res);
    assert.equal(res.status, 403, "prefix-collision sibling must be 403");
    assert.ok(!bodyText(res).includes("DIST-OLD SECRET"));

    // Multi-hop parent walk dies too
    res = mockRes();
    handler({}, res, "/../../outside-secret.txt");
    await settled(res);
    assert.equal(res.status, 403);

    // Legit: root serves the shell
    res = mockRes();
    handler({}, res, "/");
    await settled(res);
    assert.equal(res.status, 200, "root must still serve index.html");
    assert.ok(bodyText(res).includes("app shell"));

    // Legit: file in a subfolder
    res = mockRes();
    handler({}, res, "/assets/app.css");
    await settled(res);
    assert.equal(res.status, 200, "subfolder asset must still serve");
    assert.ok(bodyText(res).includes("color:red"));

    // SPA fallback: unknown path serves the shell, not a parent-directory file
    res = mockRes();
    handler({}, res, "/no/such/route");
    await settled(res);
    assert.equal(res.status, 200);
    assert.ok(bodyText(res).includes("app shell"));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("static: file biến mất giữa stat và open → 500 JSON sạch, không uncaughtException", async () => {
  const parent = mkdtempSync(join(tmpdir(), "owm-static-gone-"));
  const root = join(parent, "dist");
  try {
    mkdirSync(root);
    writeFileSync(join(root, "index.html"), "<html>app shell</html>");
    const handler = createStaticHandler(root);

    const victim = join(root, "vanishing.css");
    writeFileSync(victim, "gone soon");
    const res = mockRes();
    handler({}, res, "/vanishing.css");
    // Synchronous delete runs BEFORE the queued threadpool open — the stream
    // open is guaranteed to fail with ENOENT.
    rmSync(victim, { force: true });
    await settled(res);

    assert.equal(res.status, 500, "vanished file must answer a clean 500");
    assert.equal(JSON.parse(bodyText(res)).code, "read_error");
    assert.equal(res.destroyed, false, "socket must not be destroyed before headers went out");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
