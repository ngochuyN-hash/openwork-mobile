using System;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace OpenPocket.Desktop
{
    // ================= AUTOSTART TASK — task scheduler "OpenPocketBridge" =======
    // Tách khỏi OpenPocket.cs (tách module candidate 7, 06/10): task tồn tại?,
    // /run theo lệnh Bật Bridge, tạo (.vbs KHÔNG BOM), xoá. 07/10 (lệnh user
    // "autostart là 1 phần chức năng exe"): thêm TỰ LÀNH — Healthy()/NeedsRepair()
    // soi TRIGGER thật qua /XML thay vì chỉ hỏi "tồn tại", và EnableWatchdog()
    // cài máy canh 5 phút chạy `openpocket ensure` (bridge chết ngầm tự hồi sinh).
    // Task được tạo bằng /XML (không phải /TR) để ÉP 3 CỜ CHỐNG-PIN: schtasks
    // mặc định DisallowStartIfOnBatteries=true + StopIfGoingOnBatteries=true +
    // StartWhenAvailable=false — laptop chạy pin là task bị SKIP im lặng cả ngày
    // (bắt gặp thật 07/10: logon-trigger không chạy, /run kẹt Queued, watch dog
    // bị tính missed — máy đang BatteryStatus=1/53%).
    // Tên task phải khớp AUTOSTART_TASK_NAME / WATCHDOG_TASK_NAME trong
    // bridge/src/autostart.js (CLI tạo task cùng khuôn XML — giữ 2 bên khớp).
    // Mọi MessageBox thuộc form — module chỉ trả kết quả + lời lỗi.
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

        // Tồn tại nhưng cần dựng lại bằng Enable(): trigger chết, hoặc task mang
        // cờ mặc định của schtasks KHÔNG chạy được khi pin (sự cố 07/10 — laptop
        // đang pin, task bị skip im lặng, missed run không bao giờ chạy bù vì
        // StartWhenAvailable=false).
        public static bool NeedsRepair()
        {
            string xml;
            if (!QueryTaskXml(TaskName, out xml)) return false;
            if (!xml.Contains("LogonTrigger")) return true;
            return xml.Contains("<DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>")
                || xml.Contains("<StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>");
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

        // Khuôn task XML — bắt chước y XML schtasks tự sinh (đã verify trên máy
        // thật) và LẬT 3 CỜ PIN như mô tả đầu module. Đường dẫn trong Arguments
        // chỉ cần escape & < > (nháy kép hợp lệ trong text node).
        private static string XmlEscape(string s)
        {
            return s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");
        }

        private static string BuildTaskXml(string triggerXml, string vbsPath)
        {
            return "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\r\n" +
                "<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\r\n" +
                "  <Principals>\r\n" +
                "    <Principal id=\"Author\">\r\n" +
                "      <LogonType>InteractiveToken</LogonType>\r\n" +
                "      <RunLevel>HighestAvailable</RunLevel>\r\n" +
                "    </Principal>\r\n" +
                "  </Principals>\r\n" +
                "  <Settings>\r\n" +
                "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\r\n" +
                "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\r\n" +
                "    <StartWhenAvailable>true</StartWhenAvailable>\r\n" +
                "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\r\n" +
                "    <Enabled>true</Enabled>\r\n" +
                "    <Hidden>false</Hidden>\r\n" +
                "  </Settings>\r\n" +
                "  <Triggers>\r\n" + triggerXml + "\r\n" +
                "  </Triggers>\r\n" +
                "  <Actions Context=\"Author\">\r\n" +
                "    <Exec>\r\n" +
                "      <Command>wscript.exe</Command>\r\n" +
                "      <Arguments>\"" + XmlEscape(vbsPath) + "\"</Arguments>\r\n" +
                "    </Exec>\r\n" +
                "  </Actions>\r\n" +
                "</Task>\r\n";
        }

        private const string LogonTriggerXml =
            "    <LogonTrigger>\r\n      <Enabled>true</Enabled>\r\n    </LogonTrigger>";

        private const string WatchdogTriggerXml =
            "    <TimeTrigger>\r\n" +
            "      <Repetition>\r\n        <Interval>PT5M</Interval>\r\n        <StopAtDurationEnd>false</StopAtDurationEnd>\r\n      </Repetition>\r\n" +
            "      <Enabled>true</Enabled>\r\n" +
            "      <StartBoundary>2020-01-01T00:00:00</StartBoundary>\r\n" +
            "    </TimeTrigger>";

        // Tạo task từ XML: ghi file UTF-16 (BOM — declaration khai báo UTF-16,
        // schtasks đọc theo declaration nhưng ghi Unicode cho khớp chuẩn),
        // rồi /Create /XML /F (ghi đè task cũ, xoá luôn instance Queued cũ).
        private static bool CreateTaskFromXml(string taskName, string triggerXml, string vbsPath)
        {
            string dataDir = BridgeConfig.DataDir();
            if (!Directory.Exists(dataDir)) Directory.CreateDirectory(dataDir);
            string xmlPath = Path.Combine(dataDir, taskName + ".task.xml");
            File.WriteAllText(xmlPath, BuildTaskXml(triggerXml, vbsPath), Encoding.Unicode);

            var psi = new ProcessStartInfo("schtasks.exe",
                "/Create /TN " + taskName + " /XML \"" + xmlPath + "\" /F");
            psi.CreateNoWindow = true;
            psi.UseShellExecute = false;
            var p = Process.Start(psi);
            // Timeout 10s — schtasks không được treo vô hạn; quá hạn coi như
            // tạo chưa xong.
            bool exited = p.WaitForExit(10000);
            return exited && p.ExitCode == 0;
        }

        // Tạo task tự khởi động: .vbs chạy node bridge ẩn cửa sổ + task ONLOGON
        // pin-proof. error chỉ khác "" khi NẠI LỆCH (Process văng) — task tạo
        // hổng (schtasks exit != 0) trả false, error rỗng, checkbox về false mà
        // không hiện hộp (giữ y hành vi cũ).
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

                return CreateTaskFromXml(TaskName, LogonTriggerXml, vbsPath);
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
        // logon-event mới (Fast Startup resume) — và kể cả đang CHẠY PIN — đều
        // được dựng lại trong 5 phút. Cài/xoá CÙNG checkbox autostart: hai task
        // là MỘT tính năng.
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

                return CreateTaskFromXml(WatchdogName, WatchdogTriggerXml, vbsPath);
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
