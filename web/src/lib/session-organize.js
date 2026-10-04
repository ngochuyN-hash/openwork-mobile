// Logic THUẦN cho SẮP XẾP PHIÊN: ghim · lưu trữ · nhóm phiên. Tách khỏi
// sessions.jsx / home.jsx để `node --test` chạy được không cần DOM — cùng cách
// lib/session-ops.js và lib/session-rename.js đang làm cho chat.jsx.
//
// File này chia làm hai tầng, và ranh giới đó là chủ đích:
//
//   1. CỜ CỦA TÔI (ghim / lưu trữ) — chỉ nằm trong localStorage của máy đang
//      cầm điện thoại, KHÔNG gọi server. Hai cờ này là sở thích cá nhân của
//      người dùng ("việc này tôi hay mở"), không phải dữ liệu của workspace:
//      đồng bộ nó qua máy tính là việc của đợt khác (xem mục CHƯA LÀM).
//      Vì không có server nên hai hàm đọc/ghi ở đây NHẬN `storage` làm tham số —
//      đó là cách `node --test` chạy được chúng không cần localStorage thật.
//
//   2. NHÓM PHIÊN — có thật trên máy tính, đọc/ghi qua
//      `/workspace/{id}/session-groups` (đã nằm sẵn trong whitelist bridge,
//      bridge/src/proxy.js:8). Hàm ở đây chỉ lo phần THUẦN: chuẩn hoá state
//      server trả về, đổi assignment, đổi tên, xoá, sắp lại, dựng path + body.
//      Gửi request là việc của UI (sessions.jsx gọi `ow()` của api.js).
//
// NGUYÊN TẮC CHUNG (học từ session-rename.js — cắt âm thầm là loại "làm hộ rồi
// giấu"): hàm nào TRẢ VỀ cho người dùng thì không tự cắt, mà trả lỗi để UI báo
// và giữ nguyên nội dung ô nhập.

/** Khoá localStorage chứa cờ ghim/lưu trữ, tách theo từng workspace. */
export const FLAGS_KEY = "owm_session_flags";

/**
 * Trần tên nhóm. KHÔNG phải trần tự chọn: server cắt `label` ở 120 —
 * apps/server/src/routes/session-groups.ts:73-88 (POST) và :138-152 (PATCH).
 * Ta chốt cùng con số để hai loại "tên" (phiên + nhóm) có một trần và một
 * `maxlength` cho ô nhập.
 */
export const MAX_GROUP_LABEL_LENGTH = 120;

/** Trần id nhóm tuỳ chọn khi POST — session-groups.ts:73-88 (`body.id`). */
export const MAX_GROUP_ID_LENGTH = 128;

/** Nhãn khối "chưa xếp nhóm nào" — hiện ra khi phiên chưa được gán. */
export const UNGROUPED_LABEL = "Ungrouped";

/** Giá trị `groupId` giả dành cho bộ lọc "phiên chưa nhóm" (id thật không thể
 *  bằng vì engine tự sinh). */
export const UNGROUPED_ID = "__none__";

export const GROUP_ERRORS = {
  empty: "Group name cannot be empty.",
  tooLong: `Group name can be at most ${MAX_GROUP_LABEL_LENGTH} characters.`,
  notText: "Group name must be text, not a number or list.",
};

export const FLAG_KINDS = ["pinned", "archived"];

// ==================== TẦNG 1 — CỜ GHIM / LƯU TRỮ (localStorage) ====================

/** Cờ rỗng — luôn có cả hai mảng để chỗ đọc không phải kiểm tra undefined. */
export function emptyFlags() {
  return { pinned: [], archived: [] };
}

function idList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Chuẩn hoá cờ gì cả về `{pinned, archived}` với id là chuỗi không rỗng, không
 * trùng. Dữ liệu đọc lên từ localStorage là JSON bất kỳ — có thể do một bản
 * web cũ ghi, hoặc do người dùng sửa tay trong DevTools; hàm này là chỗ duy
 * nhất chịu trách nhiệm đỡ nó.
 */
export function normalizeFlags(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    pinned: idList(src.pinned),
    archived: idList(src.archived),
  };
}

