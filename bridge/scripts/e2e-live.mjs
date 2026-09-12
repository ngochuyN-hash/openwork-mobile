// E2E smoke test: chạy qua bridge y như web app sẽ gọi.
// Dùng: node bridge/test/e2e-live.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";

const configDir = join(process.env.APPDATA, "openwork-bridge");
const config = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
const H = { Authorization: `Bearer ${config.mobileToken}`, "content-type": "application/json" };
const BRIDGE = "http://127.0.0.1:8788";

const wsId = process.argv[2] ?? "ws_3d8246222830";
const providerId = process.argv[3] ?? ""; // vd: opencode
const modelId = process.argv[4] ?? ""; // vd: nemotron-3-ultra-free
const B = `${BRIDGE}/api/ow/workspace/${wsId}/opencode`;
const model = providerId && modelId ? { providerID: providerId, modelID: modelId } : undefined;

const j = (res) => res.json();
const unwrap = (payload) => (payload && typeof payload === "object" && "data" in payload ? payload.data : payload);

// 1. Tạo session test
const created = unwrap(await fetch(`${B}/session`, { method: "POST", headers: H, body: JSON.stringify({ title: "bridge-e2e-test" }) }).then(j));
const sid = created?.id;
if (!sid) throw new Error("Không tạo được session: " + JSON.stringify(created).slice(0, 200));
console.log("1. session mới:", sid);

// 2. Gửi prompt async
const pr = await fetch(`${B}/session/${sid}/prompt_async`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({
    parts: [{ type: "text", text: "Đây là tin nhắn test tự động từ mobile bridge. Chỉ trả lời đúng một từ: OK" }],
    ...(model ? { model } : {}),
  }),
});
console.log("2. prompt_async status:", pr.status, pr.status === 204 ? "(chuẩn - async)" : await pr.text().then((t) => t.slice(0, 150)));

// 3. Poll reply
let replied = false;
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const list = unwrap(await fetch(`${B}/session/${sid}/message`, { headers: H }).then(j)) ?? [];
  const text = list
    .filter((m) => (m.info?.role ?? m.role) === "assistant")
    .flatMap((m) => m.parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join(" ")
    .trim();
  if (text) {
    console.log(`3. assistant trả lời sau ${(i + 1) * 3}s:`, JSON.stringify(text.slice(0, 140)));
    replied = true;
    break;
  }
}
if (!replied) console.log("3. CHƯA có reply sau 36s (model chậm hoặc lỗi - kiểm tra thủ công)");

// 4. Dọn session test
const del = await fetch(`${B}/session/${sid}`, { method: "DELETE", headers: H });
console.log("4. delete session:", del.status);

console.log(replied ? "E2E: PASS" : "E2E: PARTIAL (gửi được, reply chưa thấy)");
