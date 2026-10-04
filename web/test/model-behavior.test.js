// Test logic thuần mức suy luận + chế độ nhanh (lib/model-behavior.js).
// Shape `variants` lấy đúng những gì engine trả: server chỉ giữ variants ở
// dạng {id} (apps/server/src/server.ts:1462-1479).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EFFORT_NONE,
  buildPromptModelFields,
  effortLabelVi,
  effortOptionsFor,
  fastModeEffort,
  normalizeEffort,
  parseModelValue,
  pickVariantId,
  resolveEffort,
  usesReasoningEffortField,
  variantIdsOf,
} from "../src/lib/model-behavior.js";

const gemini = (id = "gemini-3-pro") => ({ providerID: "google", modelID: id });
const codex = (id = "gpt-5-codex") => ({ providerID: "openai", modelID: id });

// ---- Chuỗi model và danh sách variant ----

test("parseModelValue bóc providerID/modelID từ chuỗi ModelPicker", () => {
  assert.deepEqual(parseModelValue("google/gemini-3-pro"), { providerID: "google", modelID: "gemini-3-pro" });
  assert.deepEqual(parseModelValue("openai/gpt-5-codex"), { providerID: "openai", modelID: "gpt-5-codex" });
});

test("parseModelValue trả null cho chuỗi hỏng (engine cần model tường minh)", () => {
  assert.equal(parseModelValue(""), null);
  assert.equal(parseModelValue("gemini-3-pro"), null); // thiếu dấu "/"
  assert.equal(parseModelValue("/gemini"), null);
  assert.equal(parseModelValue("google/"), null);
  assert.equal(parseModelValue(undefined), null);
});

test("variantIdsOf đọc được cả mảng chuỗi, mảng {id} và map", () => {
  assert.deepEqual(variantIdsOf(["low", "high"]), ["low", "high"]);
  assert.deepEqual(variantIdsOf([{ id: "low" }, { id: "high" }]), ["low", "high"]);
  assert.deepEqual(variantIdsOf({ low: {}, high: {} }), ["low", "high"]);
  assert.deepEqual(variantIdsOf(null), []);
  // trùng id thì giữ một lần
  assert.deepEqual(variantIdsOf([{ id: "low" }, "low"]), ["low"]);
});

// ---- Mức chuẩn hoá ----

test("normalizeEffort gộp mọi cách viết về id chuẩn", () => {
  assert.equal(normalizeEffort(""), EFFORT_NONE);
  assert.equal(normalizeEffort("Auto"), EFFORT_NONE);
  assert.equal(normalizeEffort("default"), EFFORT_NONE);
  assert.equal(normalizeEffort("MAX"), "high");
  assert.equal(normalizeEffort(" high "), "high");
  assert.equal(normalizeEffort("tùy"), "tùy"); // id lạ giữ nguyên, không ép
});

test("effortLabelVi có tiếng Việt cho mức chuẩn, giữ nguyên id lạ", () => {
  assert.equal(effortLabelVi("high"), "Cao");
  assert.equal(effortLabelVi(EFFORT_NONE), "Mặc định");
  assert.equal(effortLabelVi("extreme"), "extreme");
});

// ---- Variant: chỉ chọn được thứ engine thật sự khai ----

test("pickVariantId chỉ trả về variant có thật trong catalog", () => {
  const vs = [{ id: "low" }, { id: "high" }];
  assert.equal(pickVariantId(vs, "high"), "high");
  assert.equal(pickVariantId(vs, "HIGH"), "high");
  // "medium" không có trong catalog -> để engine tự chọn, KHÔNG gửi variant ma
  assert.equal(pickVariantId(vs, "medium"), undefined);
  assert.equal(pickVariantId(vs, EFFORT_NONE), undefined);
  assert.equal(pickVariantId([], "high"), undefined);
});

test("pickVariantId hiểu variant có tiền tố/suffix hãng", () => {
  assert.equal(pickVariantId([{ id: "think-high" }], "high"), "think-high");
  assert.equal(pickVariantId(["thinking_low"], "low"), "thinking_low");
});

// ---- Payload prompt_async ----

test("model không hỗ trợ variant: gửi model + variant khi chọn mức", () => {
  const out = buildPromptModelFields({
    modelValue: "google/gemini-3-pro",
    effort: "high",
    variants: [{ id: "low" }, { id: "high" }],
  });
  assert.deepEqual(out, { model: { providerID: "google", modelID: "gemini-3-pro" }, variant: "high" });
});

test("model không có variant nào: chỉ gửi model, không gửi field lạ", () => {
  const out = buildPromptModelFields({ modelValue: "google/gemini-3-flash", effort: "high" });
  assert.deepEqual(out, { model: { providerID: "google", modelID: "gemini-3-flash" } });
  assert.equal("variant" in out, false);
  assert.equal("reasoning_effort" in out, false);
});

