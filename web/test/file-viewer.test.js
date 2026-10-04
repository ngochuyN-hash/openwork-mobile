// Test logic thuần của trang Files (lib/file-viewer.js): đoán loại file, dựng
// breadcrumb, chặn file quá lớn, tóm tắt upload. Không DOM, không network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  crumbPaths,
  extOf,
  fileNameOf,
  humanBytes,
  isImageName,
  isPdfName,
  isTextName,
  kindOf,
  parentDirOf,
  TEXT_PREVIEW_MAX_BYTES,
  textTooLarge,
  uploadSummary,
} from "../src/lib/file-viewer.js";

// ---- extOf: file BẮT ĐẦU BẰNG DẤU CHẤM ----

test("extOf đọc đuôi bình thường, không phân biệt hoa thường", () => {
  assert.equal(extOf("a.txt"), "txt");
  assert.equal(extOf("README.MD"), "md");
  assert.equal(extOf("archive.tar.gz"), "gz");
  assert.equal(extOf("noext"), "noext");
});

test("extOf KHÔNG nuốt file dotfile (bug cũ: `dot <= 0` trả \"\")", () => {
  // Bản cũ: ".gitignore".lastIndexOf(".") === 0 nên `dot <= 0` đúng, trả "".
  // Hậu quả: .gitignore/.env/.npmrc không bao giờ khớp TEXT_EXT dù đã khai.
  assert.equal(extOf(".gitignore"), "gitignore");
  assert.equal(extOf(".env"), "env");
  assert.equal(extOf(".npmrc"), "npmrc");
  assert.equal(extOf(".gitignore.local"), "local"); // vẫn có đuôi thật
  assert.equal(extOf("Dockerfile"), "dockerfile");
});

test("file dotfile được coi là TEXT, không phải nhị phân", () => {
  assert.equal(kindOf(".env"), "text");
  assert.equal(kindOf(".gitignore"), "text");
  assert.equal(kindOf(".npmrc"), "text");
  assert.equal(kindOf("Dockerfile"), "text");
});

test("isText/isImage/isPdf và kindOf khớp nhau trên shape thật", () => {
  assert.equal(kindOf("notes.md"), "text");
  assert.equal(kindOf("main.tsx"), "text");
  assert.equal(kindOf("logo.PNG"), "image");
  assert.equal(kindOf("photo.jpeg"), "image");
  assert.equal(kindOf("doc.pdf"), "pdf");
  assert.equal(kindOf("app.exe"), "binary");
  assert.equal(kindOf("data.bin"), "binary");
  assert.equal(kindOf(""), "binary");
  assert.equal(kindOf(undefined), "binary");
  // isImage/isPdf không được nuốt file text
  assert.equal(isImageName("notes.md"), false);
  assert.equal(isPdfName("notes.md"), false);
  assert.equal(isTextName("logo.png"), false);
});

// ---- Đường dẫn ----

test("fileNameOf lấy tên cuối, chấp nhận cả \\ và /", () => {
  assert.equal(fileNameOf("a/b/c.txt"), "c.txt");
  assert.equal(fileNameOf("C:\\Users\\An\\tệp văn.docx"), "tệp văn.docx");
  assert.equal(fileNameOf(""), "");
  assert.equal(fileNameOf("/"), "");
  assert.equal(fileNameOf("no-slash.txt"), "no-slash.txt");
});

test("parentDirOf lên đúng một cấp, gốc thì rỗng", () => {
  assert.equal(parentDirOf("a/b/c.txt"), "a/b");
  assert.equal(parentDirOf("a\\b\\c.txt"), "a/b"); // chuẩn hoá \ thành /
  assert.equal(parentDirOf("a/b/"), "a");
  assert.equal(parentDirOf("a"), "");
  assert.equal(parentDirOf(""), "");
});

test("crumbPaths dựng đường dẫn tích luỹ, giữ nguyên tiếng Việt và khoảng trắng", () => {
  assert.deepEqual(crumbPaths("a/b/c"), ["a", "a/b", "a/b/c"]);
  assert.deepEqual(crumbPaths(""), []);
  assert.deepEqual(crumbPaths("/"), []);
  assert.deepEqual(crumbPaths("a\\b"), ["a", "a/b"]);
  assert.deepEqual(crumbPaths("Tài liệu/báo cáo 2026"), ["Tài liệu", "Tài liệu/báo cáo 2026"]);
  // Mỗi phần tử là MỘT path hợp lệ: bấm phần tử i rồi quay lại phần tử i-1 vẫn
  // dẫn tới đúng thư mục cha.
  const crumbs = crumbPaths("x/y/z");
  for (const c of crumbs) assert.equal(c.split("/").join("/"), c);
  assert.equal(parentDirOf(crumbs[2]), crumbs[1]);
});

// ---- File quá lớn ----

test("textTooLarge: dưới trần thì rỗng, trên trần thì báo kèm dung lượng", () => {
  assert.equal(textTooLarge(0), "");
  assert.equal(textTooLarge(1024), "");
  assert.equal(textTooLarge(TEXT_PREVIEW_MAX_BYTES), "");
  const msg = textTooLarge(TEXT_PREVIEW_MAX_BYTES + 1);
  assert.ok(msg.length > 0, "phải có lời giải thích");
  assert.match(msg, /too large/);
  assert.match(msg, /Download it/);
  // size không xác định -> KHÔNG đoán thừa (chặn oan file bình thường)
  assert.equal(textTooLarge(undefined), "");
  assert.equal(textTooLarge(null), "");
  assert.equal(textTooLarge(NaN), "");
  assert.equal(textTooLarge("abc"), "");
});

test("humanBytes định dạng kiểu app, không vỡ với số rác", () => {
  assert.equal(humanBytes(512), "512 B");
  assert.match(humanBytes(2048), /KB$/);
  assert.match(humanBytes(5 * 1024 * 1024), /MB$/);
  assert.equal(humanBytes(-1), "");
  assert.equal(humanBytes(NaN), "");
});

// ---- Tóm tắt upload ----

test("uploadSummary: hết lỗi thì chỉ có note", () => {
  const r = uploadSummary(3, []);
  assert.equal(r.error, "");
  assert.match(r.note, /3\/3/);
});

test("uploadSummary: lỗi một phần thì note VÀ error CÙNG có (bug cũ mất một vế)", () => {
  const r = uploadSummary(3, ["a.zip"]);
  assert.match(r.note, /3\/4/, "phải nói rõ tổng số file");
  assert.match(r.error, /a\.zip/, "phải nêu TÊN file hỏng");
});

test("uploadSummary: when all fail, note must not say 'Uploaded'", () => {
  const r = uploadSummary(0, ["a.bin", "b.bin"]);
  assert.equal(r.note.includes("Uploaded"), false);
  assert.match(r.note, /0\/2|Could not upload/);
  assert.match(r.error, /a\.bin/);
  assert.match(r.error, /b\.bin/);
});

test("uploadSummary: hơn 3 file lỗi thì cắt bớt nhưng vẫn nói còn bao nhiêu", () => {
  const failed = ["1", "2", "3", "4", "5"];
  const r = uploadSummary(0, failed);
  assert.match(r.error, /1, 2, 3/);
  assert.match(r.error, /and 2 more/);
  assert.equal(r.error.includes("4"), false, "không liệt kê quá dài");
});

test("uploadSummary: không có file nào thì im lặng", () => {
  assert.deepEqual(uploadSummary(0, []), { note: "", error: "" });
  assert.deepEqual(uploadSummary(0, ["", "  "]), { note: "", error: "" });
});
