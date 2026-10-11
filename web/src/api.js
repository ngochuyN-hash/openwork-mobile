// API client: same-origin với bridge. Chìa + phòng đang active sống ở
// lib/identity-store.js, chùm nhiều máy ở lib/keyring.js, helper format ở
// lib/format.js — file này còn đúng một nghề: transport (fetch, timeout, auth
// headers, blob preview) và các wrapper gọi API.
import { normalizeSessionTitle } from "./lib/session-rename.js";
import { buildSummarizeBody, summarizePath } from "./lib/session-compact.js";
import { buildPromptModelFields } from "./lib/model-behavior.js";
import { errorSentence, unpairedError, withTimeoutSignal } from "./lib/net.js";
import { getTenant, getTenantName, getToken } from "./lib/identity-store.js";
import { addKey } from "./lib/keyring.js";
import { bytesToBase64, filenameFromDisposition, formatBytes, unwrap } from "./lib/format.js";
import {
  BRIDGE_ROUTES,
  HEADER_TENANT,
  OW_PROXY_PREFIX,
  normalizeTenant,
} from "../../shared/contract.js";

// Trần chờ cho request qua tunnel. Engine desktop dùng 10s cho request không
// phải stream (app/lib/opencode.ts:44); web đi qua thêm 2 chặng (worker ->
// cloudflared -> bridge) nên để rộng hơn, nhưng KHÔNG để vô hạn — fetch tới
// tunnel treo không tự hết và UI sẽ kẹt vĩnh viễn ở "đang tải".
const OW_TIMEOUT_MS = 30_000;

