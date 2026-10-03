using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Windows.Forms;

// Trình cài OpenPocket — MỘT file exe duy nhất gói trọn bridge + web + app,
// và bridge/node_modules đã VENDOR SẴN trong gói (chỉ qrcode-terminal — see
// desktop/build-setup.js), nên người dùng KHÔNG chạy npm install nữa.
// Bấm đúp -> giải nén vào %LOCALAPPDATA%\OpenPocket -> tạo shortcut ->
// mở app (app tự định danh + QR sau đó). Node.js vẫn cần trên máy để CHẠY
// bridge (node.exe), nhưng thiếu Node KHÔNG còn chặn cài — chỉ một cảnh báo
// + gợi ý tải trang. Báo thật khi shortcut/app tự mở thất bại, không nuốt lỗi.
// C# 5 only (csc .NET 4): không string interpolation, không ?., không out var.

namespace OpenPocket.Setup
{
    static class Program
    {
        [STAThread]
        static int Main()
        {
            string finalDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "OpenPocket");
            // Test mode: cài vào chỗ khác + không tạo shortcut / không mở app
            string testDir = Environment.GetEnvironmentVariable("OPENPOCKET_TEST_DIR");
            bool testMode = !string.IsNullOrEmpty(testDir);
            if (testMode) finalDir = testDir;

            // Node.js vẫn cần để CHẠY bridge (node.exe — FindNodeExe của app),
            // nhưng node_modules đã vendor trong gói nên cài KHÔNG bị chặn.
            // Hạ từ "bắt cài + mở trình duyệt + return 1" xuống một cảnh báo:
            // cài tiếp bình thường, chỉ hỏi có muốn mở trang tải Node không.
            if (!HasNode())
            {
                DialogResult openNode = MessageBox.Show(
                    "Máy chưa có Node.js — OpenPocket vẫn được cài bình thường.\n\n" +
                    "Nhưng để bấm \"Bật Bridge\" (mở phiên làm việc, chat, file từ " +
                    "điện thoại), máy cần Node.js 20 trở lên.\n\n" +
                    "Mở trang tải Node.js (nodejs.org) bây giờ không?",
                    "OpenPocket — nên cài Node.js", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
                if (openNode == DialogResult.Yes)
                {
                    try { Process.Start("https://nodejs.org"); } catch { }
                }
            }

            ShowProgress();

            try
            {
                ExtractPackage(finalDir);
            }
            catch (IOException)
            {
                CloseProgress();
                MessageBox.Show(
                    "OpenPocket đang mở — hãy đóng app (cửa sổ OpenPocket) rồi chạy Setup lại nhé.",
                    "OpenPocket", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return 2;
            }
            catch (Exception ex)
            {
                CloseProgress();
                MessageBox.Show("Cài không thành công: " + ex.Message,
                    "OpenPocket", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 3;
            }
            CloseProgress();

            if (!testMode)
            {
                // Báo thật: shortcut hỏng hay app không tự mở được đều phải
                // hiện lên, không nuốt lỗi rồi giả vờ cài thành công trọn vẹn.
                string warn = "";
                string exePath = Path.Combine(finalDir, "OpenPocket.exe");
                object shell = null;
                try
                {
                    shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
                }
                catch (Exception ex)
                {
                    warn = AppendWarn(warn, "không tạo được shortcut nào: " + ex.Message);
                }
                if (shell != null)
                {
                    try
                    {
                        MakeShortcut(shell, Environment.GetFolderPath(Environment.SpecialFolder.Programs), exePath);
                    }
                    catch (Exception ex)
                    {
                        warn = AppendWarn(warn, "chưa tạo được shortcut Start Menu: " + ex.Message);
                    }
                    try
                    {
                        MakeShortcut(shell, Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), exePath);
                    }
                    catch (Exception ex)
                    {
                        warn = AppendWarn(warn, "chưa tạo được shortcut Desktop: " + ex.Message);
                    }
                }
                try
                {
                    Process.Start(exePath);
                }
                catch (Exception ex)
                {
                    warn = AppendWarn(warn, "chưa tự mở được app — hãy mở: " + exePath +
                        " (" + ex.Message + ")");
                }
                if (warn.Length > 0)
                {
                    MessageBox.Show("Đã cài xong, nhưng có việc chưa xong:\n\n" + warn,
                        "OpenPocket", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
            }
            return 0;
        }

        static string AppendWarn(string acc, string msg)
        {
            return acc.Length == 0 ? msg : acc + "\n" + msg;
        }

        static bool HasNode()
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/c where node.exe");
                psi.UseShellExecute = false;
                psi.RedirectStandardOutput = true;
                psi.CreateNoWindow = true;
                using (Process p = Process.Start(psi))
                {
                    string outp = p.StandardOutput.ReadToEnd();
                    p.WaitForExit();
                    if (string.IsNullOrEmpty(outp)) return false;
                    string first = outp.Trim().Split('\r')[0].Trim();
                    return first.Length > 0 && File.Exists(first);
                }
            }
            catch { return false; }
        }

        // Zip nhúng trong exe — tìm theo tên đuôi "package.zip" để khỏi phụ thuộc
        // quy tắc đặt tên resource của csc
        static void ExtractPackage(string finalDir)
        {
            var asm = System.Reflection.Assembly.GetExecutingAssembly();
            string resName = "";
            foreach (string name in asm.GetManifestResourceNames())
            {
                if (name.EndsWith("package.zip")) { resName = name; break; }
            }
            if (resName == "") throw new Exception("gói cài không tìm thấy trong exe");

            if (!Directory.Exists(finalDir)) Directory.CreateDirectory(finalDir);
            using (Stream rs = asm.GetManifestResourceStream(resName))
            using (ZipArchive archive = new ZipArchive(rs))
            {
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    if (string.IsNullOrEmpty(entry.Name)) continue; // entry thư mục
                    string rel = entry.FullName.Replace('/', '\\');
                    if (rel.IndexOf("..") >= 0) continue; // zip-slip phòng hờ
                    string dest = Path.Combine(finalDir, rel);
                    string dir = Path.GetDirectoryName(dest);
                    if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
                    entry.ExtractToFile(dest, true);
                }
            }
        }

