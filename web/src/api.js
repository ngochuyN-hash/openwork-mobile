// API client: same-origin với bridge. Token pairing lưu ở localStorage.
import { normalizeSessionTitle } from "./lib/session-rename.js";
import { buildSummarizeBody, summarizePath } from "./lib/session-compact.js";
import { buildPromptModelFields } from "./lib/model-behavior.js";
import { parseHashParam } from "./lib/route.js";
import { withTimeoutSignal } from "./lib/net.js";

const TOKEN_KEY = "owm_token";
// Multi-tenant: "phòng" = máy đang kết nối. Lưu kèm token; mọi request kèm
// header x-owm-tenant (worker dùng để chọn đúng bridge), SSE dùng ?_m=.
const TENANT_KEY = "owm_tenant";
const TENANT_NAME_KEY = "owm_tenant_name";

// Trần chờ cho request qua tunnel. Engine desktop dùng 10s cho request không
// phải stream (app/lib/opencode.ts:44); web đi qua thêm 2 chặng (worker ->
// cloudflared -> bridge) nên để rộng hơn, nhưng KHÔNG để vô hạn — fetch tới
// tunnel treo không tự hết và UI sẽ kẹt vĩnh viễn ở "đang tải".
const OW_TIMEOUT_MS = 30_000;

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
    // setTenant("") cố tình KHÔNG ghi — nhưng cũng không XOÁ được phòng cũ đã
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
  const parsed = readHashParam("t");
  if (parsed?.value) {
    setToken(parsed.value);
    if (parsed.tenant) setTenant(parsed.tenant);
    return true;
  }
  return false;
}

// Mã one-time từ QR/link dạng .../#p=<code>&m=<phòng> — màn pairing sẽ tự ghép.
export function pairingCodeFromHash() {
  const parsed = readHashParam("p");
  if (parsed?.value) {
    if (parsed.tenant) setTenant(parsed.tenant);
    return parsed.value;
  }
  return "";
}

/** Ghép thiết bị bằng mã 30 phút → nhận khóa vĩnh viễn owd_... */
export async function apiPair(code, label) {
  // KHÔNG chặn mã sai hình dạng ở client. Bridge mới là nơi quyết định
  // (so thời gian trên mã ĐANG SỐNG, bridge/src/pairing.js:97) và bảng chữ cái
  // của nó là (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, pairing.js:14) — đặt bản sao
  // thứ hai ở web nghĩa là mỗi lần sửa bridge là mọi người dùng không ghép
  // được nữa, và lỗi nằm ở máy tính chứ không phải điện thoại. Sai hình dạng
  // tốn đúng MỘT vòng mạng và bridge trả sẵn câu tiếng Việt rõ ràng.
  const res = await fetch("/api/pair", {
    method: "POST",
    headers: tenantHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ code: String(code ?? "").trim(), label: label?.trim() || undefined }),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    // Keep the machine-readable code (e.g. tenant_required) on the error so
    // the pairing screen can show the matching guidance, not just the text.
    const error = new Error(payload?.message ?? `HTTP ${res.status}`);
    error.status = res.status;
    error.code = typeof payload?.code === "string" ? payload.code : "";
    throw error;
  }
  // Luôn ghi vào chùm — cả máy không phòng (tenant rỗng = máy chính) để tab
  // PCs không báo thiếu máy trong khi app đang nối.
  addKey({ tenant: getTenant(), token: payload.token, name: getTenantName() });
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

// Authorization + tenant headers, optionally for a key other than the active one.
function authHeadersFor(token, tenant, extra = {}) {
  const headers = { ...extra };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const clean = cleanTenantId(tenant);
  if (clean) headers["x-owm-tenant"] = clean;
  return headers;
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
  const guard = withTimeoutSignal(null, OW_TIMEOUT_MS);
  let res;
  try {
    res = await fetch("/api/state", { headers: authHeaders(), signal: guard.signal });
  } finally {
    guard.release();
  }
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
  if (!res.ok) {
    const error = new Error(payload?.message ?? `wake ${res.status}`);
    error.status = res.status;
    // Bridge trả kèm `candidates` khi không tìm thấy exe (openwork_exe_not_found) —
    // giữ lại để màn Cài đặt đưa vào chung bộ chọn đường dẫn, đừng vứt đi.
    error.candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
    throw error;
  }
  return payload;
}

