import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { candidateExeEntries } from "./openwork-launch.js";

// Đọc phiên bản OpenWork desktop đã cài trên máy — để điện thoại biết "máy anh
// đang chạy bản nào", không chỉ biết bridge sống hay chết.
//
// Nguồn duy nhất: resources/app.asar của bản cài thật (Electron nhét
// package.json của app vào đó, "version": "0.18.54").
// KHÔNG spawn PowerShell để đọc version resource của PE: /api/state được
// điện thoại poll liên tục, mỗi lần spawn là một tiến trình trên máy chủ.
// Không đọc asar thì trả "" (web hiện "không đọc được") — thà thiếu còn hơn
// đoán bừa.

// Bố cục asar (Chromium Pickle), tính từ đầu file:
//   [0..4)   kích thước payload pickle #1 (luôn = 4)
//   [4..8)   headerSize — tổng số byte pickle #2 tính từ vị trí 8
//   [8..12)  kích thước payload pickle #2 (= 4 + headerString đã đệm)
//   [12..16) độ dài chuỗi JSON header (KHÔNG kể byte đệm)
//   [16..)   JSON header, đệm cho tròn 4 byte, rồi tới payload của các file.
// Nên dữ liệu file bắt đầu tại 8 + headerSize, tương đương 16 + len(JSON đệm).
// Ta lấy độ dài JSON ở offset 12 để cắt JSON, còn điểm bắt đầu payload thì lấy
// từ offset 4 (nó bao trọn cả byte đệm) — offset 12 không bao hàm byte đệm.
const HEADER_PREFIX = 16;
const HEADER_MAX_BYTES = 64 * 1024 * 1024; // trần thủ phòng: header rác khai báo vài GB
const READ_CHUNK = 1024 * 1024;

// Cache version theo app.asar (xem openworkVersionFrom) — chỉ vài entry vì
// mỗi máy có một bản cài, và clear khi đầy là đủ.
const versionCache = new Map();
const VERSION_CACHE_MAX = 8;

/** Làm tròn lên bội số 4 (Pickle đệm chuỗi tới 4 byte). */
const pad4 = (n) => (n + 3) & ~3;

/** Tìm entry "package.json" trong cây header (thường nằm ngay gốc app.asar). */
function findPackageJson(files, depth = 0) {
  const entry = files?.["package.json"];
  if (entry && typeof entry === "object") return entry;
  if (depth >= 3) return null;
  for (const value of Object.values(files ?? {})) {
    if (value?.files) {
      const hit = findPackageJson(value.files, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Đọc `package.json` từ trong file .asar.
 * Trả `null` khi file không tồn tại / header bị cắt cụt / JSON hỏng — mọi lỗi
 * đều bị nuốt, vì đây là thông tin "cho có", không được làm hỏng /api/state.
 */
export function readAsarPackageJson(asarPath) {
  if (!asarPath) return null;
  let fd;
  try {
    fd = openSync(asarPath, "r");
    const fileSize = fstatSync(fd).size;
    if (fileSize < HEADER_PREFIX) return null;

    const prefix = Buffer.alloc(HEADER_PREFIX);
    if (readExact(fd, prefix, 0) < HEADER_PREFIX) return null;
    // byte đầu của asar luôn là 4 (payload pickle #1 chỉ chứa 1 số) — file
    // không phải asar thì lệch ngay ở đây.
    if (prefix.readUInt32LE(0) !== 4) return null;

    const headerPickleSize = prefix.readUInt32LE(4);
    const jsonLength = prefix.readUInt32LE(12);
    if (!Number.isInteger(jsonLength) || jsonLength <= 0 || jsonLength > HEADER_MAX_BYTES) return null;
    if (HEADER_PREFIX + jsonLength > fileSize) return null; // header bị cắt cụt
    // Điểm bắt đầu payload: headerSize ở offset 4 đã gồm byte đệm; cách tự
    // tính từ JSON đệm là dự phòng cho headerSize rác. Trên asar thật hai
    // cách cho ra cùng một con số.
    const dataStart = Math.max(8 + headerPickleSize, HEADER_PREFIX + pad4(jsonLength));

    const json = Buffer.alloc(jsonLength);
    if (readExact(fd, json, HEADER_PREFIX) < jsonLength) return null;

    const header = JSON.parse(json.toString("utf8"));
    const entry = findPackageJson(header?.files);
    if (!entry || entry.unpacked === true) return null; // file nằm ngoài asar (.unpacked)
    const size = Number(entry.size);
    const offset = Number(entry.offset);
    if (!Number.isInteger(size) || size <= 0 || !Number.isInteger(offset) || offset < 0) return null;
    const from = dataStart + offset;
    if (from + size > fileSize) return null;

    const payload = Buffer.alloc(size);
    if (readExact(fd, payload, from) < size) return null;
    return JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

/** đọc đủ `buf.length` byte tại `position`, không nuốt mất phần đọc được. */
function readExact(fd, buf, position) {
  let got = 0;
  while (got < buf.length) {
    const n = readSync(fd, buf, got, Math.min(READ_CHUNK, buf.length - got), position + got);
    if (n <= 0) break;
    got += n;
  }
  return got;
}

/** Phiên bản OpenWork đi cùng `exePath` (đọc resources/app.asar), "" nếu không biết. */
export function openworkVersionFrom(exePath) {
  const exe = String(exePath ?? "").trim();
  if (!exe) return "";
  const asarPath = join(dirname(exe), "resources", "app.asar");

  // /api/state được điện thoại poll mỗi 15s, còn app.asar thật có header
  // ~3.5 MB: đọc + JSON.parse đồng bộ mỗi lần chặn event loop của bridge
  // (đo được ~13 ms/lần trên bản cài thật, cộng dồn theo số máy đang poll).
  // Cache khoá theo đường dẫn + mtime + size — nâng cấp app là tự vô hiệu hoá.
  let stamp;
  try {
    const st = statSync(asarPath);
    if (!st.isFile()) return "";
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    return ""; // chưa có app.asar — KHÔNG cache, cài xong lần sau đọc thật
  }
  const cached = versionCache.get(asarPath);
  if (cached && cached.stamp === stamp) return cached.version;

  const pkg = readAsarPackageJson(asarPath);
  const version = typeof pkg?.version === "string" ? pkg.version.trim() : "";
  if (versionCache.size >= VERSION_CACHE_MAX) versionCache.clear();
  versionCache.set(asarPath, { stamp, version });
  return version;
}

/**
 * Mô tả bản OpenWork desktop đang cài: tìm file .exe (đúng thứ tự
 * candidateExeEntries) rồi đọc version.
 * → { found, exe, version, source: "env" | "config" | "wellknown" | "" }
 */
export function describeOpenWorkInstall({ configOpenworkExe = "" } = {}) {
  for (const { path: candidate, source } of candidateExeEntries(configOpenworkExe)) {
    try {
      if (!candidate || !existsSync(candidate)) continue;
      return { found: true, exe: candidate, version: openworkVersionFrom(candidate), source };
    } catch {
      // path lỗi (ký tự lạ, quyền) — thử chỗ tiếp theo
    }
  }
  return { found: false, exe: "", version: "", source: "" };
}