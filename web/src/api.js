// API client: same-origin với bridge. Token pairing lưu ở localStorage.
const TOKEN_KEY = "owm_token";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

// Auto-pairing kiểu cũ (master token trong #t=) — vẫn giữ làm đường dự phòng.
export function absorbTokenFromHash() {
  const match = /^#t=(.+)$/.exec(location.hash);
  if (match?.[1]) {
    setToken(match[1].trim());
    history.replaceState(null, "", location.pathname + location.search);
    return true;
  }
  return false;
}

// Mã one-time từ QR/link dạng .../#p=<code> — màn pairing sẽ tự ghép.
export function pairingCodeFromHash() {
  const match = /^#p=(.+)$/.exec(location.hash);
  if (match?.[1]) {
    history.replaceState(null, "", location.pathname + location.search);
    return match[1].trim();
  }
  return "";
}

/** Ghép thiết bị bằng mã 30 phút → nhận khóa vĩnh viễn owd_... */
export async function apiPair(code, label) {
  const res = await fetch("/api/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: code.trim(), label: label?.trim() || undefined }),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.message ?? `HTTP ${res.status}`);
  return payload; // {token, device}
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

/** URL cho EventSource (không set được header nên auth qua query _t). */
export function sseUrl(path) {
  const sep = path.includes("?") ? "&" : "?";
  return `/api/ow${path}${sep}_t=${encodeURIComponent(getToken())}`;
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
