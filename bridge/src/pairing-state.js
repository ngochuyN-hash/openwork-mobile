// pairing-state.json — ảnh chụp mã ghép ĐANG SỐNG, bridge ghi MỖI lần sinh mã
// mới (pairing.onCode). `openpocket code` đọc nó khi API bridge không trả lời
// được (bridge chết / chưa lên) — thay cho việc PARSE LỜI LOG: nguồn số 2 cũ
// sống nhờ so chuỗi "Mã ghép:" trong bridge.log, bridge đổi một câu chữ là
// chết im lặng. Khuôn như tunnel-state: một seam save/load, consumers không
// tự JSON.parse. Mã one-time sống 30 phút / dùng 1 lần — cùng mức nhạy cảm
// với bridge.log (nơi bản cũ từng đọc nó), không cần ACL riêng.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bridgeDataDir } from "./config.js";

const FILE_NAME = "pairing-state.json";

function stateFile() {
  return join(bridgeDataDir(), FILE_NAME);
}

/**
 * Ghi ảnh chụp mã đang sống. `baseUrl` là snapshot TẠI THỜI ĐIỂM SINH MÃ —
 * tunnel đổi sau đó thì URL cũ stale, nhưng CLI ưu tiên worker cố định
 * (config.lookupUrl) nên snapshot chỉ là đường cùng.
 */
export function savePairingState({ code, expiresAt, baseUrl }) {
  try {
    const dir = bridgeDataDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(
      stateFile(),
      JSON.stringify({ code: String(code ?? ""), expiresAt: Number(expiresAt) || 0, baseUrl: String(baseUrl ?? ""), updatedAt: Date.now() }, null, 2) + "\n",
      "utf8"
    );
  } catch {}
}

/** Đọc ảnh chụp; trả null khi thiếu/hỏng/không có mã — caller tự kiểm hạn. */
export function loadPairingState() {
  try {
    const s = JSON.parse(readFileSync(stateFile(), "utf8"));
    return s && typeof s === "object" && s.code ? s : null;
  } catch {
    return null;
  }
}