/** Ghép thiết bị bằng mã 30 phút → nhận khóa vĩnh viễn owd_... */
export async function apiPair(code, label) {
  // KHÔNG chặn mã sai hình dạng ở client. Bridge mới là nơi quyết định
  // (so thời gian trên mã ĐANG SỐNG, bridge/src/pairing.js:97) và bảng chữ cái
  // của nó là (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, pairing.js:14) — đặt bản sao
  // thứ hai ở web nghĩa là mỗi lần sửa bridge là mọi người dùng không ghép
  // được nữa, và lỗi nằm ở máy tính chứ không phải điện thoại. Sai hình dạng
  // tốn đúng MỘT vòng mạng và bridge trả sẵn câu tiếng Việt rõ ràng.
  const res = await fetch(BRIDGE_ROUTES.pair, {
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
  const payload = await bridge(BRIDGE_ROUTES.devices);
  return payload?.devices ?? [];
}

export const apiRevokeDevice = (id) =>
  bridge(`${BRIDGE_ROUTES.devices}/${encodeURIComponent(id)}`, { method: "DELETE" });

// Authorization + tenant headers, optionally for a key other than the active one.
function authHeadersFor(token, tenant, extra = {}) {
  const headers = { ...extra };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const clean = normalizeTenant(tenant);
  if (clean) headers[HEADER_TENANT] = clean;
  return headers;
}

function authHeaders(extra = {}) {
  return authHeadersFor(getToken(), getTenant(), extra);
}

// Header chọn "phòng" (máy) — worker dùng để relay tới đúng bridge.
function tenantHeaders(extra = {}) {
  const tenant = getTenant();
  const headers = { ...extra };
  if (tenant) headers[HEADER_TENANT] = tenant;
  return headers;
}

/**
 * Transport cho các API CỦA BRIDGE (fetch thẳng, không qua proxy engine — khác
 * `ow()` bên dưới). Một chỗ sở hữu error contract mà trước đây từng wrapper tự
 * cuộn theo một kiểu riêng: 401 → `unpairedError()`; body `{code,message}` →
 * `error.message` (câu tiếng Việt của bridge, UI hiện nguyên văn) + `error.code`;
 * `error.candidates` khi bridge gửi kèm danh sách đường dẫn (lỗi wake không thấy
 * exe — giữ lại cho bộ chọn ở settings + banner, đừng vứt); không có message thì
 * `HTTP <status>`. Body JSON tuỳ chọn; caller đọc `.status` khi cần phân nhánh
 * riêng (pairing screen đọc `error.code`).
 */
async function bridge(path, { method = "GET", body, headers = {}, signal } = {}) {
  const res = await fetch(path, {
    method,
    headers: authHeaders(body !== undefined ? { "content-type": "application/json", ...headers } : headers),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  if (res.status === 401) throw unpairedError();
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const error = new Error(payload?.message ?? `HTTP ${res.status}`);
    error.status = res.status;
    error.code = typeof payload?.code === "string" ? payload.code : "";
    error.candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
    throw error;
  }
  return payload;
}

export async function apiState() {
  const guard = withTimeoutSignal(null, OW_TIMEOUT_MS);
  try {
    return await bridge(BRIDGE_ROUTES.state, { signal: guard.signal });
  } finally {
    guard.release();
  }
}

export async function apiRecheck() {
  return bridge(BRIDGE_ROUTES.recheck, { method: "POST" });
}

/** Bật OpenWork desktop trên máy tính (khi máy đang bật mà app chưa mở). */
export const apiWakeOpenWork = () => bridge(BRIDGE_ROUTES.openworkWake, { method: "POST" });

/** Chỉ đường dẫn OpenWork.exe khi bridge chưa tìm thấy (POST /api/openwork/path).
 * Bridge tự kiểm tra file rồi lưu config — web không spawn, không kiểm tra gì cả.
 * Lỗi ném ra mang đúng `message` tiếng Việt của bridge để UI hiện nguyên văn. */
export const apiOpenWorkPath = (path) =>
  bridge(BRIDGE_ROUTES.openworkPath, { method: "POST", body: { path: String(path ?? "").trim() } });

/** Mã ghép one-time đang sống trên bridge (GET /api/pairing-code, cần khóa máy).
 * Trả {code, codeFormatted, secondsLeft, pairUrl, qr, masterUrl, masterQr, ...}.
 * UI chủ đích KHÔNG vẽ masterUrl/masterQr: token master vĩnh viễn chỉ nên nằm
 * trong terminal/GUI trên máy tính, còn mã one-time tự vô hiệu sau 1 lần dùng. */
export const apiPairingCode = () => bridge(BRIDGE_ROUTES.pairingCode);

/** Restart tunnel thủ công (POST /api/tunnel/restart): thay cloudflared, giữ
 * nguyên bridge — dùng khi tunnel kẹt backoff 429 mà chưa tự nhả. 409 = tunnel
 * không chạy (hoặc đang restart dở). Lưu ý: tunnel chết HẲN thì điện thoại
 * không gọi tới được máy — lúc đó phải bấm nút ↻ trên GUI máy tính. */
export const apiRestartTunnel = () => bridge(BRIDGE_ROUTES.tunnelRestart, { method: "POST" });

/** Đổi tên máy (POST /api/machine/name) — thiết bị ghép SAU sẽ thấy tên mới ở
 * màn đăng nhập. Bridge tự dẹp ký tự lạ và cắt 60 ký tự; tên rỗng chặn ngay ở
 * client cho khỏi tốn một round-trip về máy. */
export async function apiSetMachineName(name) {
  const clean = String(name ?? "").trim();
  if (!clean) throw new Error("Machine name is empty.");
  return bridge(BRIDGE_ROUTES.machineName, { method: "POST", body: { name: clean } });
}

/** Duyệt thư mục máy tính để chọn path khi tạo workspace.
 * Không truyền path → trả {roots, quick, home}; truyền path → {path, parent, dirs}. */
export const apiFsList = (path) =>
  bridge(`${BRIDGE_ROUTES.fsList}${path ? `?path=${encodeURIComponent(path)}` : ""}`);

/** Tạo thư mục mới con bên trong `dir` (nút "+ Thư mục mới" trong picker). */
export const apiFsMkdir = (dir, name) =>
  bridge(BRIDGE_ROUTES.fsMkdir, { method: "POST", body: { dir, name } });

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
    const res = await fetch(`${OW_PROXY_PREFIX}${path}`, {
      method,
      headers: authHeaders(body !== undefined ? { "content-type": "application/json", ...headers } : headers),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: guard?.signal ?? signal,
    });
    if (res.status === 401) throw unpairedError();
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
      const error = new Error("Computer returned error data instead of JSON (check the tunnel).");
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
  if (!body) throw new Error("Select a model before compacting the conversation.");
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
      results.push({ wsId: id, ok: false, error: errorSentence(e) });
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

function guessName(path) {
  const clean = String(path ?? "").replace(/[\\/]+$/, "");
  const cut = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return clean.slice(cut + 1) || "download";
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

/** File/Blob -> base64 (qua FileReader, gọn RAM hơn arrayBuffer + btoa). */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

/** Upload 1 file vào workspace, trả về path tương đối để gửi cho agent. */
export async function owUploadFile(wsId, dir, file) {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `File ${file.name} is too large (${formatBytes(file.size)}). The limit is ${formatBytes(MAX_UPLOAD_BYTES)} — compress it or split it, then send again.`
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

/**
 * Ghi NỘI DUNG CHUỖI vào 1 file workspace (POST /files/raw) — cùng seam với
 * owUploadFile. Trước đây save() của FileViewer tự cuộn base64 + POST, thành
 * seam ghi-file thứ hai chép tay: sửa một nơi là quên nơi kia. Blob/file nhị
 * phân hãy dùng owUploadFile.
 */
export async function owWriteFile(wsId, path, content) {
  const base64 = bytesToBase64(new TextEncoder().encode(String(content ?? "")));
  await ow(`/workspace/${encodeURIComponent(wsId)}/files/raw`, {
    method: "POST",
    body: { path, dataBase64: base64 },
  });
}
