// API client: same-origin với bridge. Chìa + phòng đang active sống ở
// lib/identity-store.js, chùm nhiều máy ở lib/keyring.js, helper format ở
// lib/format.js — file này còn đúng một nghề: transport (fetch, timeout, auth
// headers, blob preview) và các wrapper gọi API.
import { normalizeSessionTitle } from "./lib/session-rename.js";
import { buildPromptModelFields, pickVariantId } from "./lib/model-behavior.js";
import { errorSentence, unpairedError, withTimeoutSignal } from "./lib/net.js";
import { getTenant, getTenantName, getToken } from "./lib/identity-store.js";
import { addKey } from "./lib/keyring.js";
import { bytesToBase64, filenameFromDisposition, formatBytes } from "./lib/format.js";
import { permissionReplyBody } from "./lib/session-steer.js";
import {
  dataItems,
  formAnswerOf,
  nextCursorOf,
  toV1Agents,
  toV1Forms,
  toV1Messages,
  toV1Permissions,
  toV1Providers,
  toV1Session,
  toV1Sessions,
  toV1Status,
  v2Path,
} from "./lib/v2-api.js";
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

// ---- Engine v2 (OpenCode 2.x) ----
// Mọi route đi qua whitelist mở rộng `opencode2` (bridge/src/proxy.js). Shape
// API + event của v2 KHÁC v1; bộ dịch nằm ở lib/v2-api.js, các wrapper dưới
// đây giữ nguyên tên/return shape cũ để trang không phải viết lại.

/** Path proxy tới 1 route engine v2 của workspace. */
function oc(wsId, path) {
  return v2Path(wsId, `/api${path}`);
}

/** Bóc `{data}` đơn (không phải list) — v2 luôn bọc mọi response trong `data`. */
function singleData(payload) {
  const data = payload?.data;
  if (Array.isArray(data)) return data[0] ?? null;
  return data ?? null;
}

/**
 * Đi hết các trang của một list v2.
 *
 * `order` CHỈ được gửi ở trang đầu: gửi kèm `cursor` thì engine trả 400
 * `InvalidCursorError` ("Cursor cannot be combined with order"). Cursor mã hoá
 * thứ tự + vị trí nên các trang sau chỉ cần `limit` + `cursor`. Dedupe theo id
 * vì trang biên có thể lặp (và list phiên trả thiếu so với `limit`).
 */
async function readPaged(wsId, path, { query = {}, limit = 100, cap = 2000, signal } = {}) {
  const rows = [];
  const seen = new Set();
  let cursor = "";
  for (let page = 0; page < 200; page++) {
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    if (page === 0) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === "") continue;
        params.set(key, String(value));
      }
    } else {
      params.set("cursor", cursor);
    }
    const payload = await ow(`${oc(wsId, path)}?${params.toString()}`, { signal });
    const items = dataItems(payload);
    for (const item of items) {
      const id = String(item?.id ?? "");
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      rows.push(item);
      if (rows.length >= cap) return rows;
    }
    cursor = nextCursorOf(payload);
    if (!cursor || !items.length) break;
  }
  return rows;
}

/** Danh sách phiên (đi hết trang; mới nhất trước). */
export async function owSessionList(wsId, { search = "", archived, limit = 100, cap = 2000, signal } = {}) {
  const query = { order: "desc" };
  if (search) query.search = search;
  if (archived !== undefined) query.archived = archived ? "true" : "false";
  const rows = await readPaged(wsId, "/session", { query, limit, cap, signal });
  return toV1Sessions(rows);
}

/** Một phiên theo id, shape v1 (`session.revert.messageID` vẫn đọc được). */
export async function owSession(wsId, sid, { signal } = {}) {
  const payload = await ow(oc(wsId, `/session/${encodeURIComponent(sid)}`), { signal });
  return toV1Session(singleData(payload));
}

/** Tạo phiên mới; trả shape v1. */
export async function owCreateSession(wsId, body = {}) {
  const payload = await ow(oc(wsId, "/session"), { method: "POST", body });
  return toV1Session(singleData(payload));
}

/** Xoá hẳn 1 hội thoại (session) trên máy tính — nút vuốt-trái ở màn Sessions/Home. */
export async function owDeleteSession(wsId, sid) {
  await ow(oc(wsId, `/session/${encodeURIComponent(sid)}`), { method: "DELETE" });
}

/**
 * Toàn bộ transcript của phiên, đã dịch sang shape v1 (`{info, parts}[]`).
 *
 * v2 phân trang mặc định; lấy theo `desc` (trang đầu = tin mới nhất) rồi đảo
 * lại thành thứ tự thời gian. `cap` cắt phía CŨ — màn chat cần tin mới, và
 * transcript 2000 tin đã vượt xa mọi phiên thật trên điện thoại.
 */
