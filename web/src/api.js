// API client: same-origin với bridge. Token pairing lưu ở localStorage.
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
  const clean = String(id ?? "").trim().toLowerCase();
  if (!clean) return;
  localStorage.setItem(TENANT_KEY, clean);
  if (name && name !== clean) localStorage.setItem(TENANT_NAME_KEY, name);
  else localStorage.removeItem(TENANT_NAME_KEY);
}

export function clearTenant() {
  localStorage.removeItem(TENANT_KEY);
  localStorage.removeItem(TENANT_NAME_KEY);
}

// ---- Chùm chìa nhiều máy ("mục PC" kiểu 9remote) ----
// Mỗi chìa là khóa owd_ do MỘT máy cấp — hash chỉ nằm trong devices.json của
// đúng máy ấy nên cầm cả chùm cũng không mở được máy của người khác. Chìa
// active vẫn nằm ở owm_token/owm_tenant để toàn bộ app cũ đọc như trước.
const KEYS_KEY = "owm_keys";

function cleanTenantId(id) {
  return String(id ?? "").trim().toLowerCase();
}

function loadKeys() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEYS_KEY) ?? "null");
    if (Array.isArray(parsed)) return parsed.filter((k) => k && typeof k.token === "string");
  } catch {}
  return [];
}

function saveKeys(keys) {
  localStorage.setItem(KEYS_KEY, JSON.stringify(keys));
}

// Migration 1 lần: bản cũ giữ đúng 1 chìa — nạp luôn vào chùm, không ai phải
// đăng nhập lại sau khi cập nhật.
(function migrateKeys() {
  try {
    if (localStorage.getItem(KEYS_KEY)) return;
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return;
    const tenant = cleanTenantId(localStorage.getItem(TENANT_KEY));
    saveKeys([
      {
        tenant,
        token,
        name: localStorage.getItem(TENANT_NAME_KEY) || tenant || "PC",
        addedAt: Date.now(),
      },
    ]);
  } catch {}
})();

export function listKeys() {
  return loadKeys();
}

/** Thêm/cập nhật chìa: trùng tenant = thay chìa mới (máy cấp khóa mới), không
 * nhân đôi thẻ máy. tenant rỗng = máy chính (luồng master không phòng). */
export function addKey({ tenant, token, name = "" }) {
  const clean = cleanTenantId(tenant);
  const keys = loadKeys().filter((k) => k.tenant !== clean);
  keys.unshift({ tenant: clean, token, name: String(name ?? "").trim() || clean || "PC", addedAt: Date.now() });
  saveKeys(keys);
}

/** Xóa chìa. Nếu đúng máy đang active: tự thăng máy khác làm active, hết chìa
 * thì dọn token (App sẽ về màn đăng nhập). Trả về true nếu máy bị xóa là máy
 * đang active — caller cần refresh. */
export function removeKey(tenant) {
  const clean = cleanTenantId(tenant);
  const keys = loadKeys().filter((k) => k.tenant !== clean);
  saveKeys(keys);
  if (cleanTenantId(getTenant()) !== clean) return false;
  const next = keys[0];
  if (next) {
    setToken(next.token);
    setTenant(next.tenant, next.name);
  } else {
    clearToken();
    clearTenant();
  }
  return true;
}

/** Đổi tên hiển thị của 1 máy trong chùm chìa — chỉ đổi LOCAL trên app này,
 * không đụng machineName trong config của bridge (cái tên người khác thấy lúc
 * đăng nhập). Active machine đổi tên thì cả "Máy đang kết nối" đổi theo. */
export function renameKey(tenant, name) {
  const clean = cleanTenantId(tenant);
  const nice = String(name ?? "").trim().slice(0, 60);
  if (!nice) return false;
  const keys = loadKeys();
  const entry = keys.find((k) => k.tenant === clean);
  if (!entry) return false;
  entry.name = nice;
  saveKeys(keys);
  if (cleanTenantId(getTenant()) === clean) {
    // tenant rỗng: setTenant từ chối lưu (guard !clean) — ghi thẳng tên để
    // hàng "Máy đang kết nối" ở Settings cũng đổi theo
    if (clean) setTenant(clean, nice);
    else localStorage.setItem(TENANT_NAME_KEY, nice);
  }
  return true;
}

