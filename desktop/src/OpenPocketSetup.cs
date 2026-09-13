using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Windows.Forms;

// Trình cài OpenPocket — MỘT file exe duy nhất gói trọn bridge + web + app.
// Gói zip được NHÚNG trong exe (csc /res:package.zip) nên bạn bè chỉ cần
// đúng 1 file: bấm đúp -> kiểm tra Node -> giải nén vào %LOCALAPPDATA%\OpenPocket
// -> tạo shortcut -> mở app (app tự lo npm install + định danh + QR sau đó).
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

            if (!HasNode())
            {
                MessageBox.Show(
                    "Máy chưa có Node.js!\n\n" +
                    "Trình cài sẽ mở trang tải Node.js (chọn bản LTS, cài next-next là xong).\n" +
                    "Cài xong thì chạy lại OpenPocket-Setup.exe nhé.",
                    "OpenPocket — thiếu Node.js", MessageBoxButtons.OK, MessageBoxIcon.Information);
                try { Process.Start("https://nodejs.org"); } catch { }
                return 1;
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
                try
                {
                    string exePath = Path.Combine(finalDir, "OpenPocket.exe");
                    object shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
                    MakeShortcut(shell, Environment.GetFolderPath(Environment.SpecialFolder.Programs), exePath);
                    MakeShortcut(shell, Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), exePath);
                    Process.Start(exePath);
                }
                catch { }
            }
            return 0;
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
            try
            {
                string path = Path.Combine(folder, "OpenPocket.lnk");
                dynamic lnk = ((dynamic)shell).CreateShortcut(path);
                lnk.TargetPath = exePath;
                lnk.Save();
            }
            catch { }
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
