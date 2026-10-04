// Logic THUẦN cho trang Files (đoán loại file, dựng breadcrumb, chặn file quá
// lớn, tóm tắt kết quả upload) — tách khỏi pages/files.jsx để `node --test`
// chạy được không cần DOM.
//
// Vì sao tách: files.jsx là JSX + hook + fetch. Ba quy tắc ở đây từng là chỗ
// dễ sai và không có cách nào kiểm chứng bằng mắt:
//   1. `extOf` trước đây trả "" cho mọi tên bắt đầu bằng "." — nên `.gitignore`
//      và `.env` rơi vào nhánh BINARY dù TEXT_EXT có sẵn "gitignore"/"env":
//      điều kiện `dot <= 0` chặn trước khi tên rút ngắn còn được. Người dùng
//      bấm vào `.env` thì app bảo "file nhị phân" — sai, và cũng không sửa
//      được. Sửa ở đây kèm test.
//   2. Một file text 200MB làm `res.text()` ngốn hết RAM điện thoại rồi đổ
//      vào <textarea> — tab chết, không có lựa chọn nào. Chặn TRƯỚC khi đọc,
//      theo content-length nếu engine có gửi.
//   3. Upload 5 file, 2 lỗi: code cũ chỉ nhớ LỖI CUỐI CÙNG (`setError` bị
//      ghi đè) và khi hỏng hết thì dòng "đã tải lên x/y" bị xoá — người dùng
//      không biết file nào hỏng, cũng không biết đã tải được mấy.

/**
 * Trần mở/sửa file TEXT trong trình soạn của web (8 MB).
 *
 * Con số này CHỈ chặn phần "mở trong textarea". Tải về / xem trước ảnh / PDF
 * không đi qua đây nên file lớn vẫn tải được bình thường. 8 MB là nhiều hơn
 * mọi file cấu hình/mã nguồn mà người dùng thực sự sửa trên điện thoại, và
 * vẫn nhỏ hơn rất nhiều so với RAM của một tab PWA.
 */
export const TEXT_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

/** Dung lượng kiểu app (bản sao nhỏ của formatBytes ở api.js, để lib này
 *  không phụ thuộc api.js — api.js chạm localStorage, lib thì phải thuần). */
