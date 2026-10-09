// Nơi cất chìa + phòng đang active (localStorage) — tách khỏi api.js (round 4,
// 09/10) để "app biết mình là ai" không còn sống trong file transport.
// Chuẩn hoá phòng đi qua contract normalizeTenant — web không tự có luật riêng
// (trước đây api.js tự chép trim+lowercase, màn login còn strip thêm).
import { MASTER_TOKEN_HASH, PAIR_CODE_HASH, normalizeTenant } from "../../../shared/contract.js";
import { parseHashParam } from "./route.js";

const TOKEN_KEY = "owm_token";
// Multi-tenant: "phòng" = máy đang kết nối. Lưu kèm token; mọi request kèm
// header x-owm-tenant (worker dùng để chọn đúng bridge), SSE dùng ?_m=.
const TENANT_KEY = "owm_tenant";
const TENANT_NAME_KEY = "owm_tenant_name";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export function getTenant() {
  return localStorage.getItem(TENANT_KEY) ?? "";
}

export function getTenantName() {
  return localStorage.getItem(TENANT_NAME_KEY) || getTenant();
}

export function setTenant(id, name = "") {
  const clean = normalizeTenant(id);
  if (!clean) return;
  localStorage.setItem(TENANT_KEY, clean);
  if (name && name !== clean) localStorage.setItem(TENANT_NAME_KEY, name);
  else localStorage.removeItem(TENANT_NAME_KEY);
}

export function clearTenant() {
  localStorage.removeItem(TENANT_KEY);
  localStorage.removeItem(TENANT_NAME_KEY);
}

// Bóc giá trị từ hash dạng #<key>=GIÁ_TRỊ[&m=PHÒNG], xóa hash sau khi đọc.
// Việc decode/parse nằm ở lib/route.js (thuần, test được); chỗ này giữ phần
// đụng trình duyệt. `decodeURIComponent` trên hash hỏng từng ném URIError ra
// giữa lúc main.jsx import module — app trắng màn.
function readHashParam(key) {
  const parsed = parseHashParam(location.hash, key);
  if (!parsed) return null;
  history.replaceState(null, "", location.pathname + location.search);
  return parsed;
}

// Auto-pairing kiểu cũ (master token trong #t=) — vẫn giữ làm đường dự phòng.
export function absorbTokenFromHash() {
  const parsed = readHashParam(MASTER_TOKEN_HASH);
  if (parsed?.value) {
    setToken(parsed.value);
    if (parsed.tenant) setTenant(parsed.tenant);
    return true;
  }
  return false;
}

// Mã one-time từ QR/link dạng .../#p=<code>&m=<phòng> — màn pairing sẽ tự ghép.
export function pairingCodeFromHash() {
  const parsed = readHashParam(PAIR_CODE_HASH);
  if (parsed?.value) {
    if (parsed.tenant) setTenant(parsed.tenant);
    return parsed.value;
  }
  return "";
}