/** Báo App biết chùm chìa đổi (xóa chìa máy active có thể đổi trạng thái paired). */
export function notifyKeysChanged() {
  window.dispatchEvent(new CustomEvent("owm:keys"));
}

/** Lưới an toàn: máy đang active phải luôn có mặt trong chùm (bắt được máy
 * nối theo đường cũ không qua addKey — token dán tay, bản lưu trước migration). */
export function ensureActiveKeyEntry() {
  const token = getToken();
  if (!token) return;
  const tenant = cleanTenantId(getTenant());
  if (loadKeys().some((k) => k.tenant === tenant)) return;
  addKey({ tenant, token, name: getTenantName() });
}

// Bóc giá trị từ hash dạng #<key>=GIÁ_TRỊ[&m=PHÒNG], xóa hash sau khi đọc.
function parseHashParam(key) {
  const match = new RegExp(`^#${key}=([^&]+)(?:&m=([^&]+))?`).exec(location.hash);
  if (!match?.[1]) return null;
  history.replaceState(null, "", location.pathname + location.search);
  return {
    value: decodeURIComponent(match[1]),
    tenant: match[2] ? decodeURIComponent(match[2]) : "",
  };
}

// Auto-pairing kiểu cũ (master token trong #t=) — vẫn giữ làm đường dự phòng.
export function absorbTokenFromHash() {
  const parsed = parseHashParam("t");
  if (parsed?.value) {
    setToken(parsed.value);
    if (parsed.tenant) setTenant(parsed.tenant);
    return true;
  }
  return false;
}

// Mã one-time từ QR/link dạng .../#p=<code>&m=<phòng> — màn pairing sẽ tự ghép.
export function pairingCodeFromHash() {
  const parsed = parseHashParam("p");
  if (parsed?.value) {
    if (parsed.tenant) setTenant(parsed.tenant);
    return parsed.value;
  }
  return "";
}

// Link mời multi-tenant dạng .../#i=<user>:<secret> — trả {user, secret}
// (xóa hash ngay) để màn pairing tự đăng nhập; bấm link là vào, không gõ gì.
export function inviteFromHash() {
  const match = /^#i=([A-Za-z0-9][A-Za-z0-9-]{0,31}):([^&]+)/.exec(location.hash);
  if (!match) return null;
  history.replaceState(null, "", location.pathname + location.search);
  return { user: match[1].toLowerCase(), secret: match[2] };
}

/** Ghép thiết bị bằng mã 30 phút → nhận khóa vĩnh viễn owd_... */
export async function apiPair(code, label) {
  const res = await fetch("/api/pair", {
    method: "POST",
    headers: tenantHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ code: code.trim(), label: label?.trim() || undefined }),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.message ?? `HTTP ${res.status}`);
  // Luôn ghi vào chùm — cả máy không phòng (tenant rỗng = máy chính) để tab
  // PCs không báo thiếu máy trong khi app đang nối.
  addKey({ tenant: getTenant(), token: payload.token, name: getTenantName() });
  return payload; // {token, device}
}

/** Đăng nhập multi-tenant: user+pass do chủ worker cấp → khóa vĩnh viễn.
 * Trả {token, device, tenant, machineName}; chìa ghi vào chùm (tab PCs) và
 * mặc định thành máy active — mật khẩu KHÔNG được lưu, lần sau mở app là vào
 * thẳng. activate=false để chỉ thêm chìa mà không rời máy đang dùng. */
export async function apiPairTenant(user, secret, label, { activate = true } = {}) {
  const res = await fetch("/api/pair/tenant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      user: String(user ?? "").trim().toLowerCase(),
      secret: String(secret ?? ""),
      label: label?.trim() || undefined,
    }),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.message ?? `HTTP ${res.status}`);
  addKey({ tenant: payload.tenant, token: payload.token, name: payload.machineName });
  if (activate) {
    setToken(payload.token);
    setTenant(payload.tenant, payload.machineName);
  }
  return payload;
}

export async function apiDevices() {
  const res = await fetch("/api/devices", { headers: authHeaders() });
  if (res.status === 401) throw new Error("UNPAIRED");
  if (!res.ok) throw new Error(`devices ${res.status}`);
  return (await res.json()).devices ?? [];
}