export async function owMessages(wsId, sid, { limit = 100, cap = 2000, signal } = {}) {
  const rows = await readPaged(wsId, `/session/${encodeURIComponent(sid)}/message`, {
    query: { order: "desc" },
    limit,
    cap,
    signal,
  });
  rows.reverse();
  return toV1Messages(rows);
}

/** Map `{sid:{type}}` các phiên ĐANG chạy (vắng mặt = rảnh). */
export async function owStatus(wsId, { signal } = {}) {
  const payload = await ow(oc(wsId, "/session/active"), { signal });
  return toV1Status(payload);
}

/** Thẻ "Agent xin phép" đang chờ của phiên. */
export async function owPermissions(wsId, sid, { signal } = {}) {
  const payload = await ow(oc(wsId, `/session/${encodeURIComponent(sid)}/permission`), { signal });
  return toV1Permissions(payload);
}

/** Trả lời thẻ xin phép: decision = "once" | "always" | "reject". */
export async function owPermissionReply(wsId, sid, requestId, decision) {
  return ow(
    oc(wsId, `/session/${encodeURIComponent(sid)}/permission/${encodeURIComponent(requestId)}/reply`),
    { method: "POST", body: permissionReplyBody(decision) }
  );
}

/** Hủy lượt chạy đang dở (v2: interrupt, không phải abort). */
export async function owInterrupt(wsId, sid) {
  return ow(oc(wsId, `/session/${encodeURIComponent(sid)}/interrupt`), { method: "POST" });
}

/** Catalog provider/model gộp từ `/api/provider` + `/api/model`, shape v1. */
export async function owProviders(wsId, { signal } = {}) {
  const [providers, models] = await Promise.all([
    ow(oc(wsId, "/provider"), { signal }),
    ow(oc(wsId, "/model"), { signal }),
  ]);
  return toV1Providers(providers, models);
}

/** Path SSE (đã kèm OW_PROXY_PREFIX) cho `connectEvents` của lib/sse.js. */
export function owEventsPath(wsId) {
  return `${OW_PROXY_PREFIX}${oc(wsId, "/event")}`;
}

/** Duyệt thư mục workspace. v2 trả `{path,type}` — UI cần thêm `name`. */
export async function owFsList(wsId, dir, { signal } = {}) {
  const params = new URLSearchParams({ path: String(dir ?? "") });
  const payload = await ow(`${oc(wsId, "/fs/list")}?${params.toString()}`, { signal });
  return dataItems(payload).map((entry) => ({ ...entry, name: guessName(entry.path) }));
}

/** Danh sách agent của workspace (chọn agent khi gửi prompt). */
export async function owAgents(wsId) {
  return toV1Agents(await ow(oc(wsId, "/agent")));
}

/** Slash command + skill của workspace (gõ "/" trong ô gõ). */
export async function owCommands(wsId) {
  return dataItems(await ow(oc(wsId, "/command")));
}

/** Form (câu hỏi agent) đang chờ trả lời — danh sách chung, UI lọc theo phiên. */
export async function owQuestions(wsId) {
  return toV1Forms(await ow(oc(wsId, "/form")));
}

/**
 * Trả lời form: `selections` = mỗi field một mảng nhãn đã chọn, đúng thứ tự
 * field. Bộ dịch ép nhãn -> value và kiểu theo `type` của field
 * (lib/v2-api formAnswerOf), rồi POST `{answer:{key:value}}`.
 */
export async function owReplyQuestion(wsId, request, selections) {
  const form = request?.form;
  const sid = String(request?.sessionID ?? form?.sessionID ?? "");
  const fid = String(request?.id ?? form?.id ?? "");
  if (!sid || !fid) throw new Error("This question is no longer available.");
  await ow(oc(wsId, `/session/${encodeURIComponent(sid)}/form/${encodeURIComponent(fid)}/reply`), {
    method: "POST",
    body: formAnswerOf(form, selections),
  });
}

/** Từ chối trả lời — xoá form, agent nhận "không có câu trả lời" và đi tiếp. */
export async function owRejectQuestion(wsId, request) {
  const form = request?.form;
  const sid = String(request?.sessionID ?? form?.sessionID ?? "");
  const fid = String(request?.id ?? form?.id ?? "");
  if (!sid || !fid) return;
  await ow(oc(wsId, `/session/${encodeURIComponent(sid)}/form/${encodeURIComponent(fid)}`), {
    method: "DELETE",
  });
}

/**
 * Hoàn tác tới messageID: v2 STAGE con trỏ revert (rows vẫn nằm trong list —
 * UI tự cắt bằng lib/session-ops applyRevertCursor). Lượt prompt kế tiếp tự
 * commit và xoá con trỏ.
 */
export async function owRevert(wsId, sid, messageId) {
  return ow(oc(wsId, `/session/${encodeURIComponent(sid)}/revert/stage`), {
    method: "POST",
    body: { messageID: messageId, files: false },
  });
}

