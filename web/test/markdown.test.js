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
  // Cột phải tách đúng: mỗi dòng dữ liệu ra đúng 2 ô, không phải "ô" chứa
  // cả hàng. (Không được khẳng định "không có |" — ô CÓ THỂ chứa | hợp lệ.)
  assert.equal((html.match(/<tr>/g) ?? []).length, 3);
  assert.equal((html.match(/<td>/g) ?? []).length, 4);
});

test("ô bảng được chứa dấu `|` khi agent escape bằng `\\|`", () => {
  const html = renderMarkdownHtml("| A | B |\n| --- | --- |\n| a \\| b | 2 |");
  assert.match(html, /<td>a \| b<\/td>/);
  assert.match(html, /<td>2<\/td>/);
  assert.equal((html.match(/<td>/g) ?? []).length, 2);
});

test("bảng được bọc trong hộp cuộn ngang cho màn hình hẹp", () => {
  const html = renderMarkdownHtml("| A |\n| --- |\n| 1 |");
  assert.match(html, /<div class="md-table-wrap">/);
});

test("cột được canh phải giữ nguyên text-align", () => {
  const html = renderMarkdownHtml("| Tên | Tổng |\n| --- | ---: |\n| A | 12 |");
  assert.match(html, /text-align:right/);
  assert.match(html, />Tổng<\/th>/);
  assert.match(html, /<td class="md-align-right" style="text-align:right">12<\/td>/);
});

test("ô căn phải có class để CSS không phụ thuộc định dạng `style=`", () => {
  const html = renderMarkdownHtml("| Tên | Tổng |\n| --- | ---: |");
  assert.match(html, /<th class="md-align-right" style="text-align:right">/);
  // Cột KHÔNG căn thì không được thêm class/style thừa.
  assert.match(html, /<th>Tên<\/th>/);
  assert.doesNotMatch(html, /md-align-left/);
});

test("ảnh trong workspace đi qua fileHref, không ra ảnh vỡ", () => {
  const html = renderMarkdownHtml("![báo đồ](charts/revenue.png)", { fileHref });
  assert.match(html, /src="\/ws\/ws_1\/files\/raw\?path=charts%2Frevenue\.png"/);
  assert.doesNotMatch(html, /src="#"/);
});

test("ảnh ngoài vẫn giữ URL và không bị fileHref đụng vào", () => {
  const html = renderMarkdownHtml("![logo](https://cdn.example.com/a.png)", { fileHref });
  assert.match(html, /src="https:\/\/cdn\.example\.com\/a\.png"/);
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
  assert.match(html, /<a class="md-file" href="\/ws\/ws_1\/files\/raw\?path=C%3A%5Cwork%5Cout%5Ca\.csv"/);
});

test("entity hợp lệ được giữ nguyên, không escape thành hai lần", () => {
  // Agent hay viết tên công ty theo kiểu entity — hiển thị `&amp;` là lỗi.
  assert.match(renderMarkdownHtml("AT&amp;T"), /<p>AT&amp;T<\/p>/);
  assert.match(renderMarkdownHtml("R&amp;D"), /<p>R&amp;D<\/p>/);
  assert.match(renderMarkdownHtml("a &lt; b"), /<p>a &lt; b<\/p>/);
  assert.match(renderMarkdownHtml("&#65;"), /<p>&#65;<\/p>/);
  assert.match(renderMarkdownHtml("&copy;"), /<p>&copy;<\/p>/);
  // Entity hỏng (`&nope;`) đi qua như marked mặc định — vô hại, vì
  // `&` + từ + `;` không thể tạo ra thẻ HTML. Dấu & TRẦN thì phải escape.
  assert.match(renderMarkdownHtml("Tom & Jerry"), /<p>Tom &amp; Jerry<\/p>/);
  // Nhưng trong code span thì entity là chữ nghĩa đ literally (đúng GFM).
  assert.match(renderMarkdownHtml("`a &amp; b`"), /<code>a &amp;amp; b<\/code>/);
});

test("URL trần trong câu không sinh <a> lồng <a>", () => {
  // `s:/` trong `https://` từng khớp nhầm regex đường dẫn Windows.
  const html = renderMarkdownHtml("see https://example.com/a.html now", { fileHref });
  assert.equal((html.match(/<a /g) ?? []).length, 1);
  assert.match(html, />https:\/\/example\.com\/a\.html<\/a>/);
  assert.doesNotMatch(html, /path=s%3A/);
  assert.doesNotMatch(html, /md-file/);
});

test("URL trần trong ô bảng cũng không sinh <a> lồng", () => {
  const html = renderMarkdownHtml("| Nguồn |\n| --- |\n| https://example.com/a.html |", { fileHref });
  assert.equal((html.match(/<a /g) ?? []).length, 1);
});

test("task list giữ ô tick", () => {
  const html = renderMarkdownHtml("- [ ] todo\n- [x] done\n- plain");
  assert.match(html, /<input disabled="" type="checkbox">todo/);
  assert.match(html, /<input checked="" disabled="" type="checkbox">done/);
  assert.match(html, /<li>plain<\/li>/);
});

test("`~một~` không bị biến thành gạch ngang, `~~hai~~` thì có", () => {
  const html = renderMarkdownHtml("~single~ and ~~gone~~");
  assert.match(html, /<p>~single~ and <del>gone<\/del><\/p>/);
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

test("reference-style link vẫn hiện sau khi stream xong", () => {
  // Bug thật: block đầu được render lúc CHƯA có dòng định nghĩa nên ra text
  // thuần; cache giữ HTML đó vì `raw` không đổi → link không bao giờ hiện.
  const source = [
    "Xem [báo cáo][r] nhé.",
    "",
    "Thêm chi tiết.",
    "",
    "Và code:",
    "",
    "```js",
    "const a=1;",
    "```",
    "",
    "[r]: docs/report.md",
  ].join("\n");
  const stream = createMarkdownStream({ fileHref });
  let lastMismatch = 0;
  for (let i = 1; i <= source.length; i += 1) {
    const prefix = source.slice(0, i);
    if (stream.render(prefix) !== renderMarkdownHtml(prefix, { fileHref })) lastMismatch = i;
  }
  assert.equal(lastMismatch, 0, `stream lệch parse-một-lần ở tiền tố dài ${lastMismatch}`);
  assert.match(stream.render(source), /class="md-file"[^>]*>báo cáo</);
});

test("stream vẫn khớp parse-một-lần khi bị cắt rồi nối lại", () => {
  const full = "# Báo cáo\n\n| Tên | Số |\n| --- | ---: |\n| A | 1 |\n\n- việc một\n- việc hai\n\n```\ncode\n```";
  const stream = createMarkdownStream();
  const cut = full.slice(0, 40);
  stream.render(cut);
  assert.equal(stream.render(cut), renderMarkdownHtml(cut));
  assert.equal(stream.render(full), renderMarkdownHtml(full));
});