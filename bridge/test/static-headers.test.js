import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { createStaticHandler } from "../src/static.js";

// Cửa tunnel của bridge phục vụ web/dist trực tiếp, không đi qua Cloudflare —
// nên nếu bridge quên gắn CSP thì web vẫn chạy trơn mà chỉ mất một mảnh giáp.
// Test này ghim lại đúng bộ header đó, và (vì đặc tả cấm lệch) so luôn với
// bản worker + bản _headers để ba cửa không trôi lệch nhau.

// Bộ chỉ thị "đúng" — chính là hằng CSP ở worker/src/index.js. Khai báo tường
// minh thay vì so sánh mềm, để đổi ý nghĩa (thêm/bớt chỉ thị) là một thay đổi
// phải sửa cả ba file, không phải một so khớp âm thầm.
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

test("static: CSP của bridge khớp từng chỉ thị với worker và _headers (3 bản phải giống nhau)", () => {
  // worker/src/index.js — đọc nguyên mảng chỉ thị rồi nối lại y hệt cách
  // hằng CSP ở đó được dựng. Nếu ai đó đổi tên hằng thì chỗ này đỏ, và đó
  // chính là tín hiệu buộc phải cập nhật cả ba bản trong một lần.
  const workerSrc = readFileSync(new URL("../../worker/src/index.js", import.meta.url), "utf8");
  const array = workerSrc.match(/const CSP = \[([\s\S]*?)\]\.join\("; "\)/);
  assert.ok(array, "không tìm thấy hằng CSP trong worker/src/index.js — đã đổi cấu trúc? phải cập nhật cả 3 bản");
  const workerCsp = [...array[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).join("; ");
  assert.equal(workerCsp, EXPECTED_CSP, "bộ chỉ thị kỳ vọng của test lệch với worker");

  // web/public/_headers — dòng CSP của Cloudflare Pages.
  const headersFile = readFileSync(new URL("../../web/public/_headers", import.meta.url), "utf8");
  const pageCsp = headersFile.match(/Content-Security-Policy:\s*(.+)/)?.[1]?.trim();
  assert.ok(pageCsp, "web/public/_headers mất dòng Content-Security-Policy");

  // Ba cửa vào web: worker (Cloudflare), bridge (tunnel), Pages. Lệch một chỗ
  // là tấm chhiến "lọt XSS cũng không chạy được" chỉ còn ở cửa kia.
  assert.equal(directiveSet(pageCsp).size, EXPECTED_DIRECTIVES.length);
  for (const directive of EXPECTED_DIRECTIVES) {
    assert.ok(directiveSet(pageCsp).has(directive), `_headers thiếu chỉ thị: ${directive}`);
  }

  // FIX-2 thêm 2 header ngoài CSP (nosniff + no-referrer) vào CẢ BA cửa. Chỉ so
  // dòng CSP thì xoá 2 dòng này ở worker/_headers không test nào đỏ → cửa đó mất
  // giáp mà không ai biết. Đặc tả (docs/SECURITY-FIX-SPEC-2026-10-04.md FIX-2 §2)
  // yêu cầu 3 bản giống nhau, nên drift-guard phải ghim đủ 3 header, không riêng CSP.
  assert.ok(
    /headers\.set\(\s*"x-content-type-options"\s*,\s*"nosniff"\s*\)/.test(workerSrc),
    "worker/src/index.js mất headers.set x-content-type-options nosniff trong withSecurityHeaders()",
  );
  assert.ok(
    /headers\.set\(\s*"referrer-policy"\s*,\s*"no-referrer"\s*\)/.test(workerSrc),
    "worker/src/index.js mất headers.set referrer-policy no-referrer trong withSecurityHeaders()",
  );
  assert.match(
    headersFile,
    /X-Content-Type-Options:\s*nosniff/,
    "web/public/_headers mất dòng X-Content-Type-Options: nosniff",
  );
  assert.match(
    headersFile,
    /Referrer-Policy:\s*no-referrer/,
    "web/public/_headers mất dòng Referrer-Policy: no-referrer",
  );
});
