// Test logic thuần mức suy luận + chế độ nhanh (lib/model-behavior.js).
// Shape `variants` lấy đúng những gì engine trả: server chỉ giữ variants ở
// dạng {id} (apps/server/src/server.ts:1462-1479).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EFFORT_NONE,
  buildPromptModelFields,
  effortLabel,
  effortOptionsFor,
  fastModeEffort,
  normalizeEffort,
  parseModelValue,
  pickVariantId,
  isModelUsable,
  resolveKnownModel,
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

test("effortLabel gives an English label for standard levels, keeps unknown ids as-is", () => {
  assert.equal(effortLabel("high"), "High");
  assert.equal(effortLabel(EFFORT_NONE), "Default");
  assert.equal(effortLabel("extreme"), "extreme");
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

test("level Default -> only model (engine decides)", () => {
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

test("Codex at Default -> no reasoning effort field at all", () => {
  const out = buildPromptModelFields({ modelValue: "openai/gpt-5-codex", effort: EFFORT_NONE });
  assert.deepEqual(out, { model: { providerID: "openai", modelID: "gpt-5-codex" } });
});

test("model rỗng -> payload rỗng (không dựng model ma)", () => {
  assert.deepEqual(buildPromptModelFields({ modelValue: "", effort: "high" }), {});
  assert.deepEqual(buildPromptModelFields(), {});
  assert.deepEqual(buildPromptModelFields({}), {});
});

// ---- Danh sách mức bấm được ----

test("effortOptionsFor derives real variants, Default always first", () => {
  const opts = effortOptionsFor(gemini(), [{ id: "high" }, { id: "low" }, { id: "medium" }]);
  assert.deepEqual(opts.map((o) => o.id), ["none", "low", "medium", "high"]);
  assert.equal(opts[0].label, "Default");
});

test("effortOptionsFor giữ nguyên id lạ và không thêm mức không có", () => {
  const opts = effortOptionsFor(gemini(), [{ id: "extreme" }, { id: "low" }]);
  assert.deepEqual(opts.map((o) => o.id), ["none", "low", "extreme"]);
  assert.equal(opts[2].label, "extreme");
});

test("effortOptionsFor model without variants -> only Default left", () => {
  assert.deepEqual(effortOptionsFor(gemini(), []).map((o) => o.id), ["none"]);
});

test("effortOptionsFor Codex -> bộ effort chuẩn của OpenAI", () => {
  const opts = effortOptionsFor(codex(), []);
  assert.deepEqual(opts.map((o) => o.id), ["none", "minimal", "low", "medium", "high"]);
  assert.ok(opts.slice(1).every((o) => o.codexOnly === true));
});

// ---- Chế độ nhanh ----

test("chế độ nhanh lấy variant thấp nhất của model", () => {
  assert.equal(fastModeEffort(gemini(), [{ id: "high" }, { id: "minimal" }, { id: "medium" }]), "minimal");
  assert.equal(fastModeEffort(gemini(), [{ id: "high" }, { id: "low" }]), "low");
  assert.equal(fastModeEffort(codex(), []), "low"); // Codex không có variants
});

test("fast mode on model without variants -> Default", () => {
  assert.equal(fastModeEffort(gemini(), []), EFFORT_NONE);
  assert.equal(fastModeEffort(gemini(), undefined), EFFORT_NONE);
});

// ---- Đổi model thì mức cũ không còn hợp lệ ----

test("resolveEffort falls back to Default when new model lacks the chosen variant", () => {
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
// ---- Model nhớ trong localStorage có còn trong catalog engine không ----
// BUG THẬT 04/10: máy nhớ "openrouter/stealth" nhưng engine đã đổi tên model
// thành "openrouter/stealth/space-bunny-alpha". Gửi model cũ → engine vẫn nhận
// message, lưu vào transcript, rồi không chạy gì: tin nhắn treo im lặng.

test("id model có dấu '/' bên trong không bị cắt mất đuôi", () => {
  assert.deepEqual(parseModelValue("openrouter/stealth/space-bunny-alpha"), {
    providerID: "openrouter",
    modelID: "stealth/space-bunny-alpha",
  });
  assert.deepEqual(parseModelValue("9router/ag/claude-sonnet-4-6"), {
    providerID: "9router",
    modelID: "ag/claude-sonnet-4-6",
  });
  // provider/model vẫn như cũ
  assert.deepEqual(parseModelValue("google/gemini-3-pro"), {
    providerID: "google",
    modelID: "gemini-3-pro",
  });
});

test("payload giữ trọn id model nhiều dấu phẩy-tách", () => {
  assert.deepEqual(buildPromptModelFields({ modelValue: "openrouter/stealth/space-bunny-alpha" }), {
    model: { providerID: "openrouter", modelID: "stealth/space-bunny-alpha" },
  });
});

const catalog = [
  { value: "openrouter/stealth/space-bunny-alpha" },
  { value: "9router/ag/claude-sonnet-4-6" },
];

test("model nhớ còn trong danh sách thì giữ nguyên", () => {
  assert.equal(resolveKnownModel("openrouter/stealth/space-bunny-alpha", catalog), "openrouter/stealth/space-bunny-alpha");
  assert.equal(isModelUsable("openrouter/stealth/space-bunny-alpha", catalog), true);
});

test("model nhớ đã bị engine đổi tên thì chọn lại, và chặn gửi", () => {
  // Đây đúng là thứ đã làm tin nhắn treo im lặng.
  assert.equal(resolveKnownModel("openrouter/stealth", catalog), "openrouter/stealth/space-bunny-alpha");
  assert.equal(isModelUsable("openrouter/stealth", catalog), false);
  // Rỗng = chưa chọn model: engine cần model tường minh, cũng phải chặn.
  assert.equal(isModelUsable("", catalog), false);
});

test("catalog rỗng (chưa tải xong / mạng hỏng) thì KHÔNG xoá lựa chọn", () => {
  assert.equal(resolveKnownModel("openrouter/stealth", []), "openrouter/stealth");
  assert.equal(isModelUsable("openrouter/stealth", []), true, "chặn nhầm lúc app vừa mở là hỏng");
  assert.equal(resolveKnownModel("openrouter/stealth", undefined), "openrouter/stealth");
});
