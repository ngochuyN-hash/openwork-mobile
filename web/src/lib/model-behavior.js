// Logic thuần cho MỨC SUY LUẬN + CHẾ ĐỘ NHANH — tách khỏi chat.jsx để test
// được, đúng kiểu dự án đang làm với lib/session-ops.js và lib/chat-stream.js.
//
// Nguồn (OpenWork desktop, branch dev) — hai quy tắc dễ sai đã đối chiếu:
//  1. `variant` là đường chính thức của engine. Server khoá đúng body
//     {model, variant, parts} — apps/server/src/opencode-plugins/
//     openwork-extensions-preview.test.ts:1310-1313, hàm dựng payload ở
//     openwork-extensions-preview.ts:1171-1173.
//  2. `reasoning_effort` CHỈ dành cho model Codex và NÓ THAY `variant`:
//     actions-store.ts:547-549 — có reasoningEffort thì requestVariant =
//     undefined, promptOverrides = { reasoning_effort }. Gửi cả hai là sai.
//
// Vì vậy hàm ở đây không tự chế chuỗi mức suy luận: `variant` chỉ lấy từ
// danh sách `variants` mà engine trả về cho model đó (server giữ đúng field
// này, apps/server/src/server.ts:1462-1479). Model không có variant nào thì
// không gửi gì — để engine/model tự chọn, đó là "mặc định hợp lý".

/** Ô "mặc định": KHÔNG gửi field mức suy luận nào lên. */
export const EFFORT_NONE = "none";

/**
 * Thứ tự mức suy luận tăng dần. `id` là chuỗi engine hiểu; `vi` là chữ hiện
 * trên nút. "none" đứng đầu và luôn tồn tại trong mọi danh sách.
 */
export const EFFORT_LEVELS = [
  { id: EFFORT_NONE, vi: "Mặc định" },
  { id: "minimal", vi: "Tối thiểu" },
  { id: "low", vi: "Thấp" },
  { id: "medium", vi: "Vừa" },
  { id: "high", vi: "Cao" },
];

const EFFORT_ALIASES = {
  "": EFFORT_NONE,
  auto: EFFORT_NONE,
  default: EFFORT_NONE,
  none: EFFORT_NONE,
  off: EFFORT_NONE,
  min: "minimal",
  lo: "low",
  mid: "medium",
  med: "medium",
  normal: "medium",
  hi: "high",
  max: "high",
  maximum: "high",
};

function clean(value) {
  return String(value ?? "").trim().toLowerCase();
}

/** Chuẩn hoá mức người dùng chọn/nhớ trong localStorage về 1 id chuẩn. */
export function normalizeEffort(value) {
  const key = clean(value);
  if (key in EFFORT_ALIASES) return EFFORT_ALIASES[key];
  return key || EFFORT_NONE;
}

export function effortLabelVi(effort) {
  const id = normalizeEffort(effort);
  return EFFORT_LEVELS.find((l) => l.id === id)?.vi ?? String(effort ?? "");
}

/** Thứ tự tăng dần; id lạ (vd "extreme") nằm ngoài bảng thì đẩy xuống cuối. */
function effortRank(id) {
  const idx = EFFORT_LEVELS.findIndex((l) => l.id === normalizeEffort(id));
  return idx < 0 ? EFFORT_LEVELS.length : idx;
}

/**
 * Model có dùng `reasoning_effort` thay cho `variant` không?
 *
 * CẢNH BÁO: nguồn chỉ nói "chỉ dùng cho model Codex" (mô tả trong
 * actions-store.ts:547-549) chứ không có bảng provider nào để tra, nên cách
 * nhận ở đây là đoán theo tên provider+model. Nếu mai rà engine thấy provider
 * khác cũng nhận reasoning_effort thì sửa riêng hàm này, phần còn lại giữ nguyên.
 */
export function usesReasoningEffortField(model) {
  const provider = clean(model?.providerID).toLowerCase();
  const name = clean(model?.modelID);
  return provider === "openai" && name.includes("codex");
}

/** "provider/model" (giá trị ModelPicker đang dùng) -> {providerID, modelID}. */
export function parseModelValue(value) {
  const raw = String(value ?? "").trim();
  if (!raw.includes("/")) return null;
  const idx = raw.indexOf("/");
  const providerID = raw.slice(0, idx).trim();
  const modelID = raw.slice(idx + 1).trim();
  if (!providerID || !modelID) return null;
  return { providerID, modelID };
}

/**
 * Model đang nhớ có còn trong catalog engine vừa trả không.
 *
 * Engine đổi danh sách model là chuyện bình thường (đổi tên, bỏ provider),
 * còn `localStorage` thì nhớ mãi. Gửi model engine không có thì engine VẪN
 * nhận message, lưu vào transcript, rồi không chạy gì cả — người dùng chỉ
 * thấy tin đã gửi mà không ai trả lời. Nên model nhớ mà không còn trong danh
 * sách thì coi như không có, và chọn lại từ danh sách.
 *
 * Catalog rỗng (engine chưa kịp trả lời / lỗi mạng) thì GIỮ NGUYÊN giá trị
 * đang nhớ: bỏ ở đây sẽ xoá sạch lựa chọn của người dùng chỉ vì một lượt
 * fetch hỏng.
 */