test("mức Mặc định -> chỉ có model (engine tự chọn)", () => {
  const out = buildPromptModelFields({
    modelValue: "google/gemini-3-pro",
    effort: EFFORT_NONE,
    variants: [{ id: "low" }, { id: "high" }],
  });
  assert.deepEqual(out, { model: { providerID: "google", modelID: "gemini-3-pro" } });
});

test("Codex: reasoning_effort THAY variant, không bao giờ gửi cả hai", () => {
  const out = buildPromptModelFields({ modelValue: "openai/gpt-5-codex", effort: "medium" });
  assert.deepEqual(out, { model: { providerID: "openai", modelID: "gpt-5-codex" }, reasoning_effort: "medium" });
  assert.equal("variant" in out, false);
});

test("Codex mức Mặc định -> không field mức suy luận nào", () => {
  const out = buildPromptModelFields({ modelValue: "openai/gpt-5-codex", effort: EFFORT_NONE });
  assert.deepEqual(out, { model: { providerID: "openai", modelID: "gpt-5-codex" } });
});

test("model rỗng -> payload rỗng (không dựng model ma)", () => {
  assert.deepEqual(buildPromptModelFields({ modelValue: "", effort: "high" }), {});
  assert.deepEqual(buildPromptModelFields(), {});
  assert.deepEqual(buildPromptModelFields({}), {});
});

// ---- Danh sách mức bấm được ----

test("effortOptionsFor suy ra từ variant thật, Mặc định luôn ở đầu", () => {
  const opts = effortOptionsFor(gemini(), [{ id: "high" }, { id: "low" }, { id: "medium" }]);
  assert.deepEqual(opts.map((o) => o.id), ["none", "low", "medium", "high"]);
  assert.equal(opts[0].vi, "Mặc định");
});

test("effortOptionsFor giữ nguyên id lạ và không thêm mức không có", () => {
  const opts = effortOptionsFor(gemini(), [{ id: "extreme" }, { id: "low" }]);
  assert.deepEqual(opts.map((o) => o.id), ["none", "low", "extreme"]);
  assert.equal(opts[2].vi, "extreme");
});

test("effortOptionsFor model không có variant -> chỉ còn Mặc định", () => {
  assert.deepEqual(effortOptionsFor(gemini(), []).map((o) => o.id), ["none"]);
});

test("effortOptionsFor Codex -> bộ effort chuẩn của OpenAI", () => {
  const opts = effortOptionsFor(codex(), []);
  assert.deepEqual(opts.map((o) => o.id), ["none", "minimal", "low", "medium", "high"]);
  assert.ok(opts.slice(1).every((o) => o.viCodex === true));
});

// ---- Chế độ nhanh ----

test("chế độ nhanh lấy variant thấp nhất của model", () => {
  assert.equal(fastModeEffort(gemini(), [{ id: "high" }, { id: "minimal" }, { id: "medium" }]), "minimal");
  assert.equal(fastModeEffort(gemini(), [{ id: "high" }, { id: "low" }]), "low");
  assert.equal(fastModeEffort(codex(), []), "low"); // Codex không có variants
});

test("chế độ nhanh trên model không có variant -> Mặc định", () => {
  assert.equal(fastModeEffort(gemini(), []), EFFORT_NONE);
  assert.equal(fastModeEffort(gemini(), undefined), EFFORT_NONE);
});

// ---- Đổi model thì mức cũ không còn hợp lệ ----

test("resolveEffort về Mặc định khi model mới không có variant đã chọn", () => {
  assert.equal(resolveEffort("high", gemini(), [{ id: "low" }]), EFFORT_NONE);
  assert.equal(resolveEffort("high", gemini(), [{ id: "low" }, { id: "high" }]), "high");
  // đổi từ model có variant sang Codex thì mức cũ vẫn dùng được (reasoning_effort)
  assert.equal(resolveEffort("high", codex(), []), "high");
});

test("usesReasoningEffortField chỉ nhận Codex của openai", () => {
  assert.equal(usesReasoningEffortField(codex()), true);
  assert.equal(usesReasoningEffortField(gemini()), false);
  assert.equal(usesReasoningEffortField({ providerID: "openai", modelID: "gpt-4o" }), false);
  assert.equal(usesReasoningEffortField(null), false);
});

// ---- Chuỗi đầy đủ: chọn nhanh trên model có variant rồi dựng payload ----

test("luồng đầy đủ: bật nhanh -> payload có variant thấp nhất", () => {
  const model = gemini();
  const variants = [{ id: "high" }, { id: "low" }];
  const effort = fastModeEffort(model, variants);
  assert.equal(effort, "low");
  assert.deepEqual(buildPromptModelFields({ modelValue: "google/gemini-3-pro", effort, variants }), {
    model: { providerID: "google", modelID: "gemini-3-pro" },
    variant: "low",
  });
});