// Khoá lib/chat-outbox (round 4, 09/10 — tách khỏi send() của chat.jsx):
// luật ghép khối file + chữ, và hình dạng message optimistic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeOutgoing, optimisticMessage } from "../src/lib/chat-outbox.js";

test("chỉ chữ: fullText = optimisticText = chữ gõ, không thừa dòng", () => {
  const out = composeOutgoing({ text: "hello", uploaded: [] });
  assert.equal(out.fullText, "hello");
  assert.equal(out.optimisticText, "hello");
});

test("file + chữ: khối file đứng trước, chữ nối sau bằng đúng một xuống dòng", () => {
  const out = composeOutgoing({ text: "xem giùm", uploaded: ["a.png", "b.pdf"] });
  assert.equal(
    out.fullText,
    "Files attached from the phone (saved in the workspace):\n- a.png\n- b.pdf\n\nxem giùm"
  );
  assert.equal(out.optimisticText, out.fullText, "có chữ gõ thì hiển thị nguyên văn");
});

test("chỉ file không chữ: nhét lời dặn đọc file, optimistic hiện 'Sent N files'", () => {
  const out = composeOutgoing({ text: "", uploaded: ["a.png"] });
  assert.equal(
    out.fullText,
    "Files attached from the phone (saved in the workspace):\n- a.png\n\nPlease read the attached files above and process them."
  );
  assert.equal(out.optimisticText, "Sent 1 attached files.");
});

test("optimisticMessage: id local, role user, localSentText = chữ THẬT sẽ gửi", () => {
  const { localId, message } = optimisticMessage("full", "preview", 1234567);
  assert.ok(localId.startsWith("local-1234567-"), localId);
  assert.equal(message.info.id, localId);
  assert.equal(message.info.role, "user");
  assert.equal(message.info.time.created, 1234567);
  assert.equal(message.info.localSentText, "full");
  assert.deepEqual(message.parts, [{ type: "text", text: "preview" }]);
});