export function resolveKnownModel(storedValue, models) {
  const list = Array.isArray(models) ? models : [];
  const stored = String(storedValue ?? "").trim();
  if (!list.length) return stored;
  if (list.some((m) => m?.value === stored)) return stored;
  return list[0]?.value ?? "";
}

/**
 * Model đang chọn có dùng được không (catalog đã tải xong).
 *
 * Catalog RỖNG = chưa tải xong hoặc fetch hỏng, không phải model sai → trả
 * true để không chặn nhầm lúc app vừa mở.
 */
export function isModelUsable(value, models) {
  const list = Array.isArray(models) ? models : [];
  if (!list.length) return true;
  return resolveKnownModel(value, list) === String(value ?? "").trim();
}

/**
 * Bóc danh sách id variant từ nhiều shape: mảng chuỗi, mảng object {id}
 * (server trả đúng shape này) hoặc map {id: {...}}.
 */
export function variantIdsOf(variants) {
  const out = [];
  const add = (v) => {
    const id = typeof v === "string" ? v : clean(v?.id ?? v?.name);
    if (id && !out.includes(id)) out.push(id);
  };
  if (Array.isArray(variants)) {
    variants.forEach(add);
  } else if (variants && typeof variants === "object") {
    Object.keys(variants).forEach(add);
  }
  return out;
}

/**
 * Id variant ứng với mức đã chọn, hoặc undefined (= để engine tự chọn).
 * Chỉ trả về id CÓ THẬT trong danh sách — không bịa chuỗi engine chưa từng thấy.
 */
export function pickVariantId(variants, effort) {
  const ids = variantIdsOf(variants);
  if (!ids.length) return undefined;
  const want = normalizeEffort(effort);
  if (want === EFFORT_NONE) return undefined;
  const exact = ids.find((id) => id.toLowerCase() === want);
  if (exact) return exact;
  // Variant hay có tiền tố/suffix hãng ("think-high"): so từng từ trong id.
  return ids.find((id) => id.toLowerCase().split(/[^a-z0-9]+/).includes(want));
}

/**
 * Danh sách mức người dùng bấm được, suy ra từ model ĐANG chọn:
 * - "Mặc định" luôn có ở đầu.
 * - Còn lại là variant engine thực sự khai báo, xếp tăng dần. Id lạ giữ nguyên
 *   chữ (hiện bằng chính id) chứ không ép về tên quen thuộc.
 * - Model Codex không có `variants` trong catalog: hiện bộ effort chuẩn của
 *   OpenAI, vì nhánh đó đi qua `reasoning_effort` chứ không qua `variant`.
 */
export function effortOptionsFor(model, variants) {
  const options = [{ id: EFFORT_NONE, vi: EFFORT_LEVELS[0].vi, viCodex: false }];
  if (usesReasoningEffortField(model)) {
    for (const level of EFFORT_LEVELS.slice(1)) {
      options.push({ id: level.id, vi: level.vi, viCodex: true });
    }
    return options;
  }
  const ids = variantIdsOf(variants)
    .filter((id) => id.toLowerCase() !== EFFORT_NONE)
    .sort((a, b) => effortRank(a) - effortRank(b) || a.localeCompare(b));
  for (const id of ids) {
    options.push({ id, vi: effortLabelVi(id), viCodex: false });
  }
  return options;
}

/**
 * Payload model cho `POST /session/:id/prompt_async`.
 *
 * Luôn trả `model` khi chuỗi model hợp lệ; thêm `variant` HOẶC `reasoning_effort`
 * (không bao giờ cả hai). Mức "none" → không field nào, engine tự quyết.
 */
export function buildPromptModelFields({ modelValue, effort = EFFORT_NONE, variants } = {}) {
  const model = parseModelValue(modelValue);
  if (!model) return {};
  if (usesReasoningEffortField(model)) {
    const want = normalizeEffort(effort);
    return { model, ...(want === EFFORT_NONE ? {} : { reasoning_effort: want }) };
  }
  const variant = pickVariantId(variants, effort);
  return { model, ...(variant ? { variant } : {}) };
}

/**
 * CHẾ ĐỘ NHANH: mức nhẹ nhất mà model thực sự có.
 *
 * Codex không khai `variants` nên lấy mức nhẹ chuẩn của OpenAI ("low"); model
 * khác thì lấy variant thấp nhất trong catalog. Không có gì thì EFFORT_NONE —
 * nhanh nhất mà không cần đoán.
 */
export function fastModeEffort(model, variants) {
  if (usesReasoningEffortField(model)) return "low";
  const ids = variantIdsOf(variants)
    .filter((id) => id.toLowerCase() !== EFFORT_NONE)
    .sort((a, b) => effortRank(a) - effortRank(b) || a.localeCompare(b));
  return ids.length ? normalizeEffort(ids[0]) : EFFORT_NONE;
}

/**
 * Mức đang chọn, đã sửa cho khớp model: người dùng đổi sang model không có
 * variant đó thì về "Mặc định" thay vì gửi variant ma.
 */
export function resolveEffort(effort, model, variants) {
  const want = normalizeEffort(effort);
  if (want === EFFORT_NONE) return EFFORT_NONE;
  if (usesReasoningEffortField(model)) return want;
  return pickVariantId(variants, want) ? want : EFFORT_NONE;
}