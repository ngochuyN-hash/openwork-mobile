using System;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace OpenPocket.Desktop
{
    // ================= AUTOSTART TASK — task scheduler "OpenPocketBridge" =======
    // Tách khỏi OpenPocket.cs (tách module candidate 7, 06/10): task tồn tại?,
    // /run theo lệnh Bật Bridge, tạo (.vbs KHÔNG BOM + schtasks /Create ONLOGON),
    // xoá. Mọi MessageBox thuộc form — module chỉ trả kết quả + lời lỗi.
    internal static class AutostartTask
    {
        public static bool Exists()
        {
            try
            {
                var psi = new ProcessStartInfo("schtasks.exe", "/query /tn OpenPocketBridge");
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                var p = Process.Start(psi);
                // schtasks chạy trên UI thread — chờ CÓ GIỚI HẠN, không đóng
                // băng cửa sổ vô hạn; quá hạn coi như task không tồn tại.
                bool exited = p.WaitForExit(10000);
                return exited && p.ExitCode == 0;
            }
            catch
            {
                return false;
            }
        }

        // Bật bridge qua task có sẵn — PHẢI kiểm exit code: trước đây /run hụt
        // (task hỏng, thiếu quyền…) mà không ai hay, đèn xanh chỉ là mơ hồ của
        // tick sau. Trả false kèm câu lỗi ĐẦY ĐỦ tiền ngữ cho MessageBox.
        public static bool RunExisting(out string error)
        {
            error = "";
            var psiRun = new ProcessStartInfo("schtasks.exe", "/run /tn OpenPocketBridge");
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
                    error = "Could not start the bridge - the OpenPocketBridge task failed (schtasks exit " + p.ExitCode + "): " + err;
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
                    "/Create /TN OpenPocketBridge /SC ONLOGON /TR \"\\\"wscript.exe\\\" \\\"" + vbsPath + "\\\"\" /RL HIGHEST /F");
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
                var psi = new ProcessStartInfo("schtasks.exe", "/Delete /TN OpenPocketBridge /F");
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                var p = Process.Start(psi);
                p.WaitForExit(10000); // timeout — không đóng băng UI vô hạn
                return true;
            }
            catch { return false; }
        }
    }
}
