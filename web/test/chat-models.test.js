// Khoá lib/chat-models.flattenProviderModels (round 4, 09/10 — tách khỏi
// mega-effect của chat.jsx): catalog engine → danh sách chọn cho ModelPicker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenProviderModels } from "../src/lib/chat-models.js";

const PROVIDERS = {
  providers: [
    {
      id: "anthropic",
      name: "Anthropic",
      models: {
        "claude-sonnet": { id: "claude-sonnet", name: "Claude Sonnet", variants: ["high", "low"] },
        "claude-haiku": { id: "claude-haiku" }, // không có name — dùng id làm label
      },
    },
    { id: "openai", name: "OpenAI", models: { gpt: { id: "gpt", name: "GPT" } } },
  ],
};

test("dẹt hoá: mỗi model một mục, value ghép provider/model", () => {
  const flat = flattenProviderModels(PROVIDERS);
  assert.equal(flat.length, 3);
  assert.deepEqual(flat[0], {
    value: "anthropic/claude-sonnet",
    label: "Anthropic · Claude Sonnet",
    providerName: "Anthropic",
    modelName: "Claude Sonnet",
    modelId: "claude-sonnet",
    variants: ["high", "low"],
  });
});

test("model thiếu name dùng id; provider thiếu name dùng id", () => {
  const flat = flattenProviderModels(PROVIDERS);
  const haiku = flat.find((m) => m.modelId === "claude-haiku");
  assert.equal(haiku.label, "Anthropic · claude-haiku");
  assert.equal(haiku.modelName, "claude-haiku");
});

test("chấp nhận cả hai dạng bọc engine: {providers} lẫn {data:{providers}}", () => {
  assert.equal(flattenProviderModels(PROVIDERS).length, 3);
  assert.equal(flattenProviderModels({ data: PROVIDERS }).length, 3);
});

test("payload rác/rỗng → mảng rỗng, không ném", () => {
  assert.deepEqual(flattenProviderModels(null), []);
  assert.deepEqual(flattenProviderModels({}), []);
  assert.deepEqual(flattenProviderModels({ providers: [] }), []);
});
