using System;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Net.Sockets;
using System.Windows.Forms;

namespace OpenPocket.Desktop
{
    // ================= BRIDGE PROCESS — vòng đời tiến trình bridge ==============
    // Tách khỏi OpenPocket.cs (tách module candidate 7, 06/10): tìm node.exe,
    // kiểm presence của bridge trong zip, bật trực tiếp, DỪNG đúng tiến trình
    // (task scheduler + pid file + WMI theo đường dẫn entry), dọn log.
    internal static class BridgeProcess
    {
        public static string FindNodeExe()
        {
            try
            {
                var p = new Process();
                p.StartInfo.FileName = "where.exe";
                p.StartInfo.Arguments = "node.exe";
                p.StartInfo.UseShellExecute = false;
                p.StartInfo.RedirectStandardOutput = true;
                p.StartInfo.CreateNoWindow = true;
                p.Start();
                string outStr = p.StandardOutput.ReadLine();
                p.WaitForExit();
                if (!string.IsNullOrEmpty(outStr) && File.Exists(outStr.Trim()))
                    return outStr.Trim();
            }
            catch { }

            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string nodePf = Path.Combine(pf, "nodejs", "node.exe");
            if (File.Exists(nodePf)) return nodePf;

            return "node.exe";
        }

        // Bridge zero-dependency (qrcode-terminal nằm trong bridge/src/vendor) —
        // KHÔNG còn npm install, KHÔNG còn node_modules (khối cũ chạy ngầm tối
        // đa 5 phút mà không nói gì, và giữ nút "Đang cài bridge" treo không
        // hồi kết). Kiểm presence ĐỒNG BỘ: thiếu là bản zip đóng gói hỏng — báo rõ.
        public static bool EnsureDepsPresent(Control owner, string bridgeDir, string nodeExe)
        {
            if (bridgeDir == "" || !File.Exists(Path.Combine(bridgeDir, "src", "index.js")))
            {
                MessageBox.Show(owner,
                    "Bridge folder not found (bridge\\src\\index.js must sit next to OpenPocket.exe).\nGet the zip with the correct layout again, then tap Start Bridge.",
                    "Missing component", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return false;
            }
            if (!File.Exists(nodeExe))
            {
                MessageBox.Show(owner,
                    "Node.js (node.exe) not found.\nInstall Node.js 20+ (nodejs.org), then tap Start Bridge again.",
                    "Missing component", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return false;
            }
            return true;
        }

        public static bool IsPortOpen(string host, int port, int timeoutMs)
        {
            try
            {
                using (TcpClient client = new TcpClient())
                {
                    IAsyncResult ar = client.BeginConnect(host, port, null, null);
                    bool success = ar.AsyncWaitHandle.WaitOne(timeoutMs);
                    if (!success) return false;
                    client.EndConnect(ar);
                    return true;
                }
            }
            catch
            {
                return false;
            }
        }

        // Bật bridge KHÔNG qua task scheduler: node chạy trực tiếp, cửa sổ ẩn,
        // log ghi tiếp bridge-task.log (cùng dòng lệnh với .vbs của task). GUI
        // chạy elevated (manifest) nên tiến trình con kế thừa quyền — tương
        // đương /RL HIGHEST. Được dùng khi task tự khởi động chưa tồn tại:
        // Bật Bridge phải LUÔN chạy được, còn autostart chỉ qua checkbox.
        public static void StartDirect(string bridgeDir, string nodeExe)
        {
            string entry = Path.Combine(bridgeDir, "src", "index.js");
            string logPath = Path.Combine(BridgeConfig.DataDir(), HostContract.LogTask);
            var psi = new ProcessStartInfo("cmd.exe",
                "/c \"\"" + nodeExe + "\" \"" + entry + "\" >> \"" + logPath + "\" 2>&1\"");
            psi.WorkingDirectory = bridgeDir;
            psi.CreateNoWindow = true;
            psi.UseShellExecute = false;
            Process.Start(psi);
        }

        // Dừng bridge: task scheduler /end + kill theo pid file + fallback WMI
        // dò đúng entry script của cài đặt NÀY. Trả "" khi ổn, mô tả lỗi khi
        // hỏng — MessageBox vẫn thuộc form (module này không biết UI).
        public static string Stop(string bridgeDir)
        {
            try
            {
                // Dừng task nếu task đang có instance chạy
                try
                {
                    var psiEnd = new ProcessStartInfo("schtasks.exe", "/end /tn " + HostContract.AutostartTaskName);
                    psiEnd.CreateNoWindow = true;
                    psiEnd.UseShellExecute = false;
                    Process.Start(psiEnd).WaitForExit(3000);
                }
                catch { }

                // 1. Kill theo pid file (bridge do `openpocket start` mở)
                string pidFile = Path.Combine(BridgeConfig.DataDir(), HostContract.PidFileName);
                if (File.Exists(pidFile))
                {
                    string pidStr = File.ReadAllText(pidFile).Trim();
                    int pid;
                    if (int.TryParse(pidStr, out pid))
                    {
                        try
                        {
                            Process.GetProcessById(pid).Kill();
                        }
                        catch { }
                    }
                    try { File.Delete(pidFile); } catch { }
                }

                // 2. Fallback WMI: bridge do task scheduler mở chạy elevated KHÔNG có
                // pid file — dò process node có ĐẦY ĐỦ đường dẫn entry script của
                // cài đặt NÀY trong command line rồi kill. Điều kiện cũ (chỉ cần
                // chữ "bridge" + "index.js" xuất hiện riêng lẻ) từng giết NHẦM
                // node.exe của người khác đang chạy bridge trong repo/thư mục
                // khác trên cùng máy. bridgeDir chưa xác định thì KHÔNG kill mò.
                if (bridgeDir != "" && File.Exists(Path.Combine(bridgeDir, "src", "index.js")))
                {
                    string entryThis = Path.Combine(bridgeDir, "src", "index.js")
                        .ToLowerInvariant().Replace('/', '\\');
                    try
                    {
                        using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(
                            "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'node.exe'"))
                        {
                            foreach (ManagementObject proc in searcher.Get())
                            {
                                string cmdLine = (Convert.ToString(proc["CommandLine"]) ?? "")
                                    .ToLowerInvariant().Replace('/', '\\');
                                if (cmdLine.Contains(entryThis))
                                {
                                    try
                                    {
                                        Process.GetProcessById(Convert.ToInt32(proc["ProcessId"])).Kill();
                                    }
                                    catch { }
                                }
                            }
                        }
                    }
                    catch { }
                }

                // Bridge chết chậm (~1s thoát dở) — nhịp CheckStatus kế cần
                // thời gian để thấy port nhả ra.
                System.Threading.Thread.Sleep(800);
                return "";
            }
            catch (Exception ex)
            {
                return ex.Message;
            }
        }

        // Dọn log bridge trong data dir. deleteFiles = xóa hẳn file (dùng SAU khi
        // bridge đã chết); false = truncate về 0 (bridge vẫn chạy, file bị giữ
        // handle append nên không xóa được). Mở FileShare.ReadWrite để không
        // vấp handle của tiến trình ghi.
        public static void WipeLogs(bool deleteFiles)
        {
            foreach (string name in HostContract.LogNames)
            {
                string path = Path.Combine(BridgeConfig.DataDir(), name);
                if (deleteFiles)
                {
                    try { File.Delete(path); continue; } catch { }
                }
                try
                {
                    using (FileStream fs = new FileStream(path, FileMode.OpenOrCreate, FileAccess.Write, FileShare.ReadWrite))
                    {
                        fs.SetLength(0);
                    }
                }
                catch { }
            }
        }
    }
}
