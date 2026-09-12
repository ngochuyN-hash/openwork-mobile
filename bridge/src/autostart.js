import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

// Tên task trong Task Scheduler. Export để unit test + dùng chung với bin/openpocket.js.
export const AUTOSTART_TASK_NAME = "OpenPocketBridge";

export function bridgeEntryPath() {
  return join(SRC_DIR, "index.js");
}

// Câu lệnh cho schtasks /TR "<node> <entry>": bọc ngoặc kép từng phần vì
// đường dẫn Windows hay có dấu cách (C:\Program Files\..., Antigravity\...).
export function buildAutostartAction(nodeExecPath = process.execPath, entryPath = bridgeEntryPath()) {
  return `"${nodeExecPath}" "${entryPath}"`;
}
