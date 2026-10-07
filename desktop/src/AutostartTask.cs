using System;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace OpenPocket.Desktop
{
    // ================= AUTOSTART TASK — task scheduler "OpenPocketBridge" =======
    // Tách khỏi OpenPocket.cs (tách module candidate 7, 06/10): task tồn tại?,
    // /run theo lệnh Bật Bridge, tạo (.vbs KHÔNG BOM + schtasks /Create ONLOGON),
    // xoá. 07/10 (lệnh user "autostart là 1 phần chức năng exe"): thêm TỰ LÀNH —
    //Healthy()/NeedsRepair() soi TRIGGER thật qua /XML thay vì chỉ hỏi "tồn tại",
    // và EnableWatchdog() cài máy canh 5 phút chạy `openpocket ensure` (bridge
    // chết ngầm hoặc boot/resume không phát logon-event — sự cố sáng 07/10 —
    // đều tự hồi sinh trong 5 phút). Tên task phải khớp AUTOSTART_TASK_NAME /
    // WATCHDOG_TASK_NAME trong bridge/src/autostart.js. Mọi MessageBox thuộc
    // form — module chỉ trả kết quả + lời lỗi.
    internal static class AutostartTask
    {
        // Phải khớp AUTOSTART_TASK_NAME trong bridge/src/autostart.js
        private const string TaskName = "OpenPocketBridge";
        // Phải khớp WATCHDOG_TASK_NAME trong bridge/src/autostart.js
        private const string WatchdogName = "OpenPocketBridgeWatchdog";

        // Query một task, trả XML gốc (false khi task không có / lệnh hụt).
        // schtasks chạy trên thread gọi nó — chờ CÓ GIỚI HẠN 10s, không đóng băng
        // UI vô hạn; quá hạn coi như không có.
        private static bool QueryTaskXml(string taskName, out string xml)
        {
            xml = "";
            try
            {
                var psi = new ProcessStartInfo("schtasks.exe", "/query /tn " + taskName + " /xml");
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                var p = Process.Start(psi);
                bool exited = p.WaitForExit(10000);
                if (!exited || p.ExitCode != 0) return false;
                xml = p.StandardOutput.ReadToEnd();
                return true;
            }
            catch
            {
                return false;
            }
        }

        public static bool Exists()
        {
            string xml;
            return QueryTaskXml(TaskName, out xml);
        }

        // Task CÒN ZÔNG không: tồn tại VÀ trigger thật sự là logon (XML có
        // <LogonTrigger>). Chỉ hỏi "tồn tại" là thiếu — task chết vẫn tồn tại
        // và từng sáng đèn oan trong GUI.
        public static bool Healthy()
        {
            string xml;
            return QueryTaskXml(TaskName, out xml) && xml.Contains("LogonTrigger");
        }

        // Tồn tại nhưng trigger chết — cần dựng lại bằng Enable().
        public static bool NeedsRepair()
        {
            string xml;
            return QueryTaskXml(TaskName, out xml) && !xml.Contains("LogonTrigger");
        }

        // Bật bridge qua task có sẵn — PHẢI kiểm exit code: trước đây /run hụt
        // (task hỏng, thiếu quyền…) mà không ai hay, đèn xanh chỉ là mơ hồ của
        // tick sau. Trả false kèm câu lỗi ĐẦY ĐỦ tiền ngữ cho MessageBox.
        public static bool RunExisting(out string error)
        {
            error = "";
            var psiRun = new ProcessStartInfo("schtasks.exe", "/run /tn " + TaskName);
            psiRun.CreateNoWindow = true;
            psiRun.UseShellExecute = false;
            psiRun.RedirectStandardOutput = true;
            psiRun.RedirectStandardError = true;
            using (Process p = Process.Start(psiRun))
            {
                bool exited = p.WaitForExit(10000);
                if (!exited)
                {
                    error = "Could not start the bridge: the schtasks /run command did not exit after 10 seconds.";
                    return false;
                }
                if (p.ExitCode != 0)
                {
                    string err = "";
                    try { err = p.StandardError.ReadToEnd().Trim(); } catch { }
                    if (err == "") { try { err = p.StandardOutput.ReadToEnd().Trim(); } catch { } }
                    error = "Could not start the bridge - the " + TaskName + " task failed (schtasks exit " + p.ExitCode + "): " + err;
                    return false;
                }
            }
            return true;
        }

        // Tạo task tự khởi động: .vbs chạy node bridge ẩn cửa sổ + schtasks
        // /Create ONLOGON /RL HIGHEST. error chỉ khác "" khi NẠI LỆCH (Process
        // văng) — task tạo hổng (schtasks exit != 0) trả false, error rỗng,
        // checkbox về false mà không hiện hộp (giữ y hành vi cũ).
        public static bool Enable(string bridgeDir, string nodeExe, out string error)
        {
            error = "";
            try
            {
                string bridgeEntry = Path.Combine(bridgeDir, "src", "index.js");
                if (!File.Exists(bridgeEntry))
                {
                    error = "File bridge/src/index.js not found";
                    return false;
                }

                string dataDir = BridgeConfig.DataDir();
                if (!Directory.Exists(dataDir)) Directory.CreateDirectory(dataDir);
                string vbsPath = Path.Combine(dataDir, "bridge-task.vbs");
                string logPath = Path.Combine(dataDir, "bridge-task.log");

                string vbsContent = "Set sh = CreateObject(\"WScript.Shell\")\r\n" +
                    "sh.CurrentDirectory = \"" + bridgeDir.Replace("\"", "\"\"") + "\"\r\n" +
                    "sh.Run \"cmd /c \"\"\"\"" + nodeExe.Replace("\"", "\"\"") + "\"\" \"\"" + bridgeEntry.Replace("\"", "\"\"") + "\"\" >> \"\"" + logPath.Replace("\"", "\"\"") + "\"\" 2>&1\"\"\", 0, False\r\n";

                // KHÔNG BOM: wscript đọc .vbs dính UTF-8 BOM là chết ngay với lỗi
                // "Not enough memory resources" — task Running ảo, bridge không
                // bao giờ boot (bắt gặp thật 13/09, phải printf tay mới chữa được)
                File.WriteAllText(vbsPath, vbsContent, new UTF8Encoding(false));

                var psi = new ProcessStartInfo("schtasks.exe",
                    "/Create /TN " + TaskName + " /SC ONLOGON /TR \"\\\"wscript.exe\\\" \\\"" + vbsPath + "\\\"\" /RL HIGHEST /F");
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                var p = Process.Start(psi);
                // Timeout 10s — schtasks trên UI thread không được treo vô hạn;
                // quá hạn thì chưa thể đọc ExitCode, coi như tạo chưa xong.
                bool exited = p.WaitForExit(10000);
                return exited && p.ExitCode == 0;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }

        public static bool Disable()
        {
            try
            {
                var psi = new ProcessStartInfo("schtasks.exe", "/Delete /TN " + TaskName + " /F");
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                var p = Process.Start(psi);
                p.WaitForExit(10000); // timeout — không đóng băng UI vô hạn
                return true;
            }
            catch { return false; }
        }

        // ===== MÁY CANH — task 5 phút chạy `openpocket ensure` =====
        // Bridge chết ngầm (kill ngoài CLI, crash) hoặc máy bật lại mà không có
        // logon-event mới (Fast Startup resume) đều được dựng lại trong 5 phút —
        // task MINUTE chạy theo giờ hệ thống, không phụ thuộc ai đăng nhập.
        // Cài/xoá CÙNG checkbox autostart: hai task là MỘT tính năng.
        public static bool WatchdogExists()
        {
            string xml;
            return QueryTaskXml(WatchdogName, out xml);
        }

        public static bool EnableWatchdog(string bridgeDir, string nodeExe, out string error)
        {
            error = "";
            try
            {
                string cliPath = Path.Combine(bridgeDir, "bin", "openpocket.js");
                if (!File.Exists(cliPath))
                {
                    error = "File bridge/bin/openpocket.js not found";
                    return false;
                }

                string dataDir = BridgeConfig.DataDir();
                if (!Directory.Exists(dataDir)) Directory.CreateDirectory(dataDir);
                string vbsPath = Path.Combine(dataDir, "bridge-watchdog.vbs");
                string logPath = Path.Combine(dataDir, "watchdog.log");

                // Cùng khuôn .vbs KHÔNG BOM với bridge-task.vbs; khác ở entry
                // (bin/openpocket.js ensure) và log (watchdog.log).
                string vbsContent = "Set sh = CreateObject(\"WScript.Shell\")\r\n" +
                    "sh.CurrentDirectory = \"" + bridgeDir.Replace("\"", "\"\"") + "\"\r\n" +
                    "sh.Run \"cmd /c \"\"\"\"" + nodeExe.Replace("\"", "\"\"") + "\"\" \"\"" + cliPath.Replace("\"", "\"\"") + "\"\" ensure >> \"\"" + logPath.Replace("\"", "\"\"") + "\"\" 2>&1\"\"\", 0, False\r\n";
                File.WriteAllText(vbsPath, vbsContent, new UTF8Encoding(false));

                var psi = new ProcessStartInfo("schtasks.exe",
                    "/Create /TN " + WatchdogName + " /SC MINUTE /MO 5 /TR \"\\\"wscript.exe\\\" \\\"" + vbsPath + "\\\"\" /RL HIGHEST /F");
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                var p = Process.Start(psi);
                bool exited = p.WaitForExit(10000);
                return exited && p.ExitCode == 0;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }

        public static bool DisableWatchdog()
        {
            try
            {
                var psi = new ProcessStartInfo("schtasks.exe", "/Delete /TN " + WatchdogName + " /F");
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                var p = Process.Start(psi);
                p.WaitForExit(10000);
                return true;
            }
            catch { return false; }
        }
    }
}
