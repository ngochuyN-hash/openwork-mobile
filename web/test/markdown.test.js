import test from "node:test";
import assert from "node:assert/strict";

import { renderMarkdownHtml, createMarkdownStream, safeHref } from "../src/lib/markdown.js";

const fileHref = (path) => `/ws/ws_1/files/raw?path=${encodeURIComponent(path)}`;

/** Rút gọn: bỏ khoảng trắng thừa để assert đỡ phải canh khoảng trắng. */
const flat = (html) => String(html).replace(/\s+/g, " ").trim();

test("bảng markdown ra thẻ table thật, không phải text có dấu gạch dọc", () => {
  const html = renderMarkdownHtml("| Tên | Số |\n| --- | --- |\n| A | 1 |\n| B | 2 |");
  assert.match(html, /<table class="md-table">/);
  assert.match(html, /<thead>/);
  assert.match(html, /<th>Tên<\/th>/);
  assert.match(html, /<tbody>/);
  assert.match(html, /<td>A<\/td>/);
  assert.match(html, /<td>2<\/td>/);
  // Không còn dấu `|` sót lại trong ô nào.
  assert.doesNotMatch(html, /<t[dh][^>]*>[^<]*\|/);
});

test("bảng được bọc trong hộp cuộn ngang cho màn hình hẹp", () => {
  const html = renderMarkdownHtml("| A |\n| --- |\n| 1 |");
  assert.match(html, /<div class="md-table-wrap">/);
});

test("cột được canh phải giữ nguyên text-align", () => {
  const html = renderMarkdownHtml("| Tên | Tổng |\n| --- | ---: |\n| A | 12 |");
  assert.match(html, /<th style="text-align:right">Tổng<\/th>/);
  assert.match(html, /<td style="text-align:right">12<\/td>/);
});

test("cell của bảng vẫn parse markdown bên trong (bold, code)", () => {
  const html = renderMarkdownHtml("| Tên | Ghi chú |\n| --- | --- |\n| A | **đậm** và `x` |");
  assert.match(html, /<strong>đậm<\/strong>/);
  assert.match(html, /<code>x<\/code>/);
});

test("bold, italic, heading, blockquote, list ra đúng thẻ", () => {
  const html = renderMarkdownHtml(
    "## Tiêu đề\n\n**đậm** và *nghiêng* và ~~xoá~~\n\n> trích\n\n- một\n- hai"
  );
  assert.match(html, /<h2>Tiêu đề<\/h2>/);
  assert.match(html, /<strong>đậm<\/strong>/);
  assert.match(html, /<em>nghiêng<\/em>/);
  assert.match(html, /<del>xoá<\/del>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<ul><li>một<\/li><li>hai<\/li><\/ul>/);
});

test("link ngoài mở tab mới và giữ nguyên scheme http", () => {
  const html = renderMarkdownHtml("[site](https://example.com)");
  assert.match(html, /<a href="https:\/\/example\.com" target="_blank" rel="noreferrer noopener">site<\/a>/);
});

test("HTML thô bị escape chứ không chạy (không cần DOMPurify)", () => {
  const html = renderMarkdownHtml('<img src=x onerror="alert(1)">');
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img/);
});

test("scheme nguy hiểm bị vô hiệu hoá thành #", () => {
  const html = renderMarkdownHtml("[x](javascript:alert(1))");
  assert.match(html, /href="#"/);
  assert.doesNotMatch(html, /javascript:/);
  assert.equal(safeHref("javascript:alert(1)"), "#");
  assert.equal(safeHref("data:text/html,<script>"), "#");
  assert.equal(safeHref("https://ok.example"), "https://ok.example");
  assert.equal(safeHref("/api/x"), "/api/x");
});

test("code block fence giữ nguyên nội dung và không render markdown bên trong", () => {
  const html = renderMarkdownHtml("```js\nconst a = **1**;\n```");
  assert.match(html, /<pre class="md-code"><code class="language-js">const a = \*\*1\*\*;<\/code><\/pre>/);
});

test("đường dẫn file trong text thường thành link tải/mở", () => {
  const html = renderMarkdownHtml("Tôi đã lưu ở docs/report.md rồi", { fileHref });
  assert.match(html, /<a class="md-file" href="\/ws\/ws_1\/files\/raw\?path=docs%2Freport\.md"/);
  assert.match(html, />docs\/report\.md<\/a>/);
});

test("đường dẫn Windows cũng thành link", () => {
  const html = renderMarkdownHtml("xem C:\\work\\out\\a.csv nhé", { fileHref });
  assert.match(html, /md-file/);
  assert.match(html, /out%5Ca\.csv|a\.csv/);
});

test("inline code là đường dẫn file thì bấm được", () => {
  const html = renderMarkdownHtml("mở `docs/notes.md`", { fileHref });
  assert.match(html, /<a class="md-file"[^>]*><code>docs\/notes\.md<\/code><\/a>/);
});

test("markdown link tới file nội bộ đi qua fileHref, không thành #", () => {
  const html = renderMarkdownHtml("[báo cáo](docs/report.md)", { fileHref });
  assert.match(html, /href="\/ws\/ws_1\/files\/raw\?path=docs%2Freport\.md"/);
});

test("bỏ trống hoặc toàn khoảng trắng thì trả chuỗi rỗng", () => {
  assert.equal(renderMarkdownHtml(""), "");
  assert.equal(renderMarkdownHtml("   \n  "), "");
  assert.equal(renderMarkdownHtml(null), "");
});

test("stream tăng dần cho ra cùng kết quả với render một lần", () => {
  const source = "# Báo cáo\n\n| Tên | Số |\n| --- | ---: |\n| A | 1 |\n\n- việc một\n- việc hai\n\n```\ncode\n```";
  const oneShot = flat(renderMarkdownHtml(source));
  const stream = createMarkdownStream();
  for (let i = 1; i <= source.length; i += 7) {
    stream.render(source.slice(0, i));
  }
  const streamed = flat(stream.render(source));
  // So khớp sau khi stream xong — phần đuôi có thể khác lúc đang chạy.
  assert.equal(streamed, oneShot);
});

test("stream không vỡ khi message bị rút lại (sửa lại text)", () => {
  const stream = createMarkdownStream();
  stream.render("| A |\n| --- |\n| 1 |");
  const shorter = flat(stream.render("| A |\n| --- |"));
  assert.match(shorter, /<table class="md-table">/);
  assert.doesNotMatch(shorter, /<td>1<\/td>/);
});

test("stream rỗng rồi có text lại thì vẫn render đúng", () => {
  const stream = createMarkdownStream();
  assert.equal(stream.render(""), "");
  assert.match(stream.render("**ok**"), /<strong>ok<\/strong>/);
  stream.reset();
  assert.match(stream.render("| A |\n| --- |\n| 1 |"), /<table/);
});