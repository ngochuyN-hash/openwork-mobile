// Sinh web/dist/_headers từ shared/security-headers.js — cửa Cloudflare Assets
// đọc file này và gắn header cho mọi asset response (cửa thứ ba, cạnh worker
// và bridge tunnel). KHÔNG sửa tay file sinh ra: sửa chính sách ở
// shared/security-headers.js rồi build lại.
//
// Chạy tự động sau `vite build` (web/package.json "build" script).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderHeadersFile } from "../../shared/security-headers.js";

const here = dirname(fileURLToPath(import.meta.url));
const dist = process.argv[2] ?? join(here, "..", "dist");
const target = join(dist, "_headers");

mkdirSync(dist, { recursive: true });
writeFileSync(target, renderHeadersFile(), "utf8");
console.log(`[gen-headers] ${target}`);