export async function apiRevokeDevice(id) {
  const res = await fetch(`/api/devices/${encodeURIComponent(id)}`, { method: "DELETE", headers: authHeaders() });
  if (!res.ok) throw new Error(`revoke ${res.status}`);
  return res.json();
}

// ---- Thao tác với máy BẤT KỲ trong chùm chìa (không cần đổi máy active) ----

function authHeadersFor(token, tenant, extra = {}) {
  const headers = { ...extra };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const clean = cleanTenantId(tenant);
  if (clean) headers["x-owm-tenant"] = clean;
  return headers;
}

/** Trạng thái 1 máy bằng chìa của chính nó — gọi ĐÚNG 1 LẦN khi mở tab PCs,
 * không poll. online / offline (máy tắt hoặc tunnel chết) / revoked (chìa đã
 * bị thu hồi trên máy). */
export async function apiMachineStatus(token, tenant) {
  try {
    const res = await fetch("/api/state", { headers: authHeadersFor(token, tenant) });
    if (res.status === 401) return { status: "revoked" };
    if (!res.ok) return { status: "offline" };
    return { status: "online", state: await res.json().catch(() => null) };
  } catch {
    return { status: "offline" };
  }
}

/** Ngắt hẳn: thu hồi TRÊN MÁY đó khóa của chìa đang cầm (deviceId lấy từ
 * thisDevice của /api/state cùng chìa). 404 coi như xong — khóa đã chết trước đó. */
export async function apiRevokeMachineKey(token, tenant, deviceId) {
  const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
    headers: authHeadersFor(token, tenant),
  });
  if (!res.ok && res.status !== 404) throw new Error(`revoke ${res.status}`);
}

function authHeaders(extra = {}) {
  return authHeadersFor(getToken(), getTenant(), extra);
}

// Header chọn "phòng" (máy) — worker dùng để relay tới đúng bridge.
function tenantHeaders(extra = {}) {
  const tenant = getTenant();
  const headers = { ...extra };
  if (tenant) headers["x-owm-tenant"] = tenant;
  return headers;
}

export async function apiState() {
  const res = await fetch("/api/state", { headers: authHeaders() });
  if (res.status === 401) throw new Error("UNPAIRED");
  if (!res.ok) throw new Error(`state ${res.status}`);
  return res.json();
}

export async function apiRecheck() {
  const res = await fetch("/api/recheck", { method: "POST", headers: authHeaders() });
  if (res.status === 401) throw new Error("UNPAIRED");
  return res.json();
}

/** Bật OpenWork desktop trên máy tính (khi máy đang bật mà app chưa mở). */
export async function apiWakeOpenWork() {
  const res = await fetch("/api/openwork/wake", { method: "POST", headers: authHeaders() });
  if (res.status === 401) throw new Error("UNPAIRED");
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.message ?? `wake ${res.status}`);
  return payload;
}

/** Duyệt thư mục máy tính để chọn path khi tạo workspace.
 * Không truyền path → trả {roots, quick, home}; truyền path → {path, parent, dirs}. */
export async function apiFsList(path) {
  const qs = path ? `?path=${encodeURIComponent(path)}` : "";
  const res = await fetch(`/api/fs/ls${qs}`, { headers: authHeaders() });
  if (res.status === 401) throw new Error("UNPAIRED");
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.message ?? `fs ${res.status}`);
  return payload;
}

/** Tạo thư mục mới con bên trong `dir` (nút "+ Thư mục mới" trong picker). */
export async function apiFsMkdir(dir, name) {
  const res = await fetch("/api/fs/mkdir", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ dir, name }),
  });
  if (res.status === 401) throw new Error("UNPAIRED");
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.message ?? `mkdir ${res.status}`);
  return payload;
}

