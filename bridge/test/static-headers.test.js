import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { createStaticHandler } from "../src/static.js";
import { CSP, CSP_DIRECTIVES, renderHeadersFile, securityHeaders } from "../../shared/security-headers.js";

// Cửa tunnel của bridge phục vụ web/dist trực tiếp, không đi qua Cloudflare —
// nên nếu bridge quên gắn CSP thì web vẫn chạy trơn mà chỉ mất một mảnh giáp.
// Từ 09/10 chính sách có MỘT nguồn (shared/security-headers.js): worker import,
// bridge import, web/dist/_headers do build sinh từ renderHeadersFile(). Test
// này ghim (1) hành vi thật qua handler của cửa tunnel, (2) giá trị canonical
// của nguồn chung, (3) ba cửa vẫn đi qua đúng nguồn đó — không ai mọc bản chép
// tay mới.

// Bộ chỉ thị "đúng" — khai báo tường minh thay vì so sánh mềm, để đổi ý nghĩa
// (thêm/bớt chỉ thị) là một thay đổi phải sửa shared + test này, không phải
// một so khớp âm thầm.
const EXPECTED_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
];
const EXPECTED_CSP = EXPECTED_DIRECTIVES.join("; ");

// Cùng mockRes/settled với static.test.js — file đó không export ra nên copy
// nguyên khối, giữ đúng cách dựng res giả của dự án (không socket thật).
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

// Stream mở trên threadpool nên body về sau vài tick so với lúc writeHead(200).
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

const directiveSet = (csp) =>
  new Set(
    String(csp)
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean),
  );

// Dựng web/dist tối thiểu giống static.test.js: app shell + 1 asset. Phải await
// run() trước khi xoá thư mục — stream đọc file mở ở threadpool nên xoá sớm là
// rơi vào nhánh 500 read_error.
async function withDist(run) {
  const parent = mkdtempSync(join(tmpdir(), "owm-static-hdr-"));
  const root = join(parent, "dist");
  try {
    mkdirSync(root);
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "index.html"), "<html>app shell</html>");
    writeFileSync(join(root, "assets", "app.js"), "console.log(1)");
    return await run(root);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

const serve = async (root, pathname) => {
  const res = mockRes();
  createStaticHandler(root)({}, res, pathname);
  await settled(res);
  assert.equal(res.status, 200, `${pathname} phải trả 200 để assert header có ý nghĩa`);
  return res.headers;
};

test("static: app shell qua cửa tunnel mang CSP + nosniff + no-referrer, cache-control vẫn no-cache", async () => {
  await withDist(async (root) => {
    const headers = await serve(root, "/");

    // 3 mảnh giáp: thiếu bất kỳ mảnh nào cũng phải đỏ, không "gần đúng" được.
    assert.ok(headers["content-security-policy"], "phải có content-security-policy");
    assert.equal(headers["x-content-type-options"], "nosniff");
    assert.equal(headers["referrer-policy"], "no-referrer");

    // Đúng TẬP chỉ thị, không thiếu không thừa — thừa cũng là lệch vì đặc tả
    // cấm ba bản lệch nhau.
    const got = directiveSet(headers["content-security-policy"]);
    assert.equal(got.size, EXPECTED_DIRECTIVES.length, `CSP có ${got.size} chỉ thị, mong ${EXPECTED_DIRECTIVES.length}`);
    for (const directive of EXPECTED_DIRECTIVES) {
      assert.ok(got.has(directive), `CSP thiếu chỉ thị: ${directive}`);
    }

    // Giáp vừa thêm không được làm mất cache-control của app shell.
    assert.equal(headers["cache-control"], "no-cache", "index.html phải vẫn no-cache để không cache shell cũ");
    assert.equal(headers["content-type"], "text/html; charset=utf-8");
  });
});

test("static: asset và SPA fallback cũng mang trọn bộ header, asset cache được 1 giờ", async () => {
  await withDist(async (root) => {
    // Asset hash: cache dài hơn app shell, nhưng header bảo mật phải y hệt —
    // script của app chính là asset, hở chỗ này là hở cả CSP của trang.
    const asset = await serve(root, "/assets/app.js");
    assert.equal(asset["content-security-policy"], EXPECTED_CSP);
    assert.equal(asset["x-content-type-options"], "nosniff");
    assert.equal(asset["referrer-policy"], "no-referrer");
    assert.equal(asset["cache-control"], "public, max-age=3600", "asset băm tên mới được cache dài");

    // Đường hash lạ của PWA rơi vào SPA fallback: shell phục vụ ra cũng phải có giáp.
    const spa = await serve(root, "/rooms/abc/messages");
    assert.equal(spa["content-security-policy"], EXPECTED_CSP);
    assert.equal(spa["x-content-type-options"], "nosniff");
    assert.equal(spa["referrer-policy"], "no-referrer");
    assert.equal(spa["cache-control"], "no-cache", "SPA fallback trả index.html nên cũng no-cache");
  });
});

test("static: chính sách một nguồn — shared ghim canonical, 3 cửa không mọc bản chép tay", () => {
  // (1) Nguồn chung khớp bộ chỉ thị kỳ vọng — đổi chính sách là phải đi qua
  // shared/security-headers.js, test này đỏ nếu ai sửa tay mảng ở đó.
  assert.deepEqual(CSP_DIRECTIVES, EXPECTED_DIRECTIVES);
  assert.equal(CSP, EXPECTED_CSP);
  const headers = securityHeaders();
  assert.equal(headers["content-security-policy"], EXPECTED_CSP);
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["referrer-policy"], "no-referrer");

  // (2) File _headers sinh ra đúng hình dạng Cloudflare Assets đọc (cửa thứ
  // ba) — ghim nguyên văn, gồm cả Title-Case để diff với bản tay cũ là 0.
  const expectedFile =
    "/*\n" +
    "  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'\n" +
    "  X-Content-Type-Options: nosniff\n" +
    "  Referrer-Policy: no-referrer\n";
  assert.equal(renderHeadersFile(), expectedFile);

  // (3) Hai cửa code phải import nguồn chung, không được mọc lại mảng/object
  // chép tay — literal chỉ thị trôi nổi ở worker hoặc bridge là drift.
  const workerSrc = readFileSync(new URL("../../worker/src/index.js", import.meta.url), "utf8");
  assert.ok(
    workerSrc.includes('from "../../shared/security-headers.js"'),
    "worker/src/index.js phải import shared/security-headers.js",
  );
  assert.ok(!/const CSP = \[/.test(workerSrc), "worker/src/index.js mọc lại mảng CSP chép tay");
  assert.ok(!workerSrc.includes("frame-ancestors"), "worker/src/index.js còn literal chỉ thị CSP");

  const staticSrc = readFileSync(new URL("../src/static.js", import.meta.url), "utf8");
  assert.ok(
    staticSrc.includes('from "../../shared/security-headers.js"'),
    "bridge/src/static.js phải import shared/security-headers.js",
  );
  assert.ok(!staticSrc.includes("frame-ancestors"), "bridge/src/static.js còn literal chỉ thị CSP");

  // (4) Dây chuyền build phải còn sinh _headers — đứt dây này là cửa Cloudflare
  // mất giáp mà không ai biết (dist_ không có file, Assets không gắn header).
  const pkg = readFileSync(new URL("../../web/package.json", import.meta.url), "utf8");
  assert.ok(
    pkg.includes("node scripts/gen-headers.mjs"),
    "web/package.json mất bước gen-headers.mjs sau vite build",
  );
});
