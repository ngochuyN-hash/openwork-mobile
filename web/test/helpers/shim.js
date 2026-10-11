// Shim dùng chung cho các test client (web/test/*.test.js).
//
// Vì sao tồn tại: TÁM file test từng chép nguyên khối này — cặp env dir +
// storage + location/history/window — mỗi lần thêm một global trình duyệt là
// tám chỗ sửa và tám dịp lệch nhau. api.js chạm localStorage lúc import
// (lib/identity-store), nên shim phải đứng TRƯỚC mọi `await import("../src/api.js")`.
//
// House rule: tests never touch a real bridge / openwork data directory —
// mkdtempSync cho CẢ OPENWORK_BRIDGE_DIR lẫn OPENWORK_DIR, mỗi file một cặp
// tmp riêng (isolation giữa các file test).
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

export function createStorageShim() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

/** Gọi ở ĐỈNH file test, trước mọi `await import("../src/...")`. */
export function installBrowserShim() {
  process.env.OPENWORK_BRIDGE_DIR = mkdtempSync(`${tmpdir()}/owm-test-bridge-`);
  process.env.OPENWORK_DIR = mkdtempSync(`${tmpdir()}/owm-test-data-`);
  globalThis.localStorage = createStorageShim();
  globalThis.location = { hash: "", pathname: "/", search: "" };
  globalThis.history = { replaceState() {} };
  globalThis.window = globalThis;
}
