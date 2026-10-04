// proxyToOpenWork giữ nguyên Content-Disposition của engine — trừ nhóm file
// web không render được, bị đổi thành "attachment" để điện thoại tải về máy
// thay vì mở trang trắng. Test bằng HTTP thật: upstream giả trả "inline" y hệt
// apps/server/src/routes/files.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { proxyToOpenWork } from "../src/proxy.js";

async function withProxy(upstreamDisposition, run) {
  const upstream = createServer((req, res) => {
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": "3",
      "content-disposition": upstreamDisposition,
    });
    res.end("abc");
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${upstream.address().port}`;

  const front = createServer((req, res) => {
    const [path] = req.url.split("?");
    const search = req.url.slice(path.length);
    proxyToOpenWork(req, res, `${path}${search}`, { baseUrl, ownerToken: "owt_test" }).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise((r) => front.listen(0, "127.0.0.1", r));
  const frontUrl = `http://127.0.0.1:${front.address().port}`;
  try {
    await run(frontUrl);
  } finally {
    await new Promise((r) => front.close(r));
    await new Promise((r) => upstream.close(r));
  }
}

test("engine gắn inline cho .xlsx → bridge đổi thành attachment", async () => {
  await withProxy('inline; filename="bao-cao.xlsx"', async (base) => {
    const res = await fetch(`${base}/workspace/ws_1/files/raw?path=${encodeURIComponent("bao-cao.xlsx")}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition"), /^attachment;/);
    assert.match(res.headers.get("content-disposition"), /bao-cao\.xlsx/);
  });
});

test("ảnh và PDF giữ nguyên inline để viewer web không hỏng", async () => {
  await withProxy('inline; filename="anh.png"', async (base) => {
    const png = await fetch(`${base}/workspace/ws_1/files/raw?path=anh.png`);
    assert.match(png.headers.get("content-disposition"), /^inline;/);
    const pdf = await fetch(`${base}/workspace/ws_1/files/raw?path=${encodeURIComponent("bao-cao.pdf")}`);
    assert.match(pdf.headers.get("content-disposition"), /^inline;/);
  });
});

test("tên file có dấu/cách vẫn tải về đúng tên", async () => {
  await withProxy('inline; filename="x.xlsx"', async (base) => {
    const res = await fetch(`${base}/workspace/ws_1/files/raw?path=${encodeURIComponent("Báo cáo Q3.xlsx")}`);
    const cd = res.headers.get("content-disposition");
    assert.match(cd, /^attachment;/);
    assert.match(cd, /filename\*=UTF-8''B%C3%A1o%20c%C3%A1o%20Q3\.xlsx/);
  });
});