/** Gọi openwork-server qua bridge. path bắt đầu bằng "/". */
export async function ow(path, { method = "GET", body, headers = {}, raw = false, signal } = {}) {
  const res = await fetch(`/api/ow${path}`, {
    method,
    headers: authHeaders(body !== undefined ? { "content-type": "application/json", ...headers } : headers),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  if (res.status === 401) throw new Error("UNPAIRED");
  if (raw) return res;
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json())?.message ?? "";
    } catch {}
    const error = new Error(detail || `HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  if (res.status === 204) return null;
  return res.json();
}

/** Xoá hẳn 1 hội thoại (session) trên máy tính — nút vuốt-trái ở màn Sessions/Home. */
export async function owDeleteSession(wsId, sid) {
  await ow(`/workspace/${encodeURIComponent(wsId)}/opencode/session/${encodeURIComponent(sid)}`, {
    method: "DELETE",
  });
}

/** Tải 1 file workspace về máy, có tiến trình + hủy được.
 * Trả về {blob, filename}. Dùng header Authorization (không lộ token trên URL),
 * đọc stream để hiện % cho file lớn chục MB. */
export async function owDownload(wsId, path, { onProgress, signal, fallbackName = "" } = {}) {
  const res = await ow(`/workspace/${encodeURIComponent(wsId)}/files/raw?path=${encodeURIComponent(path)}`, {
    raw: true,
    signal,
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json())?.message ?? "";
    } catch {}
    const error = new Error(detail || `HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  const total = Number(res.headers.get("content-length") ?? 0) || 0;
  const filename = filenameFromDisposition(res.headers.get("content-disposition")) || fallbackName || guessName(path);
  if (!res.body?.getReader) {
    const blob = await res.blob();
    onProgress?.({ loaded: blob.size, total: blob.size });
    return { blob, filename };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.({ loaded, total });
  }
  const type = res.headers.get("content-type") ?? "";
  return { blob: new Blob(chunks, type ? { type } : undefined), filename };
}

/** Bóc tên file từ header content-disposition (ưu tiên filename* UTF-8). */
function filenameFromDisposition(header) {
  if (!header) return "";
  const star = /filename\*\s*=\s*(?:UTF-8''|utf-8'')?([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(String(star[1]).trim().replace(/^"|"$/g, ""));
    } catch {
      return String(star[1]).trim().replace(/^"|"$/g, "");
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim() ?? "";
}

function guessName(path) {
  const clean = String(path ?? "").replace(/[\\/]+$/, "");
  const cut = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return clean.slice(cut + 1) || "download";
}

/** URL cho EventSource (không set được header nên auth qua query _t, phòng qua _m). */
export function sseUrl(path) {
  const tenant = getTenant();
  const sep = path.includes("?") ? "&" : "?";
  return `/api/ow${path}${sep}_t=${encodeURIComponent(getToken())}${tenant ? `&_m=${encodeURIComponent(tenant)}` : ""}`;
}

// ---- Helpers chuẩn hóa shape openwork/opencode (có / không có wrapper .data)

export function unwrap(payload) {
  if (payload && typeof payload === "object" && "data" in payload) return payload.data;
  return payload;
}

export function timeAgo(ts) {
  if (!ts) return "";
  const delta = Date.now() - ts;
  if (delta < 60_000) return "vừa xong";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} phút trước`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} giờ trước`;
  return `${Math.floor(delta / 86_400_000)} ngày trước`;
}

// ---- File hai chiều (điện thoại <-> workspace) ----

/** Trần upload thô: base64 phồng ~37%, proxy chặn body trên 64MB. */
export const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

/** Định dạng dung lượng theo Intl (vi-VN). */
export function formatBytes(bytes) {
  if (bytes == null) return "";
  const nf = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${nf.format(bytes / 1024)} KB`;
  return `${nf.format(bytes / (1024 * 1024))} MB`;
}

/** Uint8Array/ArrayBuffer -> base64 theo chunk (không tràn stack như spread). */
export function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** File/Blob -> base64 (qua FileReader, gọn RAM hơn arrayBuffer + btoa). */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Không đọc được file"));
    reader.readAsDataURL(file);
  });
}

/** Upload 1 file vào workspace, trả về path tương đối để gửi cho agent. */
export async function owUploadFile(wsId, dir, file) {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `File ${file.name} quá lớn (${formatBytes(file.size)}). Giới hạn ${formatBytes(MAX_UPLOAD_BYTES)} — hãy nén hoặc chia nhỏ file rồi gửi lại.`
    );
  }
  const dataBase64 = await fileToBase64(file);
  const cleanDir = String(dir ?? "").replace(/\/+$/, "");
  const path = cleanDir ? `${cleanDir}/${file.name}` : file.name;
  await ow(`/workspace/${encodeURIComponent(wsId)}/files/raw`, {
    method: "POST",
    body: { path, dataBase64 },
  });
  return path;
}
