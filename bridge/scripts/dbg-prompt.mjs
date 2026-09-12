// E2E prompt có model, KHÔNG xóa session, dump đầy đủ parts để debug.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const config = JSON.parse(readFileSync(join(process.env.APPDATA, "openwork-bridge", "config.json"), "utf8"));
const H = { Authorization: `Bearer ${config.mobileToken}`, "content-type": "application/json" };
const wsId = process.argv[2] ?? "ws_3d8246222830";
const providerID = process.argv[3] ?? "opencode";
const modelID = process.argv[4] ?? "nemotron-3-ultra-free";
const B = `http://127.0.0.1:8788/api/ow/workspace/${wsId}/opencode`;
const unwrap = (p) => (p && typeof p === "object" && "data" in p ? p.data : p);

const created = unwrap(await fetch(`${B}/session`, { method: "POST", headers: H, body: JSON.stringify({ title: "mobile-bridge-test" }) }).then((r) => r.json()));
console.log("session:", created.id);
const pr = await fetch(`${B}/session/${created.id}/prompt_async`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ parts: [{ type: "text", text: "Test tự động từ mobile bridge. Chỉ trả lời đúng một từ: OK" }], model: { providerID, modelID } }),
});
console.log("prompt_async:", pr.status, pr.status !== 204 ? await pr.text().then((t) => t.slice(0, 200)) : "");

for (let i = 0; i < 15; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const list = unwrap(await fetch(`${B}/session/${created.id}/message`, { headers: H }).then((r) => r.json())) ?? [];
  const line = list.map((m) => {
    const parts = (m.parts ?? []).map((p) => (p.type === "text" ? `text:${(p.text ?? "").slice(0, 60)}` : p.type + (p.state?.status ? `:${p.state.status}` : ""))).join(",");
    return `${m.info?.role ?? "?"}[${parts}]`;
  });
  console.log(`t+${(i + 1) * 5}s: ${line.join(" | ")}`);
  const done = list.some((m) => (m.info?.role ?? m.role) === "assistant" && (m.parts ?? []).some((p) => p.type === "text" && (p.text ?? "").trim()));
  if (done) {
    console.log("=> CÓ REPLY. Session giữ lại để xem trong app:", created.id);
    process.exit(0);
  }
}
console.log("=> hết 75s chưa có reply. Session:", created.id);