        static void MakeShortcut(object shell, string folder, string exePath)
        {
            // Không nuốt lỗi ở đây — caller gom từng lỗi lại và báo người dùng.
            string path = Path.Combine(folder, "OpenPocket.lnk");
            dynamic lnk = ((dynamic)shell).CreateShortcut(path);
            lnk.TargetPath = exePath;
            lnk.Save();
        }

        // Cửa sổ nhỏ báo đang cài — bấm đúp xong phải thấy chuyện gì xảy ra,
        // kẻo tưởng bấm hụt rồi đúp liên tiếp sinh nhiều instance
        static Form progressForm;

        static void ShowProgress()
        {
            progressForm = new Form();
            progressForm.Text = "OpenPocket Setup";
            progressForm.Size = new Size(320, 110);
            progressForm.StartPosition = FormStartPosition.CenterScreen;
            progressForm.FormBorderStyle = FormBorderStyle.FixedDialog;
            progressForm.MaximizeBox = false;
            progressForm.MinimizeBox = false;
            progressForm.TopMost = true;
            Label lbl = new Label();
            lbl.Text = "Đang cài OpenPocket — đợi chút nhé...";
            lbl.Font = new Font("Segoe UI", 10f);
            lbl.AutoSize = true;
            lbl.Location = new Point(24, 28);
            progressForm.Controls.Add(lbl);
            progressForm.Show();
            Application.DoEvents();
        }

        static void CloseProgress()
        {
            try { if (progressForm != null) progressForm.Close(); } catch { }
        }
    }
}