/** Bỏ con trỏ revert, hiện lại các tin đã ẩn (DELETE /revert). */
export async function owUnrevert(wsId, sid) {
  return ow(oc(wsId, `/session/${encodeURIComponent(sid)}/revert`), { method: "DELETE" });
}

/**
 * Tạo nhánh session mới. v2 chép lịch sử CHẶT TRƯỚC `messageID` (`before`) —
 * muốn nhánh từ tin M (bao gồm M) thì truyền id tin kế tiếp
 * (resolveForkBoundaryId), hoặc bỏ trống để fork toàn bộ. Trả session mới.
 */
export async function owFork(wsId, sid, messageId = "") {
  const payload = await ow(oc(wsId, `/session/${encodeURIComponent(sid)}/fork`), {
    method: "POST",
    body: { before: messageId || null },
  });
  return toV1Session(singleData(payload));
}

/** Xoá một tin nhắn trong session — engine v2 không có route này. */
export async function owDeleteMessage() {
  throw new Error("Deleting a single message is not supported on this engine — use Revert instead.");
}

/**
 * Đổi tên phiên (PATCH /session/:id, body { title }). Tên rác tới đây đã bị
 * lib/session-rename chặn sẵn — rỗng, quá 120 ký tự hay nhiều dòng đều ném
 * lỗi tiếng Việt NGAY Ở CLIENT, không tốn một vòng mạng để máy từ chối.
 */
export async function owRenameSession(wsId, sid, title) {
  const clean = normalizeSessionTitle(title);
  if (!clean.ok) throw new Error(clean.error);
  const payload = await ow(oc(wsId, `/session/${encodeURIComponent(sid)}`), {
    method: "PATCH",
    body: { title: clean.title },
  });
  return toV1Session(singleData(payload));
}

/**
 * Gửi prompt cho session.
 *
 * v2 tách model/agent khỏi prompt: `/model` và `/agent` đặt trạng thái phiên
 * TRƯỚC, rồi `/prompt` chỉ có text. Cùng một đường cho cả lượt chạy MỚI và
 * tin XEN GIỮA lúc agent đang chạy (engine tự chèn ở step kế tiếp). Payload
 * model/effort do lib/model-behavior dựng; `reasoning_effort` của Codex được
 * quy về `variant` mà engine v2 khai cho model đó.
 */
export async function owPrompt(wsId, sid, { text, model = "", agent = "", effort, variants } = {}) {
  const fields = buildPromptModelFields({ modelValue: model, effort, variants });
  const ref = fields.model
    ? {
        id: String(fields.model.modelID ?? ""),
        providerID: String(fields.model.providerID ?? ""),
        ...(() => {
          const variant = fields.variant ?? pickVariantId(variants, fields.reasoning_effort);
          return variant ? { variant } : {};
        })(),
      }
    : null;
  if (ref?.id && ref?.providerID) {
    await ow(oc(wsId, `/session/${encodeURIComponent(sid)}/model`), {
      method: "POST",
      body: { model: ref },
    });
  }
  const name = String(agent ?? "").trim();
  if (name) {
    await ow(oc(wsId, `/session/${encodeURIComponent(sid)}/agent`), {
      method: "POST",
      body: { agent: name },
    });
  }
  return ow(oc(wsId, `/session/${encodeURIComponent(sid)}/prompt`), {
    method: "POST",
    body: { text: String(text ?? "") },
  });
}

/**
 * Nén hội thoại (POST /session/:id/compact). `model` là giá trị
 * "provider/model" của ModelPicker — chưa chọn model thì nói rõ cần chọn;
 * v2 nén bằng model ĐANG đặt trên phiên (owPrompt đặt trước mỗi lượt).
 * `timeoutMs: 0` vì nén gọi LLM hàng chục giây tới vài phút; bỏ giữa lúc nén
 * là abort nửa chừng, phiên còn lửng lơ.
 */
export async function owSummarize(wsId, sid, model) {
  if (!String(model ?? "").trim()) throw new Error("Select a model before compacting the conversation.");
  return ow(oc(wsId, `/session/${encodeURIComponent(sid)}/compact`), {
    method: "POST",
    body: {},
    timeoutMs: 0,
  });
}

/** Link chia sẻ — engine v2 không có route share. */
export async function owShareSession() {
  throw new Error("Share links are not supported on this engine.");
}

export async function owUnshareSession() {
  throw new Error("Share links are not supported on this engine.");
}

/** Chạy slash command trong session (POST /session/:id/command {name,text}). */
export async function owRunCommand(wsId, sid, { command, args = "" } = {}) {
  return ow(oc(wsId, `/session/${encodeURIComponent(sid)}/command`), {
    method: "POST",
    body: { name: String(command ?? ""), text: String(args ?? "") },
    timeoutMs: 0, // xem owSummarize: lệnh cũng gọi LLM, miễn timeout
  });
}

/** Danh sách việc agent đang theo — engine v2 không có route todo. */
export async function owTodo() {
  return [];
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