/** Chỉ đường dẫn OpenWork.exe khi bridge chưa tìm thấy (POST /api/openwork/path).
 * Đây là API của bridge (không đi qua proxy /api/ow) nên gọi fetch thẳng, y hệt
 * apiWakeOpenWork. Bridge tự kiểm tra file rồi lưu config — web không spawn, không
 * kiểm tra gì cả. Lỗi ném ra mang đúng `message` tiếng Việt của bridge để UI hiện
 * nguyên văn cho người dùng. */
export async function apiOpenWorkPath(path) {
  const res = await fetch("/api/openwork/path", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ path: String(path ?? "").trim() }),
  });
  if (res.status === 401) throw new Error("UNPAIRED");
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.message ?? `path ${res.status}`);
  return payload; // { ok: true, openwork: { found, exe, version, source, candidates } }
}

/** Mã ghép one-time đang sống trên bridge (GET /api/pairing-code, cần khóa máy).
 * Trả {code, codeFormatted, secondsLeft, pairUrl, qr, masterUrl, masterQr, ...}.
 * UI chủ đích KHÔNG vẽ masterUrl/masterQr: token master vĩnh viễn chỉ nên nằm
 * trong terminal/GUI trên máy tính, còn mã one-time tự vô hiệu sau 1 lần dùng. */
export async function apiPairingCode() {
  const res = await fetch("/api/pairing-code", { headers: authHeaders() });
  if (res.status === 401) throw new Error("UNPAIRED");
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.message ?? `pairing-code ${res.status}`);
  return payload;
}

/** Restart tunnel thủ công (POST /api/tunnel/restart): thay cloudflared, giữ
 * nguyên bridge — dùng khi tunnel kẹt backoff 429 mà chưa tự nhả. 409 = tunnel
 * không chạy (hoặc đang restart dở). Lưu ý: tunnel chết HẲN thì điện thoại
 * không gọi tới được máy — lúc đó phải bấm nút ↻ trên GUI máy tính. */
export async function apiRestartTunnel() {
  const res = await fetch("/api/tunnel/restart", { method: "POST", headers: authHeaders() });
  if (res.status === 401) throw new Error("UNPAIRED");
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.message ?? `tunnel ${res.status}`);
  return payload; // { ok: true, tunnel: {...} }
}

/** Đổi tên máy (POST /api/machine/name) — thiết bị ghép SAU sẽ thấy tên mới ở
 * màn đăng nhập. Bridge tự dẹp ký tự lạ và cắt 60 ký tự; tên rỗng chặn ngay ở
 * client cho khỏi tốn một round-trip về máy. */
export async function apiSetMachineName(name) {
  const clean = String(name ?? "").trim();
  if (!clean) throw new Error("Tên máy trống.");
  const res = await fetch("/api/machine/name", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ name: clean }),
  });
  if (res.status === 401) throw new Error("UNPAIRED");
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.message ?? `machine ${res.status}`);
  return payload; // { ok: true, machineName }
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

/**
 * Gọi openwork-server qua bridge. path bắt đầu bằng "/".
 *
 * `timeoutMs` mặc định OW_TIMEOUT_MS: tunnel treo thì fetch treo mãi và UI kẹt
 * vô hạn. Truyền `0` để tắt (stream dài / tải file lớn — `raw: true` tự tắt vì
 * đọc body kiểu stream không có "xong" để đo).
 */
