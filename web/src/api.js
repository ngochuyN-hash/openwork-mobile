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
  const match = /^#i=([A-Za-z0-9][A-Za-z0-9-]{0,31}):([A-Za-z0-9_-]+)/.exec(location.hash);
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
  return payload; // {token, device}
}

/** Đăng nhập multi-tenant: user+pass do chủ worker cấp → khóa vĩnh viễn.
 * Trả {token, device, tenant, machineName}; khóa + phòng lưu luôn localStorage —
 * mật khẩu KHÔNG được lưu, lần sau mở app là vào thẳng. */
export async function apiPairTenant(user, secret, label) {
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
  setToken(payload.token);
  setTenant(payload.tenant, payload.machineName);
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

function authHeaders(extra = {}) {
  const token = getToken();
  const headers = { ...extra };
  if (token) headers["authorization"] = `Bearer ${token}`;
  return tenantHeaders(headers);
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

// ---- Xem + điều khiển màn hình máy tính (v1.7, học cơ chế 9remote) ----

/** Thông tin màn hình: {available, screen:{width,height}, viewers} */
export async function apiScreenInfo() {
  const res = await fetch("/api/screen/info", { headers: authHeaders() });
  if (res.status === 401) throw new Error("UNPAIRED");
  return res.json().catch(() => ({ available: false }));
}

/** Gửi 1 lệnh điều khiển chuột/bàn phím. Tọa độ gửi chuẩn hóa 0..1. */
export async function owScreenInput(payload) {
  const res = await fetch("/api/screen/input", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(payload),
  });
  if (res.status === 401) throw new Error("UNPAIRED");
  if (res.status === 429) throw new Error("Đang gửi lệnh quá nhanh — chờ 1 nhịp rồi làm tiếp");
  if (!res.ok && res.status !== 204) {
    const p = await res.json().catch(() => null);
    throw new Error(p?.message ?? `screen input ${res.status}`);
  }
}

/**
 * Nối stream frame màn hình từ bridge. Mỗi frame trên đường truyền là
 * [4 byte độ dài][1 byte type][payload]: 0 = màn đứng yên, 1 = JPEG,
 * 2 = meta JSON, 3 = lỗi JSON. Promise kết thúc khi server ngắt hoặc signal abort.
 */
export async function owScreenStream({ w = 880, q = 55, signal, onFrame, onMeta, onUnchanged, onError }) {
  const res = await fetch(`/api/screen/stream?w=${w}&q=${q}`, { headers: authHeaders(), signal });
  if (res.status === 401) throw new Error("UNPAIRED");
  if (!res.ok || !res.body) {
    const p = await res.json().catch(() => null);
    throw new Error(p?.message ?? `screen stream ${res.status}`);
  }
  const reader = res.body.getReader();
  const text = new TextDecoder();
  let buf = new Uint8Array(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    if (value?.length) {
      const merged = new Uint8Array(buf.length + value.length);
      merged.set(buf);
      merged.set(value, buf.length);
      buf = merged;
    }
    while (buf.length >= 5) {
      const len = (buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3];
      if (len < 0 || len > 8_000_000) throw new Error("Frame hỏng (độ dài sai)");
      const type = buf[4];
      if (buf.length < 5 + len) break;
      const payload = buf.subarray(5, 5 + len);
      if (type === 1) onFrame?.(new Blob([payload], { type: "image/jpeg" }));
      else if (type === 2) {
        try { onMeta?.(JSON.parse(text.decode(payload))); } catch {}
      } else if (type === 3) {
        try { onError?.(JSON.parse(text.decode(payload)).message ?? "Lỗi chụp màn hình"); } catch {}
      } else if (type === 0) onUnchanged?.();
      buf = buf.subarray(5 + len);
    }
  }
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
