// Sinh hai file C# từ các nguồn chung trong shared/ (không sửa tay, không
// commit — build.bat/build-test.bat chạy lại mỗi lần build):
//   src/HostContract.cs ← shared/host-contract.js (kien thuc host, 07/10)
//   src/ErrorCode.cs    ← shared/contract.js  (ma loi xuyen tang exe so, 07/10)
// Bên JS không cần file sinh — import trực tiếp hai file nguồn.
import { writeFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_CONTRACT } from "../shared/host-contract.js";
import { ErrorCode } from "../shared/contract.js";

// lookupTenant → LookupTenant; nextAttemptAt → NextAttemptAt
const pascal = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// TENANT_REQUIRED → TenantRequired
const pascalFromScreaming = (k) => k.toLowerCase().split("_").map(pascal).join("");

/** Dựng ErrorCode.cs từ shared/contract.js — mã lỗi xuyên tầng mà exe desktop
 * so trong Provisioning.ErrorText (taken/full/room_create_disabled/...).
 * Trước đây exe gõ tay chuỗi "taken"... worker đổi mã là câu hướng dẫn rơi về
 * câu chung; giờ hai bên đọc một nguồn, drift bị chặn như HostContract. */
export function renderErrorCodeCs(codes = ErrorCode) {
  const lines = [];
  lines.push("// Sinh tu dong boi desktop\\gen-host-contract.mjs tu shared\\contract.js");
  lines.push("// - KHONG sua tay, KHONG commit (giong HostContract.cs).");
  lines.push("// Ma loi xuyen tang: worker phat, exe desktop so/de hien (Provisioning.ErrorText).");
  lines.push("internal static class ErrorCode");
  lines.push("{");
  for (const [key, value] of Object.entries(codes)) {
    lines.push(`    public const string ${pascalFromScreaming(key)} = "${value}";`);
  }
  lines.push("}");
  return lines.join("\r\n") + "\r\n";
}

/** Dựng nội dung C# (thuần, không đụng đĩa — bridge/test khoá lại bằng test). */
export function renderHostContractCs(c = HOST_CONTRACT) {
  const lines = [];
  const push = (s) => lines.push(s);
  push("// Sinh tu dong boi desktop\\gen-host-contract.mjs tu shared\\host-contract.js");
  push("// - KHONG sua tay, KHONG commit (giong InviteKey.cs / IdentityKeys.cs).");
  push("// Sua kien thuc host = sua file nguon chung roi build lai: JS import ban");
  push("// goc, C# nhan ban sinh ra — hai ben khong the lac nhau.");
  push("internal static class HostContract");
  push("{");
  push(`    public const int BridgePort = ${c.bridgePort};`);
  push(`    public const string DataDirName = "${c.dataDirName}";`);
  push(`    public const string ConfigFileName = "${c.configFileName}";`);
  push(`    public const string PidFileName = "${c.pidFileName}";`);
  push("    // Ba file log trong data dir (GUI doc + don dep; bridge ghi).");
  for (const [key, name] of Object.entries(c.logNames)) {
    push(`    public const string Log${pascal(key)} = "${name}";`);
  }
  push(
    "    public static readonly string[] LogNames = new string[] { " +
      Object.values(c.logNames).map((n) => `"${n}"`).join(", ") +
      " };"
  );
  push("    // Ten task scheduler (autostart + watchdog).");
  push(`    public const string AutostartTaskName = "${c.autostartTaskName}";`);
  push(`    public const string WatchdogTaskName = "${c.watchdogTaskName}";`);
  push("    // Khoá trong config.json mà GUI đọc/ghi trực tiếp.");
  for (const key of c.configKeys) {
    push(`    public const string ConfigKey${pascal(key)} = "${key}";`);
  }
  push("    // File fallback tunnel-state.json (bridge ghi, GUI doc khi API het tra loi).");
  push(`    public const string TunnelStateFileName = "${c.tunnelStateFileName}";`);
  for (const key of c.tunnelStateKeys) {
    push(`    public const string TunnelKey${pascal(key)} = "${key}";`);
  }
  push("    // Gia tri phase cua tunnel.");
  for (const phase of c.tunnelPhases) {
    push(`    public const string TunnelPhase${pascal(phase)} = "${phase}";`);
  }
  push("    // Shape GET /api/state -> tunnel{...} (nguon chinh tu e40658d; file");
  push("    // fallback dung nextAttemptAt, API dung nextRetryAt — hai ten khac)");
  push(`    public const string StateTunnelField = "${c.stateTunnelField}";`);
  for (const key of c.stateTunnelKeys) {
    push(`    public const string StateTunnelKey${pascal(key)} = "${key}";`);
  }
  push("}");
  return lines.join("\r\n") + "\r\n";
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === thisFile) {
  const srcDir = join(dirname(thisFile), "src");
  const hostOut = join(srcDir, "HostContract.cs");
  writeFileSync(hostOut, renderHostContractCs());
  console.log(`[gen] ${hostOut} written from shared/host-contract.js`);
  const codesOut = join(srcDir, "ErrorCode.cs");
  writeFileSync(codesOut, renderErrorCodeCs());
  console.log(`[gen] ${codesOut} written from shared/contract.js`);
}