export async function ow(
  path,
  { method = "GET", body, headers = {}, raw = false, signal, timeoutMs = OW_TIMEOUT_MS } = {}
) {
  // `raw` tự tắt trần chờ: caller đọc body kiểu stream (tải file chục MB, xem
  // tiến trình %) nên không có mốc "xong" để đo, và caller đã tự quản lý
  // AbortController của nút Hủy.
  const guard = raw || !timeoutMs ? null : withTimeoutSignal(signal, timeoutMs);
  try {
    const res = await fetch(`/api/ow${path}`, {
      method,
      headers: authHeaders(body !== undefined ? { "content-type": "application/json", ...headers } : headers),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: guard?.signal ?? signal,
    });
    if (res.status === 401) throw new Error("UNPAIRED");
    if (raw) return res;
    if (!res.ok) {
      const error = new Error((await errorTextOf(res)) || `HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }
    if (res.status === 204) return null;
    // 200 nhưng body không phải JSON (SPA fallback của worker, trang lỗi HTML của
    // Cloudflare): `res.json()` ném SyntaxError thô lên UI. Thay bằng lỗi nói
    // đúng nguyên nhân thay vì "... is not valid JSON".
    const text = await res.text();
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      const error = new Error("Máy tính trả về dữ liệu lỗi thay vì JSON (kiểm tra lại tunnel).");
      error.status = res.status;
      throw error;
    }
  } finally {
    // Ở CUỐI hàm, không phải ngay sau fetch: tháo listener sớm làm mất khả
    // năng hủy của caller đúng lúc đang đọc body.
    guard?.release();
  }
}

/**
 * Message lỗi từ body của bridge/worker/engine. Cả ba tầng đều trả
 * `{code, message}` (bridge/src/auth.js:21, worker/src/index.js:132,
 * apps/server/src/errors.ts:7) nhưng body rác/HTML vẫn phải cho ra `HTTP <n>`
 * chứ không phải nội dung HTML.
 */
async function errorTextOf(res) {
  try {
    const payload = await res.json();
    return typeof payload?.message === "string" ? payload.message : "";
  } catch {
    return "";
  }
}

/** Xoá hẳn 1 hội thoại (session) trên máy tính — nút vuốt-trái ở màn Sessions/Home. */
export async function owDeleteSession(wsId, sid) {
  await ow(`/workspace/${encodeURIComponent(wsId)}/opencode/session/${encodeURIComponent(sid)}`, {
    method: "DELETE",
  });
}

// ---- Thao tác trên MỘT session (kiểm chứng live với engine /doc 03/10) ----
// Tất cả đều đi qua whitelist proxy sẵn có (`/workspace/:id/opencode/...`) nên
// KHÔNG cần mở thêm backend. `messageID` bắt buộc bỏ trừ khi ghi chú.

function oc(wsId, path) {
  return `/workspace/${encodeURIComponent(wsId)}/opencode${path}`;
}

/** Danh sách agent của workspace (chọn agent khi gửi prompt). */
export async function owAgents(wsId) {
  return unwrap(await ow(oc(wsId, "/agent"))) ?? [];
}

/** Slash command + skill của workspace (gõ "/" trong ô gõ). */
export async function owCommands(wsId) {
  return unwrap(await ow(oc(wsId, "/command"))) ?? [];
}

/** Câu hỏi agent đang chờ trả lời (danh sách chung, lọc theo session ở UI). */
export async function owQuestions(wsId) {
  return unwrap(await ow(oc(wsId, "/question"))) ?? [];
}

/** Trả lời: answers = mỗi câu một mảng nhãn đã chọn, đúng thứ tự câu hỏi. */
export async function owReplyQuestion(wsId, requestId, answers) {
  await ow(oc(wsId, `/question/${encodeURIComponent(requestId)}/reply`), {
    method: "POST",
    body: { answers },
  });
}

/** Từ chối trả lời — agent nhận kết quả "không có câu trả lời" và tự đi tiếp. */
export async function owRejectQuestion(wsId, requestId) {
  await ow(oc(wsId, `/question/${encodeURIComponent(requestId)}/reject`), { method: "POST" });
}

/**
 * Hoàn tác tới messageID: engine đặt con trỏ session.revert, transcript API vẫn
 * trả đủ — UI tự cắt (lib/session-ops applyRevertCursor).
 */
export async function owRevert(wsId, sid, messageId) {
  return unwrap(await ow(oc(wsId, `/session/${encodeURIComponent(sid)}/revert`), {
    method: "POST",
    body: { messageID: messageId },
  }));
}

/** Bỏ con trỏ revert, hiện lại các tin đã ẩn. */
export async function owUnrevert(wsId, sid) {
  return unwrap(await ow(oc(wsId, `/session/${encodeURIComponent(sid)}/unrevert`), { method: "POST" }));
}

/**
 * Tạo nhánh session mới. Engine chép tin CHẶT TRƯỚC `messageID` — muốn nhánh
 * từ tin M (bao gồm M) thì truyền id tin kế tiếp (resolveForkBoundaryId), hoặc
 * bỏ trống để fork toàn bộ. Trả session mới.
 */
export async function owFork(wsId, sid, messageId = "") {
  const body = messageId ? { messageID: messageId } : {};
  return unwrap(await ow(oc(wsId, `/session/${encodeURIComponent(sid)}/fork`), { method: "POST", body }));
}

/** Xoá một tin nhắn trong session. */
export async function owDeleteMessage(wsId, sid, messageId) {
  return ow(oc(wsId, `/session/${encodeURIComponent(sid)}/message/${encodeURIComponent(messageId)}`), {
    method: "DELETE",
  });
}

/**
 * Đổi tên phiên (PATCH /session/:id, body { title }). Tên rác tới đây đã bị
 * lib/session-rename chặn sẵn — rỗng, quá 120 ký tự hay nhiều dòng đều ném
 * lỗi tiếng Việt NGAY Ở CLIENT, không tốn một vòng mạng để máy từ chối.
 */
export async function owRenameSession(wsId, sid, title) {
  const clean = normalizeSessionTitle(title);
  if (!clean.ok) throw new Error(clean.error);
  return unwrap(await ow(oc(wsId, `/session/${encodeURIComponent(sid)}`), {
    method: "PATCH",
    body: { title: clean.title },
  }));
}

/**
 * Gửi prompt cho session (POST /session/:id/prompt_async).
 *
 * Cùng một đường cho cả hai việc: lượt chạy MỚI (session rảnh) và tin XEN
 * GIỮA lúc agent đang chạy — ở engine v1 không có endpoint steer riêng,
 * engine tự chèn tin vào lượt đang dở ở step kế tiếp. Payload model/effort
 * do lib/model-behavior dựng (variant HOẶC reasoning_effort, không bao giờ
 * cả hai), nên chỗ gọi không phải tự cắt chuỗi "provider/model" nữa.
 */
export async function owPrompt(wsId, sid, { text, model = "", agent = "", effort, variants } = {}) {
  const fields = buildPromptModelFields({ modelValue: model, effort, variants });
  const name = String(agent ?? "").trim();
  return ow(oc(wsId, `/session/${encodeURIComponent(sid)}/prompt_async`), {
    method: "POST",
    body: {
      parts: [{ type: "text", text: String(text ?? "") }],
      ...fields,
      ...(name ? { agent: name } : {}),
    },
  });
}

/**
 * Nén hội thoại (POST /session/:id/summarize, body { providerID, modelID }).
 * `model` là giá trị "provider/model" của ModelPicker; chưa chọn model thì
 * engine không có gì để tóm tắt bằng — chặn ngay, nói rõ cần chọn model.
 */
export async function owSummarize(wsId, sid, model) {
  const body = buildSummarizeBody(model);
  if (!body) throw new Error("Chọn model trước khi nén hội thoại.");
  // `timeoutMs: 0` = không đặt timeout. `/summarize` và `/command` đều gọi LLM,
  // chạy hàng chục giây tới vài phút; engine cũng miễn timeout cho đúng hai
  // endpoint này (apps/app/src/app/lib/opencode.ts, SESSION_LONG_RUNNING_URL_RE
  // → 0). Bỏ giữa lúc nén là abort nửa chừng, phiên còn lửng lơ.
  return ow(summarizePath(wsId, sid), { method: "POST", body, timeoutMs: 0 });
}

/** Bật link chia sẻ (POST /session/:id/share, body rỗng). Link ở Session.share.url. */
export async function owShareSession(wsId, sid) {
  return ow(oc(wsId, `/session/${encodeURIComponent(sid)}/share`), { method: "POST" });
}

/** Tắt link chia sẻ (DELETE /session/:id/share, body rỗng). */
export async function owUnshareSession(wsId, sid) {
  return ow(oc(wsId, `/session/${encodeURIComponent(sid)}/share`), { method: "DELETE" });
}

/** Chạy slash command trong session (POST /session/:id/command). */
export async function owRunCommand(wsId, sid, { command, args = "", model } = {}) {
  return ow(oc(wsId, `/session/${encodeURIComponent(sid)}/command`), {
    method: "POST",
    body: { command, arguments: args, ...(model ? { model } : {}) },
    timeoutMs: 0, // xem owSummarize: lệnh cũng gọi LLM, miễn timeout
  });
}

/** Danh sách việc agent đang theo (GET /session/:id/todo). */
export async function owTodo(wsId, sid) {
  return unwrap(await ow(oc(wsId, `/session/${encodeURIComponent(sid)}/todo`))) ?? [];
}

/** Nạp lại engine từng workspace (POST /workspace/:id/engine/reload — whitelist
 * arm `engine/reload`, cùng action "Reload engine" trong Settings desktop).
 * Dùng sau khi đổi MCP/plugin trên máy hoặc khi engine dựng dở. Chạy TUẦN TỰ và
 * không hỏng cả lô khi 1 workspace lỗi — trả [{wsId, ok, error?}] theo thứ tự. */
export async function owEngineReloadAll(wsIds) {
  const ids = (Array.isArray(wsIds) ? wsIds : []).map((id) => String(id ?? "").trim()).filter(Boolean);
  const results = [];
  for (const id of ids) {
    try {
      await ow(`/workspace/${encodeURIComponent(id)}/engine/reload`, { method: "POST" });
      results.push({ wsId: id, ok: true });
    } catch (e) {
      results.push({ wsId: id, ok: false, error: String(e?.message || e) });
    }
  }
  return results;
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

/** Bóc tên file từ header content-disposition (ưu tiên filename* UTF-8).
 * Exported (pure helper) so the content-disposition rules stay unit-testable. */
export function filenameFromDisposition(header) {
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

/**
 * Bóc wrapper `{data: ...}` của engine.
 *
 * `{data: null}` vẫn trả `null` (không đổi so với bản cũ) vì hàng chục chỗ gọi
 * kiểu `unwrap(p) ?? []` / `unwrap(p) ?? p ?? {}` — trả về chính envelope ở đây
 * làm `.map`/`sortByUpdated` nổ trên object. Chỗ thật sự hỏng trước đây là
 * `data: undefined`: `"data" in payload` khớp rồi trả `undefined`, mất trắng
 * luôn object. Mảng đi qua nguyên vẹn (`"data" in []` là false với mảng rỗng
 * nhưng để rõ ý định thì chặn trước).
 */
export function unwrap(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && "data" in payload) {
    return payload.data === undefined ? payload : payload.data;
  }
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

/**
 * Trần upload: lấy đúng hạn mức của ENGINE, không phải trần của proxy.
 *
 * `POST /files/raw` kiểm FILE_SESSION_MAX_FILE_BYTES = 5.000.000 byte
 * (apps/server/src/routes/files.ts) và trả 413 `file_too_large`. Trần 40MB
 * của proxy là trần "body", nên báo 40MB là nói dối: mọi file 5–40MB đều hỏng
 * với lỗi không giải thích được. Đổi con số này thì phải sửa cả thông báo.
 */
const MAX_UPLOAD_BYTES = 5_000_000;

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
function fileToBase64(file) {
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