export function humanBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "";
  const nf = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${nf.format(n / 1024)} KB`;
  return `${nf.format(n / (1024 * 1024))} MB`;
}

const TEXT_EXT = new Set([
  "txt", "md", "markdown", "json", "jsonc", "js", "jsx", "mjs", "cjs", "ts", "tsx", "css", "scss", "html", "htm",
  "xml", "yml", "yaml", "toml", "ini", "cfg", "conf", "env", "gitignore", "py", "rb", "go", "rs", "java", "kt",
  "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash", "ps1", "bat", "cmd", "sql", "csv", "tsv", "log",
  "lock", "editorconfig", "prettierrc", "eslintrc", "gitattributes", "dockerfile", "properties", "gradle",
  "gitconfig", "npmrc", "nvmrc", "babelrc", "eslintrcjson", "prettierrcjson",
]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]);
const PDF_EXT = new Set(["pdf"]);

/**
 * Phần đuôi để so với bảng ext.
 *
 * KHÔNG dùng `if (dot <= 0) return ""` như bản cũ: điều kiện đó nuốt luôn tên
 * file BẮT ĐẦU BẰNG DẤU CHẤM, vì `lastIndexOf(".")` trả 0 cho chúng. Hậu quả:
 * `.gitignore`, `.env`, `.npmrc` không bao giờ vào được TEXT_EXT dù đã khai báo.
 * Ở đây tên không có phần đuôi thì lấy CHÍNH tên tên file (bỏ dấu chấm đầu nếu
 * có) — "dockerfile" và ".gitignore" cùng ra đúng một khoá.
 */
export function extOf(name) {
  const clean = String(name ?? "");
  const dot = clean.lastIndexOf(".");
  if (dot <= 0) return clean.replace(/^\.+/, "").toLowerCase();
  return clean.slice(dot + 1).toLowerCase();
}

export function isTextName(name) {
  return TEXT_EXT.has(extOf(name));
}
export function isImageName(name) {
  return IMAGE_EXT.has(extOf(name));
}
export function isPdfName(name) {
  return PDF_EXT.has(extOf(name));
}

/** 'text' | 'image' | 'pdf' | 'binary' — thứ viewer cần để chọn cách hiển thị. */
export function kindOf(name) {
  if (isImageName(name)) return "image";
  if (isPdfName(name)) return "pdf";
  if (isTextName(name)) return "text";
  return "binary";
}

/** Tên file cuối cùng của một đường dẫn (chấp nhận cả `\` lẫn `/`). */
export function fileNameOf(path) {
  const clean = String(path ?? "");
  const parts = clean.split(/[\\/]+/).filter(Boolean);
  // Không có phần nào (chuỗi rỗng, "/", "\\") -> KHÔNG trả về chính `clean`.
  // Bản cũ trả `parts.length ? parts.at(-1) : clean` nên fileNameOf("/") ra "/",
  // tức một "tên file" là dấu gạch chéo — đi vào alt/aria-label và nhánh loại
  // file sẽ ra binary với tên vô nghĩa.
  return parts.length ? parts[parts.length - 1] : "";
}

/** Thư mục cha. `""` khi đã ở gốc (đường dẫn rỗng hoặc chỉ có một phần). */
export function parentDirOf(path) {
  const clean = String(path ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const cut = clean.lastIndexOf("/");
  return cut > 0 ? clean.slice(0, cut) : "";
}

/**
 * Mọi đường dẫn tích luỹ cho breadcrumb: "a/b/c" -> ["a", "a/b", "a/b/c"].
 *
 * `join("/")` trên danh sách phần là CHÍNH XÁC những gì breadcrumb cần, và
 * giữ được đường dẫn tiếng Việt/khoảng trắng vì không đụng tới nội dung phần
 * (chỉ nối bằng dấu gạch chéo).
 */
export function crumbPaths(path) {
  const parts = String(path ?? "")
    .split(/[\\/]+/)
    .filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length; i += 1) out.push(parts.slice(0, i + 1).join("/"));
  return out;
}

/**
 * Cảnh báo khi file text quá lớn để nhét vào <textarea>.
 * Trả CHUỖI RỖNG khi ổn (kể cả khi size không xác định — không đoán thừa).
 */
export function textTooLarge(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= TEXT_PREVIEW_MAX_BYTES) return "";
  return `File nặng ${humanBytes(n)} — quá lớn để mở trong trình soạn (tối đa ${humanBytes(
    TEXT_PREVIEW_MAX_BYTES
  )}). Hãy tải về rồi mở bằng ứng dụng khác.`;
}

/**
 * Tóm tắt một lượt upload nhiều file.
 *
 * @param {number} ok        số file đã lên thành công
 * @param {string[]} failed  tên file lỗi (giữ nguyên thứ tự)
 * @returns {{note: string, error: string}} `note` là dòng thông báo thường,
 *          `error` là câu báo lỗi (rỗng khi không có file nào hỏng).
 *
 * Cả hai trường độc lập: trước đây `error` và `uploadNote` cùng gắn một
 * Banner và Banner ẩn note khi có error, nên "3/5 file đã lên, 2 file hỏng"
 * không bao giờ hiện được cả hai vế.
 */
export function uploadSummary(ok, failed) {
  const okCount = Math.max(0, Number(ok) || 0);
  const failedNames = (Array.isArray(failed) ? failed : []).filter((n) => String(n ?? "").trim() !== "");
  const total = okCount + failedNames.length;
  if (!total) return { note: "", error: "" };
  const note = okCount
    ? `Đã tải lên ${okCount}/${total} file.`
    : `Không tải được file nào (${total} file).`;
  if (!failedNames.length) return { note, error: "" };
  const shown = failedNames.slice(0, 3).join(", ");
  const more = failedNames.length > 3 ? ` và ${failedNames.length - 3} file khác` : "";
  return { note, error: `Không tải được: ${shown}${more}.` };
}
