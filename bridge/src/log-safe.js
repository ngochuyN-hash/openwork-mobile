/**
 * Che bí mật trước khi in ra console.
 *
 * Vì sao cần: bridge chạy bằng task/VBS thì stdout bị đổi vào bridge-task.log
 * trên đĩa, còn logwipe chỉ quét lúc khởi động + 1 lần/ngày — token in ra là
 * nằm trên đĩa ngày cả. Master token (owm_/owd_/owt_) là vĩnh viễn nên tuyệt
 * đối không được lọt vào log.
 *
 * Quy ước:
 * - #t=<token> (master key) -> "#t=<redacted>". Đây là thứ phải giấu hoàn toàn.
 * - ?_t=<token> (bản web cũ dán token vào query) -> xoá hẳn cặp key=value,
 *   hết query thì mất luôn dấu "?".
 * - #p=<code> (mã ghép nối one-time) -> GIỮ 4 ký tự đầu, che đuôi. Mã này sống
 *   30 phút (CODE_TTL_MINUTES) và QR bên cạnh vẫn giữ bản đầy đủ để quét, nên
 *   che bớt trong log là an toàn mà không mất khả năng dán link tay.
 * - Mọi thứ khác (host, path, #m=<phòng>) giữ nguyên để log vẫn đọc được.
 */

import { MASTER_TOKEN_HASH, PAIR_CODE_HASH, TOKEN_PREFIX_SOURCE } from "../../shared/contract.js";

const REDACTED = "<redacted>";
const MASK = "•"; // dùng ký tự không phải ASCII để "che" không lẫn với ký tự thật

// Key trong query/hash mang token. So khớp không phân biệt hoa thường cho an toàn.
// `_t` là dạng query của master key (web bản cũ dán `?_t=`); `t` là key hash
// hiện tại — cả hai lấy tên từ shared/contract.js để đổi key là log che theo.
const SECRET_KEYS = new Set([
  `_${MASTER_TOKEN_HASH}`,
  MASTER_TOKEN_HASH,
  "token",
  "access_token",
  "authtoken",
  "auth_token",
]);
// Số ký tự đầu của mã one-time được giữ lại trong log (phần còn lại che).
const PAIRING_CODE_VISIBLE = 4;

/**
 * Che phần đuôi của chuỗi, giữ `visible` ký tự đầu.
 * @param {string} value
 * @param {number} visible
 * @returns {string}
 */
function maskTail(value, visible = PAIRING_CODE_VISIBLE) {
  if (value.length <= visible) return MASK.repeat(value.length);
  return value.slice(0, visible) + MASK.repeat(value.length - visible);
}

/**
 * Xử lý `a=1&b=2` (query hoặc hash) — che value của key bí mật, giữ nguyên
 * phần còn lại và giữ nguyên thứ tự.
 *
 * `dropSecrets` quyết định cách xử lý key bí mật:
 * - hash  -> giữ `key=<redacted>` (web đọc #t=, giữ hình dạng cho log dễ đọc).
 * - query -> XOÁ HẲN cặp key=value (web bản cũ dán `?_t=<token>`; bỏ cặp
 *   sạch hơn giữ lại tên tham số vô dụng).
 *
 * @param {string} params không có dấu "?"/"#" ở đầu
 * @param {boolean} dropSecrets
 * @returns {string}
 */
function redactParams(params, dropSecrets) {
  const kept = [];
  for (const pair of params.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq === -1) {
      kept.push(pair); // không phải key=value (vd route #/ws/...) -> giữ nguyên
      continue;
    }
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    const lower = key.toLowerCase();
    if (SECRET_KEYS.has(lower)) {
      if (!dropSecrets) kept.push(`${key}=${REDACTED}`);
    } else if (lower === PAIR_CODE_HASH) {
      kept.push(`${key}=${maskTail(value)}`);
    } else {
      kept.push(pair);
    }
  }
  return kept.join("&");
}

/**
 * Bản log-safe của một URL: giữ nguyên host + path, che token.
 * Không ném lỗi — đầu vào không phải chuỗi thì trả về nguyên vẹn để log vẫn
 * in được thay vì làm sập cả tiến trình bridge chỉ vì một dòng log.
 * @param {string} input
 * @returns {string}
 */
export function redactUrl(input) {
  if (typeof input !== "string" || input === "") return input;
  const hashAt = input.indexOf("#");
  const beforeHash = hashAt === -1 ? input : input.slice(0, hashAt);
  const hash = hashAt === -1 ? null : input.slice(hashAt + 1);

  const qAt = beforeHash.indexOf("?");
  const base = qAt === -1 ? beforeHash : beforeHash.slice(0, qAt);
  const query = qAt === -1 ? null : beforeHash.slice(qAt + 1);

  const outQuery = query === null ? null : redactParams(query, true);
  const outHash = hash === null ? null : redactParams(hash, false);
  // Query/hash rỗng sau khi lọc -> bỏ hẳn dấu "?"/"#" cho URL gọn.
  return (
    base +
    (outQuery ? `?${outQuery}` : "") +
    (outHash ? `#${outHash}` : "")
  );
}

// Tiền tố chìa khóa của OpenWork — danh sách prefix nằm ở shared/contract.js
// (web/src/pages/pairing.jsx dựng regex kiểm tra hình dạng từ cùng nguồn).
const TOKEN_LIKE = new RegExp(`\\b${TOKEN_PREFIX_SOURCE}[0-9a-zA-Z]+`, "g");

/**
 * Quét bất kỳ chuỗi nào (message lỗi, stack) và thay mọi chìa khóa trần bên
 * trong bằng <redacted>. Dùng cho console.error vì lỗi tới từ cloudflared /
 * OpenWork có thể kèm URL đã nhúng token.
 * @param {unknown} input
 * @returns {unknown} không phải chuỗi thì trả về nguyên vện
 */
export function redactSecrets(input) {
  if (typeof input !== "string") return input;
  return input.replace(TOKEN_LIKE, REDACTED);
}