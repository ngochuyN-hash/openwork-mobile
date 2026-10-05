import { test } from "node:test";
import assert from "node:assert/strict";
import { redactUrl, redactSecrets } from "../src/log-safe.js";

// Token GIẢ trong test này. Không bao giờ dán token thật vào test/log.
const FAKE_MASTER = "owm_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("redactUrl: master token trong hash #t= bị che, không còn sót", () => {
  const out = redactUrl(`https://x.trycloudflare.com/#t=${FAKE_MASTER}`);
  assert.ok(!out.includes("owm_0123456789abcdef"), `token còn sót trong log: ${out}`);
  assert.ok(!out.includes(FAKE_MASTER));
  assert.equal(out, "https://x.trycloudflare.com/#t=<redacted>");
});

test("redactUrl: giữ nguyên host + path, chỉ mất phần bí mật", () => {
  const out = redactUrl(`https://x.trycloudflare.com/deep/path/v1/#t=${FAKE_MASTER}&m=team-a`);
  assert.ok(out.startsWith("https://x.trycloudflare.com/deep/path/v1/#"));
  assert.ok(out.includes("m=team-a"), "phòng (&m=) không phải bí mật thì phải giữ");
  assert.ok(!out.includes("0123456789abcdef"));
});

test("redactUrl: URL không có token trả về nguyên vẹn", () => {
  for (const url of [
    "http://127.0.0.1:8788",
    "https://bridge.example.com/",
    "https://bridge.example.com/base/?path=docs/readme.md",
    "https://bridge.example.com/#m=team-a",
  ]) {
    assert.equal(redactUrl(url), url);
  }
});

test("redactUrl: query ?_t=<token> bị xoá hẳn, không còn dấu ?", () => {
  const out = redactUrl(`https://x.trycloudflare.com/api/files?_t=${FAKE_MASTER}`);
  assert.ok(!out.includes("owm_"), `token còn sót trong query: ${out}`);
  assert.equal(out, "https://x.trycloudflare.com/api/files");
});

test("redactUrl: ?_t= xen giữa tham số khác thì chỉ mất cặp đó", () => {
  const out = redactUrl(`https://x.trycloudflare.com/img.png?w=800&_t=${FAKE_MASTER}&v=2`);
  assert.ok(!out.includes("owm_"));
  assert.ok(out.includes("w=800"));
  assert.ok(out.includes("v=2"));
});

test("redactUrl: mã ghép nối one-time #p= bị che đuôi, giữ 4 ký tự đầu", () => {
  const out = redactUrl("https://x.trycloudflare.com/#p=AB7K9Q2M&m=team-a");
  assert.ok(out.includes("#p=AB7K"), `phải giữ 4 ký tự đầu để log còn đọc được: ${out}`);
  assert.ok(!out.includes("AB7K9Q2M"), `mã 8 ký tự không được nằm trọn trong log: ${out}`);
  assert.ok(out.includes("m=team-a"));
});

test("redactUrl: chịu được đầu vào rác mà không ném lỗi", () => {
  assert.equal(redactUrl(""), "");
  assert.equal(redactUrl(null), null);
  assert.equal(redactUrl(undefined), undefined);
  assert.equal(redactUrl(42), 42);
  assert.equal(redactUrl("không phải URL"), "không phải URL");
});

test("redactSecrets: chìa khóa trần trong message lỗi bị thay", () => {
  const message = `proxy failed for ${FAKE_MASTER} (device owd_1111222233334444)`;
  const out = redactSecrets(message);
  assert.ok(!out.includes("0123456789abcdef"), `token còn sót: ${out}`);
  assert.ok(!out.includes("owd_1111222233334444"));
  assert.ok(out.includes("<redacted>"));
  assert.ok(out.startsWith("proxy failed for"));
});

test("redactSecrets: chuỗi không có token giữ nguyên", () => {
  assert.equal(redactSecrets("ECONNREFUSED 127.0.0.1:8788"), "ECONNREFUSED 127.0.0.1:8788");
  assert.equal(redactSecrets(7), 7);
});