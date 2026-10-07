using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Web.Script.Serialization;

namespace OpenPocket.Desktop
{
    // ================= AUTOSTART TASK — shell-out qua CLI `openpocket` =========
    // 07/10: GUI KHÔNG còn tự dựng task XML / VBS wrapper / string-match
    // schtasks nữa. Khuân XML chống-pin, VBS KHÔNG-BOM, tên task, và bộ đánh
    // giá healthy/needsRepair nằm MỘT CHỖ ở bridge/src/autostart.js (có unit
    // test — trước đây template tồn tại 2 bản sao C#/JS hàn bằng comment,
    // bản C# không thể test vì desktop không có test harness). Module này chỉ
    // còn là adapter mỏng: chạy node CLI, đọc --json.
    // Lưu ý quyền: GUI chạy elevated nên CLI con kế thừa — schtasks /Create
    // /Run không cần prompt thêm. CLI chạy tay không admin thì /xml query
    // hụt -> healthy=false bảo thủ (comment ở taskStatus bên CLI).
    internal static class AutostartTask
    {
        // Chạy CLI, thu stdout (EOF khi process đóng stdout — đọc TRƯỚC
        // WaitForExit kẻo deadlock pipe khi output bất ngờ to). Trả false kèm
        // error đủ tiền ngữ cho MessageBox.
        private static bool RunCli(string bridgeDir, string nodeExe, string args, out string stdout, out string error)
        {
            stdout = "";
            error = "";
            if (nodeExe == "" || !File.Exists(nodeExe)) { error = "node.exe not found"; return false; }
            string cli = Path.Combine(bridgeDir, "bin", "openpocket.js");
            if (!File.Exists(cli)) { error = "File bridge/bin/openpocket.js not found"; return false; }
            try
            {
                var psi = new ProcessStartInfo(nodeExe, "\"" + cli + "\" " + args);
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                var p = Process.Start(psi);
                stdout = p.StandardOutput.ReadToEnd();
                if (!p.WaitForExit(20000))
                {
                    error = "openpocket " + args + " did not exit after 20 seconds.";
                    return false;
                }
                if (p.ExitCode != 0)
                {
                    string err = "";
                    try { err = p.StandardError.ReadToEnd().Trim(); } catch { }
                    if (err == "") { try { err = p.StandardOutput.ReadToEnd().Trim(); } catch { } }
                    error = "openpocket " + args + " failed (exit " + p.ExitCode + "): " + err;
                    return false;
                }
                return true;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }

        // `openpocket tasks --json` — trạng thái CẢ HAI task trong một lần
        // spawn. false + error khi CLI hụt chạy / JSON không hiểu được.
        public static bool Status(string bridgeDir, string nodeExe,
            out bool autostartExists, out bool autostartHealthy, out bool autostartNeedsRepair,
            out bool watchdogExists, out string error)
        {
            autostartExists = autostartHealthy = autostartNeedsRepair = watchdogExists = false;
            string stdout;
            if (!RunCli(bridgeDir, nodeExe, "tasks --json", out stdout, out error)) return false;
            try
            {
                var dict = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(stdout);
                var a = dict["autostart"] as Dictionary<string, object>;
                var w = dict["watchdog"] as Dictionary<string, object>;
                autostartExists = Convert.ToBoolean(a["exists"]);
                autostartHealthy = Convert.ToBoolean(a["healthy"]);
                autostartNeedsRepair = Convert.ToBoolean(a["needsRepair"]);
                watchdogExists = Convert.ToBoolean(w["exists"]);
                return true;
            }
            catch (Exception ex)
            {
                error = "Cannot parse openpocket tasks --json output: " + ex.Message;
                return false;
            }
        }

        // Bốn hàm hỏi trạng thái — mỗi cái một lần spawn node (~vài trăm ms,
        // gọi trên thread nền / một lần lúc mở app). Lỗi CLI = coi như không.
        public static bool Exists(string bridgeDir, string nodeExe)
        {
            bool ae, ah, anr, we; string err;
            return Status(bridgeDir, nodeExe, out ae, out ah, out anr, out we, out err) && ae;
        }

        public static bool Healthy(string bridgeDir, string nodeExe)
        {
            bool ae, ah, anr, we; string err;
            return Status(bridgeDir, nodeExe, out ae, out ah, out anr, out we, out err) && ah;
        }

        public static bool NeedsRepair(string bridgeDir, string nodeExe)
        {
            bool ae, ah, anr, we; string err;
            return Status(bridgeDir, nodeExe, out ae, out ah, out anr, out we, out err) && anr;
        }

        public static bool WatchdogExists(string bridgeDir, string nodeExe)
        {
            bool ae, ah, anr, we; string err;
            return Status(bridgeDir, nodeExe, out ae, out ah, out anr, out we, out err) && we;
        }

        // Bật autostart (CLI tự viết VBS + XML + schtasks /Create /F). Trả false
        // kèm error ĐẦY ĐỦ tiền ngữ — task tạo hổng phải trở về false vô hơi.
        public static bool Enable(string bridgeDir, string nodeExe, out string error)
        {
            string stdout;
            return RunCli(bridgeDir, nodeExe, "autostart --enable", out stdout, out error);
        }

        public static bool EnableWatchdog(string bridgeDir, string nodeExe, out string error)
        {
            string stdout;
            return RunCli(bridgeDir, nodeExe, "watchdog --install", out stdout, out error);
        }

        public static bool Disable(string bridgeDir, string nodeExe)
        {
            string stdout, error;
            return RunCli(bridgeDir, nodeExe, "autostart --disable", out stdout, out error);
        }

        public static bool DisableWatchdog(string bridgeDir, string nodeExe)
        {
            string stdout, error;
            return RunCli(bridgeDir, nodeExe, "watchdog --uninstall", out stdout, out error);
        }

        // Chạy task bridge CÓ SẴN (schtasks /run) — PHẢI kiểm kết quả: trước
        // đây /run hụt (task hỏng, thiếu quyền…) mà không ai hay, đèn xanh chỉ
        // là mơ hồ của tick sau. CLI trả --json {ok, error}.
        public static bool RunExisting(string bridgeDir, string nodeExe, out string error)
        {
            error = "";
            string stdout;
            if (!RunCli(bridgeDir, nodeExe, "autostart --run --json", out stdout, out error)) return false;
            try
            {
                var dict = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(stdout);
                if (Convert.ToBoolean(dict["ok"])) return true;
                error = "Could not start the bridge - the " + HostContract.AutostartTaskName
                    + " task failed: " + Convert.ToString(dict["error"]);
                return false;
            }
            catch (Exception ex)
            {
                error = "Cannot parse openpocket autostart --run --json output: " + ex.Message;
                return false;
            }
        }
    }
}
