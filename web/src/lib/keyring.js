// Chùm chìa nhiều máy ("mục PC" kiểu 9remote) — tách khỏi api.js (round 4,
// 09/10): keyring là state multi-machine, không phải transport, để chung file
// là bug của nó rơi vào file fetch.
//
// Mỗi chìa là khóa owd_ do MỘT máy cấp — hash chỉ nằm trong devices.json của
// đúng máy ấy nên cầm cả chùm cũng không mở được máy của người khác. Chìa
// active vẫn nằm ở owm_token/owm_tenant (lib/identity-store.js) để toàn bộ app
// cũ đọc như trước.
//
// Ranh giới phụ thuộc: file này cần clearBlobUrls (xoá chìa = quên bytes của
// máy ấy) — import từ lib/blob-preview.js, tạo vòng keyring → blob-preview →
// api.js → keyring. Vòng ESM này CỐ Ý và an toàn: mọi tên dùng qua vòng đều
// nằm trong hàm gọi lúc runtime (addKey trong apiPair, ow trong closure create,
// clearBlobUrls trong removeKey), không ai chạm binding của nhau lúc eval mô-đun.
import { normalizeTenant } from "../../../shared/contract.js";
import { clearBlobUrls } from "./blob-preview.js";
import {
  clearTenant,
  clearToken,
  getTenant,
  getTenantName,
  getToken,
  setTenant,
  setToken,
} from "./identity-store.js";

const KEYS_KEY = "owm_keys";

function loadKeys() {
  migrateKeys();
  try {
    const parsed = JSON.parse(localStorage.getItem(KEYS_KEY) ?? "null");
    if (Array.isArray(parsed)) return parsed.filter((k) => k && typeof k.token === "string");
  } catch {}
  return [];
}

function saveKeys(keys) {
  localStorage.setItem(KEYS_KEY, JSON.stringify(keys));
}

// One-time migration: an old install kept exactly one key — load it into the
// keyring so nobody has to sign in again after updating. Runs lazily on the
// first keyring read instead of at import time (importing this module in bare
// Node must not touch localStorage — that is what makes it unit-testable) and
// is a no-op once owm_keys exists, so calling it repeatedly is safe.
export function migrateKeys() {
  try {
    if (localStorage.getItem(KEYS_KEY)) return;
    const token = getToken();
    if (!token) return;
    const tenant = normalizeTenant(getTenant());
    saveKeys([
      {
        tenant,
        token,
        name: getTenantName() || "PC",
        addedAt: Date.now(),
      },
    ]);
  } catch {}
}

/** Thêm/cập nhật chìa: trùng tenant = thay chìa mới (máy cấp khóa mới), không
 * nhân đôi thẻ máy. tenant rỗng = máy chính (luồng master không phòng). */
export function addKey({ tenant, token, name = "" }) {
  const clean = normalizeTenant(tenant);
  const keys = loadKeys().filter((k) => k.tenant !== clean);
  keys.unshift({ tenant: clean, token, name: String(name ?? "").trim() || clean || "PC", addedAt: Date.now() });
  saveKeys(keys);
}

/** Xóa chìa. Nếu đúng máy đang active: tự thăng máy khác làm active, hết chìa
 * thì dọn token (App sẽ về màn đăng nhập). Trả về true nếu máy bị xóa là máy
 * đang active — caller cần refresh. */
export function removeKey(tenant) {
  const clean = normalizeTenant(tenant);
  const keys = loadKeys().filter((k) => k.tenant !== clean);
  saveKeys(keys);
  // Blob cache là bytes của MÁY vừa gỡ (ảnh/PDF đã tải về). Xoá KHÔNG có điều
  // kiện "có phải máy active không": gỡ một máy khác trong chùm cũng là app quên
  // một máy đã từng cấp chìa, blob của nó không nên sống tiếp. Xoá hết thì hơi
  // phí (ảnh đang xem tải lại) nhưng lấy lại chỉ một nhịp; còn sót thì vừa giữ
  // RAM điện thoại vừa giữ nội dung của máy đã gỡ. Invariant này nằm Ở ĐÂY chứ
  // không ở caller — "xoá máy mà quên ảnh của máy ấy" là đúng dạng bug ẩn trong
  // cách gọi mà tách ra caller sẽ sinh ra.
  clearBlobUrls();
  if (normalizeTenant(getTenant()) !== clean) return false;
  const next = keys[0];
  if (next) {
    setToken(next.token);
    // setTenant("") cố ý KHÔNG ghi — nhưng cũng không XOÁ được phòng cũ đã
    // nằm trong storage. Thăng lên máy chính (phòng rỗng) mà để lại
    // owm_tenant của phòng vừa gỡ thì mọi request đi nhầm phòng → 401/503
    // liên miên dù khóa đúng. Phải dọn phòng TRƯỚC rồi mới set lại.
    clearTenant();
    setTenant(next.tenant, next.name);
  } else {
    clearToken();
    clearTenant();
  }
  return true;
}

/** Báo App biết chùm chìa đổi (xóa chìa máy active có thể đổi trạng thái paired). */
export function notifyKeysChanged() {
  window.dispatchEvent(new CustomEvent("owm:keys"));
}
