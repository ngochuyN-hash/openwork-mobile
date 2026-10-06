// lib/chat-file-refs.js — quét đường dẫn file agent nhắc tới trong tin nhắn
// (tách từ chat.jsx; FILE_HINT_EXT dùng chung nguồn với lib/markdown.js).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  baseNameOf, findFileRefsInText, collectFileRefs, dirOf, makeFileHref,
} from "../src/lib/chat-file-refs.js";

test("findFileRefsInText: bắt đường dẫn trong code span, Windows và tương đối", () => {
  const refs = findFileRefsInText(
    "Đã sửa `thu-muc/bao-cao.md` và C:\\Users\\main\\ghi-chu.txt, xem them docs/plan.json nhé."
  );
  const paths = refs.map((r) => r.path);
  assert.ok(paths.includes("thu-muc/bao-cao.md"), JSON.stringify(paths));
  assert.ok(paths.includes("C:\\Users\\main\\ghi-chu.txt"), JSON.stringify(paths));
  assert.ok(paths.includes("docs/plan.json"), JSON.stringify(paths));
  // Tên file đi kèm đường dẫn.
  const byPath = Object.fromEntries(refs.map((r) => [r.path, r.name]));
  assert.equal(byPath["thu-muc/bao-cao.md"], "bao-cao.md");
  assert.equal(byPath["C:\\Users\\main\\ghi-chu.txt"], "ghi-chu.txt");
});

test("findFileRefsInText: bỏ trùng, bỏ hậu tố lạ, bỏ path quá dài", () => {
  const dup = findFileRefsInText("`a/b.md` và `a/b.md`");
  assert.equal(dup.length, 1);
  assert.equal(findFileRefsInText("`khong-hau-to`").length, 0);
  const long = "a/" + "b".repeat(300) + ".md";
  assert.equal(findFileRefsInText(`\`${long}\``).length, 0);
  // Dấu câu bọc quanh bị bóc: "docs/x.md." vẫn ra docs/x.md
  const trimmed = findFileRefsInText("xem `docs/x.md`.")[0];
  assert.equal(trimmed.path, "docs/x.md");
});

test("collectFileRefs: text + tool filePath + tool output, trộn và CHỈ trả tối đa 5", () => {
  const parts = [
    { type: "text", text: "Tạo `out/report.pdf` xong." },
    { type: "tool", state: { input: { filePath: "src/main.md" } } },
    { type: "tool", state: { input: {}, output: "wrote `out/data.json`" } },
    { type: "reasoning", text: "`note.md` trong suy luận KHÔNG được đếm (chỉ text + tool)" },
  ];
  const refs = collectFileRefs(parts).map((r) => r.path);
  assert.deepEqual(refs, ["out/report.pdf", "src/main.md", "out/data.json"]);
  // 6 đường dẫn → cắt còn 5.
  const many = { type: "text", text: ["1.md", "2.md", "3.md", "4.md", "5.md", "6.md"].map((f) => `\`${f}\``).join(" ") };
  assert.equal(collectFileRefs([many]).length, 5);
  // parts sai shape không ném.
  assert.deepEqual(collectFileRefs([]), []);
  assert.deepEqual(collectFileRefs([{}]), []);
});

test("dirOf: bóc thư mục cha, hiểu cả C:\\ và gốc tương đối trần", () => {
  assert.equal(dirOf("C:\\a\\b\\c.txt"), "a/b");
  // Giữ nguyên hành vi gốc: gạch chéo đầu KHÔNG bị bóc (file API chấp nhận).
  assert.equal(dirOf("/a/b/c.txt"), "/a/b");
  assert.equal(dirOf("a/b/c.txt"), "a/b");
  assert.equal(dirOf("c.txt"), "");
  assert.equal(dirOf("/c.txt"), "");
  assert.equal(dirOf(""), "");
});

test("makeFileHref: link trang Files, KHÔNG token trên URL; wsId thiếu → null", () => {
  const href = makeFileHref("ws-1")("thu muc\\bao-cao.md");
  assert.equal(
    href,
    "#/ws/ws-1/files?path=" + encodeURIComponent("thu muc") + "&open=" + encodeURIComponent("thu muc\\bao-cao.md")
  );
  assert.ok(!href.includes("token") && !href.includes("_t="), href);
  assert.equal(makeFileHref(null), null);
  assert.equal(makeFileHref(""), null);
});
