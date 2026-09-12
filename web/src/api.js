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

/** Gọi openwork-server qua bridge. path bắt đầu bằng "/". */
export async function ow(path, { method = "GET", body, headers = {}, raw = false } = {}) {
  const res = await fetch(`/api/ow${path}`, {
    method,
    headers: authHeaders(body !== undefined ? { "content-type": "application/json", ...headers } : headers),
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
