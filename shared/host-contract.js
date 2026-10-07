// HỢP ĐỒNG HOST DÙNG CHUNG — MỘT nguồn chân lý cho kiến thức về MÁY CHỦ mà
// desktop C# (desktop/src) và bridge JS (bridge/src) PHẢI cùng biết: tên
// file/thư mục trên đĩa, cổng, tên task scheduler, khoá trong config.json,
// shape tunnel. Tồn tại từ review 07/10 (candidate 1) vì những kiến thức này
// từng được chép tay ở CẢ HAI ngôn ngữ: bridge đổi tên file là GUI lặng lẽ
// đọc hụt, GUI đổi tên task là CLI không /end nổi — không test nào bắt vì
// mỗi bên test riêng, C# còn không có test runner.
//
// Cách hai bên tiêu thụ MỘT nguồn này:
//   - bridge JS: `import { HOST_CONTRACT } from "../../shared/host-contract.js"`
//     trực tiếp (file này thuần — không import gì, không đụng Node API).
//   - desktop C#: build.bat chạy `node gen-host-contract.mjs` SINH RA
//     desktop/src/HostContract.cs từ file này (cùng mô hình IdentityKeys.cs).
// Sửa kiến thức = sửa FILE NÀY một chỗ rồi build lại.
//
// Phạm vi CHỈ là host (máy chạy bridge). Shape API ba tầng web↔worker↔bridge
// nằm ở shared/contract.js; mã lỗi worker desktop tiêu thụ cũng ở đó.

export const HOST_CONTRACT = {
  // Cổng HTTP bridge mặc định khi config thiếu/sai — cùng mặc định với
  // loadConfig (bridge/src/config.js) và BridgeConfig.Port (C#).
  bridgePort: 8788,
  // Thư mục dữ liệu bridge: %APPDATA%\openwork-bridge (Windows),
  // ~/.openwork-bridge (còn lại — C# chỉ chạy Windows nên không gặp dạng chấm).
  dataDirName: "openwork-bridge",
  // File config bên trong thư mục trên — nơi C# ĐỌC THẲNG (chủ nhà đã chốt
  // giữ plaintext, xem hardenConfigFile) và bridge ghi.
  configFileName: "config.json",
  // bridge.pid: index.js ghi lúc boot, xoá lúc tắt; BridgeProcess.Stop kill
  // theo PID này trước khi rơi xuống dò WMI.
  pidFileName: "bridge.pid",
  // Ba file log trong data dir. `task` là log của task scheduler/VBS — cũng
  // là log GUI dùng khi bật bridge trực tiếp (cùng dòng lệnh với task).
  logNames: { bridge: "bridge.log", task: "bridge-task.log", watchdog: "watchdog.log" },
  // Task scheduler: autostart (logon) + watchdog (5 phút/lần `openpocket
  // ensure`). Chủ thật của tên là bridge/src/autostart.js — GUI chỉ /end theo
  // tên và nhắc tên trong câu báo lỗi.
  autostartTaskName: "OpenPocketBridge",
  watchdogTaskName: "OpenPocketBridgeWatchdog",
  // Khoá trong config.json mà GUI C# đọc/ghi trực tiếp (khác `port`/token thì
  // config.js loadConfig luôn trả đủ mặc định — tên sai là GUI ghi key lạ,
  // bridge bỏ qua silently).
  configKeys: ["mobileToken", "port", "lookupUrl", "lookupSecret", "lookupTenant", "machineName"],
  // File fallback trạng thái tunnel (bridge/src/tunnel.js ghi, TunnelState.cs
  // đọc khi GET /api/state hụt). saveTunnelState còn tự thêm `updatedAt`.
  tunnelStateFileName: "tunnel-state.json",
  tunnelStateKeys: ["phase", "url", "streak", "nextAttemptAt"],
  // Giá trị `phase` của tunnel (tunnel.js giữ chủ; GUI so sánh lên).
  tunnelPhases: ["starting", "up", "backoff"],
  // Shape GET /api/state → `tunnel:{...}` — NGUỒN CHÍNH của GUI từ e40658d.
  // Lưu ý không đụng được: FILE fallback dùng `nextAttemptAt`, API dùng
  // `nextRetryAt` — hai tên khác nhau cho cùng ý nghĩa, đổi bên nào cũng là
  // GUI báo trạng thái tunnel sai im lặng. (`streak` = bộ đếm 429 đi theo cả
  // hai shape.)
  stateTunnelField: "tunnel",
  stateTunnelKeys: ["phase", "url", "streak", "nextRetryAt"],
};