/** localStorage có thể không tồn tại (SSR, test, Safari private) — đừng ném. */
function safeStorage(storage) {
  if (storage) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readFlagsMap(storage) {
  const store = safeStorage(storage);
  if (!store) return {};
  try {
    const parsed = JSON.parse(store.getItem(FLAGS_KEY) ?? "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Đọc cờ của MỘT workspace. Hỏng/mất key → cờ rỗng (không ném) vì cờ là tiện
 * ích: mất cờ thì mất ghim, còn ném lỗi thì cả màn hình sessions chết theo.
 */
export function loadFlags(wsId, storage) {
  return normalizeFlags(readFlagsMap(storage)[String(wsId ?? "")]);
}

/**
 * Ghi cờ của MỘT workspace mà không đụng các workspace khác — cùng lý do
 * migrateKeys() trong api.js: chùm chìa nhiều máy phải giữ nguyên khi máy
 * active đổi.
 */
export function saveFlags(wsId, flags, storage) {
  const store = safeStorage(storage);
  if (!store) return normalizeFlags(flags);
  const map = readFlagsMap(storage);
  const next = normalizeFlags(flags);
  map[String(wsId ?? "")] = next;
  try {
    store.setItem(FLAGS_KEY, JSON.stringify(map));
  } catch {}
  return next;
}

/** Cờ `kind` của một phiên đang bật hay không. */
export function flagOn(flags, kind, sessionId) {
  const list = normalizeFlags(flags)[kind];
  return Array.isArray(list) && list.includes(String(sessionId ?? ""));
}

/**
 * Bật/tắt một cờ, trả về object MỚI (không sửa tại chỗ) để useState nhận ra
 * đổi. Ghim phiên chưa có id là no-op — id rỗng vào danh sách chỉ là rác mà
 * không ai xoá được.
 */
export function toggleFlag(flags, kind, sessionId) {
  const base = normalizeFlags(flags);
  if (!FLAG_KINDS.includes(kind)) return base;
  const id = String(sessionId ?? "").trim();
  if (!id) return base;
  const list = base[kind];
  return {
    ...base,
    [kind]: list.includes(id) ? list.filter((x) => x !== id) : [...list, id],
  };
}

/** Mốc cập nhật — dùng để sắp xếp mới nhất lên đầu. */
export function updatedAt(session) {
  const n = Number(session?.time?.updated ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Sắp xếp mới nhất trước (sessions.jsx từng tự sort inline — gom ra đây). */
export function sortByUpdated(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  return [...list].sort((a, b) => updatedAt(b) - updatedAt(a));
}

/**
 * Tách danh sách phiên thành ba phần theo cờ cục bộ.
 *
 * `archived` tách RIÊNG chứ không chỉ lọc đi, vì màn hình vẫn cần hiện mục
 * "Lưu trữ" (bấm vào là thấy mình đã cất gì, bấm ra là lấy lại được).
 */
export function splitByFlags(sessions, flags) {
  const f = normalizeFlags(flags);
  const out = { pinned: [], rest: [], archived: [] };
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (f.archived.includes(String(s?.id ?? ""))) out.archived.push(s);
    else if (f.pinned.includes(String(s?.id ?? ""))) out.pinned.push(s);
    else out.rest.push(s);
  }
  return out;
}

/**
 * Bộ lọc duy nhất cho cả màn Sessions: lọc theo cờ (`scope`) và theo nhóm
 * (`groupId`), trả về danh sách đã sắp xếp mới nhất trước.
 *
 *   scope: "all" (mặc định — ẩn phiên đã lưu trữ) | "pinned" | "archived"
 *   groupId: null = mọi nhóm · UNGROUPED_ID = chưa nhóm · id thật = nhóm đó
 */
export function selectSessions(sessions, { flags, scope = "all", groupId = null, groupState } = {}) {
  const f = normalizeFlags(flags);
  const buckets = splitByFlags(sessions, f);
  let list;
  if (scope === "pinned") list = buckets.pinned;
  else if (scope === "archived") list = buckets.archived;
  // scope "all" = MỌI phiên trừ mục đã lưu trữ — nên phải lấy pinned + rest.
  // Trước đây lấy mỗi buckets.rest là phiên đã ghim BIẾN MẤT khỏi danh sách
  // chính ngay sau khi bấm ghim: mục "Ghim" thì thấy, mục "Tất cả" thì không.
  else list = [...buckets.pinned, ...buckets.rest];

  if (groupId) {
    const st = normalizeGroupState(groupState);
    list = list.filter((s) => {
      const gid = groupIdOf(st, s?.id);
      return groupId === UNGROUPED_ID ? !gid : gid === groupId;
    });
  }
  return sortPinnedFirst(list, f);
}

/** Phiên đã ghim đứng trên cùng; trong mỗi phần thì mới nhất trước. Đây là
 * cùng cách home.jsx dồn ghim lên đầu, để hai màn không lệch nhau. */
function sortPinnedFirst(list, flags) {
  const pinned = normalizeFlags(flags).pinned;
  const rank = (s) => (pinned.includes(String(s?.id ?? "")) ? 0 : 1);
  return [...list].sort((a, b) => rank(a) - rank(b) || updatedAt(b) - updatedAt(a));
}

// ==================== TẦNG 2 — NHÓM PHIÊN (server) ====================

export function emptyGroupState() {
  return { groups: [], assignments: {} };
}

/**
 * Chuẩn hoá state nhóm về `{groups:[{id,label}], assignments:{sid:gid}}`.
 *
 * Nhận được CẢ ba dạng: response đầy đủ `{state, updatedAt}`, state thô
 * `{groups, assignments}`, hay rác (`null`, mảng, JSON hỏng) — vì cùng một
 * hàm này được gọi sau GET, sau POST/PUT/PATCH (tất cả đều trả `{state}`) và
 * sau khi đọc localStorage. Server có thể bỏ nhóm đã xoá khỏi `groups` nhưng
 * còn sót trong `assignments`; ta cũng dọn luôn ở đây để nhóm "ma" không bao
 * giờ lọt lên UI.
 */
export function normalizeGroupState(payload) {
  const src =
    payload && typeof payload === "object" && !Array.isArray(payload) && "state" in payload
      ? payload.state
      : payload;
  const groups = [];
  const seen = new Set();
  for (const raw of Array.isArray(src?.groups) ? src.groups : []) {
    const id = typeof raw?.id === "string" ? raw.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    groups.push({ id, label: typeof raw?.label === "string" ? raw.label : "" });
  }
  const assignments = {};
  const rawAssignments = src?.assignments;
  if (rawAssignments && typeof rawAssignments === "object" && !Array.isArray(rawAssignments)) {
    for (const [sid, gid] of Object.entries(rawAssignments)) {
      const s = typeof sid === "string" ? sid.trim() : "";
      const g = typeof gid === "string" ? gid.trim() : "";
      if (!s || !g || !seen.has(g)) continue; // nhóm không còn -> coi như chưa nhóm
      assignments[s] = g;
    }
  }
  return { groups, assignments };
}

/** Lấy `state` đúng kiểu từ response của server (mọi route đều trả `{state}`). */
export function groupStateFromResponse(response) {
  return normalizeGroupState(response);
}

/** Nhóm của một phiên, hoặc "" nếu chưa nhóm / nhóm đã bị xoá. */
export function groupIdOf(state, sessionId) {
  const st = normalizeGroupState(state);
  return st.assignments[String(sessionId ?? "")] ?? "";
}

/**
 * Gán / bỏ gán phiên vào nhóm — bản thuần của `PATCH
 * /session-groups/assignments/{sessionId}`.
 *
 * `groupId` rỗng = bỏ khỏi nhóm. `groupId` trỏ nhóm KHÔNG tồn tại cũng bị coi
 * như bỏ gán, và đây KHÔNG phải suy diễn: server làm đúng vậy —
 * session-groups.ts:117-136 xoá assignment khi groupId không có trong state.
 * Nếu ta giữ lại, UI sẽ hiện nhóm không tồn tại trong khi server đã quên nó.
 */
export function setAssignment(state, sessionId, groupId) {
  const st = normalizeGroupState(state);
  const sid = String(sessionId ?? "").trim();
  if (!sid) return st;
  const gid = String(groupId ?? "").trim();
  const assignments = { ...st.assignments };
  if (!gid || !st.groups.some((g) => g.id === gid)) delete assignments[sid];
  else assignments[sid] = gid;
  return { groups: st.groups, assignments };
}

/** Cắt chuỗi theo code point, không cắt đôi ký tự (emoji trong tên nhóm). */
function clipByCodePoint(value, max) {
  let end = 0;
  let count = 0;
  while (end < value.length && count < max) {
    const cp = value.codePointAt(end);
    end += cp > 0xffff ? 2 : 1;
    count += 1;
  }
  return value.slice(0, end);
}

/**
 * Chuẩn hoá tên nhóm người dùng gõ: dẹp khoảng trắng (Enter của bàn phím dính
 * vào title), nhưng KHÔNG tự cắt quá trần — trả lỗi để UI báo và giữ nguyên
 * ô nhập. Cùng hợp đồng `{ok:true,...}/{ok:false,error}` như
 * lib/session-rename.js.
 */
export function normalizeGroupLabel(raw, opts = {}) {
  const max = Number.isInteger(opts?.max) && opts.max > 0 ? opts.max : MAX_GROUP_LABEL_LENGTH;
  const text = typeof raw === "number" && Number.isFinite(raw) ? String(raw) : raw;
  if (typeof text !== "string") return { ok: false, error: GROUP_ERRORS.notText };
  const label = text.replace(/\s+/g, " ").trim();
  if (!label) return { ok: false, error: GROUP_ERRORS.empty };
  if ([...label].length > max) return { ok: false, error: GROUP_ERRORS.tooLong };
  return { ok: true, label: clipByCodePoint(label, max) };
}

/**
 * Đổi tên nhóm — bản thuần của `PATCH /session-groups/{groupId}` (label là
 * bắt buộc, tối đa 120 — session-groups.ts:138-152). Nhãn sai thì trả nguyên
 * state kèm lỗi, không sửa gì cả.
 */
export function renameGroup(state, groupId, rawLabel) {
  const st = normalizeGroupState(state);
  const gid = String(groupId ?? "").trim();
  const clean = normalizeGroupLabel(rawLabel);
  if (!clean.ok) return { ok: false, error: clean.error, state: st };
  if (!st.groups.some((g) => g.id === gid)) return { ok: false, error: GROUP_ERRORS.notText, state: st };
  return {
    ok: true,
    state: {
      groups: st.groups.map((g) => (g.id === gid ? { ...g, label: clean.label } : g)),
      assignments: st.assignments,
    },
  };
}

/**
 * Sinh id nhóm từ tên — slug tiếng Việt KHÔNG dấu để id đọc được khi debug và
 * khỏi lệ thuộc encoding. Trùng thì thêm hậu tố (như server cũng cho phép id
 * tuỳ chọn nên ta tự quyết trước khi gửi).
 */
export function makeGroupId(label, existingIds = []) {
  const taken = new Set((Array.isArray(existingIds) ? existingIds : []).map((x) => String(x ?? "")));
  const base =
    String(label ?? "")
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_GROUP_ID_LENGTH) || "group";
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base.slice(0, MAX_GROUP_ID_LENGTH - String(i).length - 1)}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/**
 * Thêm nhóm mới vào state (bản thuần của `POST /session-groups`, body
 * `{label, id?}` — session-groups.ts:73-88). Server tự sinh id khi không gửi;
 * ta luôn gửi id của mình để state client khớp ngay, không phải chờ vòng
 * refresh.
 */
export function addGroup(state, rawLabel, { id } = {}) {
  const st = normalizeGroupState(state);
  const clean = normalizeGroupLabel(rawLabel);
  if (!clean.ok) return { ok: false, error: clean.error, state: st };
  const gid = String(id ?? "").trim() || makeGroupId(clean.label, st.groups.map((g) => g.id));
  if (st.groups.some((g) => g.id === gid)) return { ok: false, error: "This group already exists.", state: st };
  return {
    ok: true,
    id: gid,
    label: clean.label,
    state: { groups: [...st.groups, { id: gid, label: clean.label }], assignments: st.assignments },
  };
}

/**
 * Xoá nhóm — bản thuần của `DELETE /session-groups/{groupId}
 * ?destinationGroupId=`. Session KHÔNG bị xoá: chuyển sang nhóm đích, hoặc
 * thành "Chưa nhóm" khi không có đích (session-groups.ts:154-180).
 *
 * `destinationGroupId` không tồn tại hoặc trùng chính nhóm đang xoá thì coi
 * như không đích — đúng hành vi server (chỉ dùng khi "là nhóm khác tồn tại").
 */
export function removeGroup(state, groupId, destinationGroupId = "") {
  const st = normalizeGroupState(state);
  const gid = String(groupId ?? "").trim();
  const dest = String(destinationGroupId ?? "").trim();
  const destOk = dest && dest !== gid && st.groups.some((g) => g.id === dest) ? dest : "";
  const groups = st.groups.filter((g) => g.id !== gid);
  const assignments = {};
  for (const [sid, current] of Object.entries(st.assignments)) {
    if (current !== gid) {
      assignments[sid] = current;
      continue;
    }
    if (destOk) assignments[sid] = destOk;
  }
  return { groups, assignments };
}

/**
 * Sắp lại thứ tự nhóm — bản thuần của `PATCH /session-groups/reorder`
 * (body `{groupIds}` — session-groups.ts:90-115).
 *
 * Hai lệch phải bám đúng server: id KHÔNG có trong danh sách được chấp nhận
 * thì giữ nguyên ở cuối (nếu ta cắt bỏ thì nhóm sẽ biến mất khỏi UI), còn id
 * LẠ thì bỏ qua. Thứ tự trong mảng `groupIds` là thứ tự hiển thị.
 */
export function reorderGroups(state, groupIds) {
  const st = normalizeGroupState(state);
  const byId = new Map(st.groups.map((g) => [g.id, g]));
  const seen = new Set();
  const groups = [];
  for (const raw of Array.isArray(groupIds) ? groupIds : []) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id || seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    groups.push(byId.get(id));
  }
  for (const g of st.groups) if (!seen.has(g.id)) groups.push(g);
  return { groups, assignments: st.assignments };
}

/** Đổi chỗ hai nhóm liền kề — tiện cho nút ↑/↓ trên điện thoại. */
export function moveGroup(state, groupId, delta) {
  const st = normalizeGroupState(state);
  const ids = st.groups.map((g) => g.id);
  const from = ids.indexOf(String(groupId ?? ""));
  const to = from + (Number(delta) || 0);
  if (from < 0 || to < 0 || to >= ids.length) return st;
  ids.splice(from, 1);
  ids.splice(to, 0, String(groupId));
  return reorderGroups(st, ids);
}

/** Số phiên của từng nhóm (dùng cho con số trên chip bộ lọc). */
export function groupCounts(sessions, state) {
  const st = normalizeGroupState(state);
  const list = Array.isArray(sessions) ? sessions : [];
  const counts = {};
  for (const g of st.groups) counts[g.id] = 0;
  for (const s of list) {
    const gid = groupIdOf(st, s?.id);
    if (gid) counts[gid] = (counts[gid] ?? 0) + 1;
  }
  return counts;
}

// ==================== DỰNG PATH + BODY (đã whitelist ở bridge) ====================
//
// Hợp đồng lấy từ source OpenWork (branch dev), KHÔNG tự chế:
//   GET    /workspace/{id}/session-groups                    -> {state, updatedAt}
//   POST   /workspace/{id}/session-groups  {label, id?}      -> {state, updatedAt}
//   PUT    /workspace/{id}/session-groups  {state}           -> {state, updatedAt}
//   PATCH  /workspace/{id}/session-groups/reorder {groupIds}
//   PATCH  /workspace/{id}/session-groups/assignments/{sid} {groupId}
//   PATCH  /workspace/{id}/session-groups/{groupId} {label}
//   DELETE /workspace/{id}/session-groups/{groupId}?destinationGroupId=
//
// Bằng chứng: apps/server/src/routes/session-groups.ts:56-60 (GET), :62-71
// (PUT), :73-88 (POST), :90-115 (reorder), :117-136 (assignments), :138-152
// (rename), :154-180 (delete); wrapper client apps/app/src/app/lib/
// openwork-server.ts:1877-1918. Bridge đã cho phép: bridge/src/proxy.js:8 có
// nhánh `session-groups` trong regex, :13-15 có GET/POST/PUT/PATCH/DELETE.

const wsBase = (wsId) => `/workspace/${encodeURIComponent(wsId)}/session-groups`;

export function sessionGroupsPath(wsId) {
  return wsBase(wsId);
}

export function sessionGroupPath(wsId, groupId) {
  return `${wsBase(wsId)}/${encodeURIComponent(String(groupId ?? ""))}`;
}

export function sessionGroupReorderPath(wsId) {
  return `${wsBase(wsId)}/reorder`;
}

export function sessionGroupAssignmentPath(wsId, sessionId) {
  return `${wsBase(wsId)}/assignments/${encodeURIComponent(String(sessionId ?? ""))}`;
}

/** Path xoá nhóm — chỉ kèm `destinationGroupId` khi thật sự có nhóm đích. */
export function removeGroupPath(wsId, groupId, destinationGroupId = "") {
  const base = sessionGroupPath(wsId, groupId);
  const dest = String(destinationGroupId ?? "").trim();
  if (!dest || dest === String(groupId ?? "").trim()) return base;
  return `${base}?destinationGroupId=${encodeURIComponent(dest)}`;
}

/** Body cho reorder — luôn là mảng string, kể cả rỗng (xoá hết nhóm). */
export function buildReorderBody(groupIds) {
  return { groupIds: (Array.isArray(groupIds) ? groupIds : []).map((x) => String(x ?? "").trim()).filter(Boolean) };
}

/** Body cho gán nhóm — `groupId` rỗng nghĩa là gỡ khỏi nhóm (xem setAssignment). */
export function buildAssignBody(groupId) {
  const gid = String(groupId ?? "").trim();
  return gid ? { groupId: gid } : { groupId: "" };
}

// ---- CHƯA LÀM / CHƯA XÁC MINH ----
//
// 1. LƯU TRỮ đang chỉ ở localStorage. Engine CÓ hỗ trợ thật và bridge đã
//    whitelist: `PATCH /workspace/{id}/opencode/session/{id}` với body
//    `{time:{archived: <epoch ms>}}` (archive) và `{time:{archived: 0}}`
//    (bỏ lưu trữ) — xem apps/app/src/app/lib/opencode-session.ts:132-146 và
//    test khoá wire của OpenWork apps/app/tests/opencode-archive-transport.test.ts:
//    51/:58. Chưa dùng vì web app hiện KHÔNG truyền `?directory=` cho bất kỳ
//    call nào của ow() (api.js:278), và api.js là file dùng chung — vòng này
//    không ai được sửa. Khi muốn đồng bộ lưu trữ qua máy tính (để desktop thấy
//    giống điện thoại), đổi `toggleFlag(flags,"archived",id)` sang một
//    `owArchiveSession(wsId, sid, archived)` trong api.js và giữ nguyên phần
//    lọc hiển thị ở đây.
// 2. Trần `MAX_GROUP_LABEL_LENGTH` lấy từ `.slice(0,120)` của server, tức là
//    server cắt ÂM THẦM. Ta chặn sớm hơn để người dùng thấy lỗi thay vì thấy
//    tên bị cắt — nhưng nếu ai đó gọi thẳng API mà bypass hàm này thì vẫn còn
//    lớp cắt phía server.
// 3. Chưa dùng `GET /session-groups/events?since=` (session-groups.ts:182-188).
//    sessions.jsx đang lấy state bằng GET sau mỗi thay đổi cục bộ; nếu muốn
//    nhóm đồng bộ giữa nhiều thiết bị thì đây là đường để poll dài hạn.
