using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace OpenPocket.Desktop
{
    // ================= PAIRING QR POPUP DIALOG ==================================
    // Tách khỏi OpenPocket.cs (tách module candidate 7, 06/10).
    // QR NGUỒN: bridge /api/pairing-code trả sẵn ASCII QR (qrcode-terminal) —
    // GUI dịch ngược ASCII thành lưới dữ liệu rồi vẽ BITMAP khổ cố định
    // (QrAsciiRenderer cuối file): 2 mã cùng khổ dù dữ liệu dài ngắn khác
    // nhau, hết cảnh chuyển qua lại form co giãn. Vẫn KHÔNG gửi mã ghép cho
    // API QR ngoài — mã không rời máy.
    // 07/10: trước đây vẽ ASCII bằng font Consolas — bản đó là QR NGHỊCH MÀU
    // (qrcode-terminal định nghĩa ô đen = dấu cách, vì nó viết cho terminal
    // nền tối) nên đành phụ thuộc máy quét ăn QR đảo màu. Renderer giờ đọc
    // đúng ngữ nghĩa dữ liệu của vendor và vẽ đen-trắng chuẩn spec.

    public class PairingQrDialog : Form
    {
        private static readonly Color ColorBg = Color.FromArgb(244, 244, 245);
        private static readonly Color ColorCard = Color.White;
        private static readonly Color ColorPrimary = Color.FromArgb(24, 24, 27);
        // CHỮ PHẢI TỐI trên nền sáng — di sản bản dark cũ để chữ #F4F4F5 (gần
        // trắng): title, nút "Mã vĩnh viễn", link master, nút Đóng đều mờ gần
        // như vô hình trên nền trắng (bắt gặp bằng mắt 13/09)
        private static readonly Color ColorText = Color.FromArgb(24, 24, 27);
        private static readonly Color ColorMuted = Color.FromArgb(113, 113, 122);

        private PictureBox picQr;
        private Label lblPairCode;
        private Label lblExpiry;
        private Label lblPairUrlNote;
        private Label lblMasterNote;
        private TextBox txtPairUrl;
        private TextBox txtMasterUrl;
        private RoundedButton btnCopyUrl;
        private RoundedButton btnCopyMaster;
        private RoundedButton btnShowLive;
        private RoundedButton btnShowMaster;
        private RoundedButton btnClose;

        private string liveQr = "";
        private string masterQr = "";
        private string livePairUrl = "";
        private string liveMasterUrl = "";
        private bool showingMaster = false;

        public PairingQrDialog(Dictionary<string, object> config, string bridgeDataDir)
        {
            this.Text = "Phone pairing code - OpenPocket";
            this.ClientSize = new Size(520, 700);
            this.StartPosition = FormStartPosition.CenterParent;
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.MinimizeBox = false;
            this.BackColor = ColorBg;
            this.ForeColor = ColorText;
            this.Font = new Font("Segoe UI", 9.5f);
            this.Icon = AppIcons.Current;

            int port = BridgeConfig.Port(config);
            string token = BridgeConfig.MobileToken(config);

            // Title
            Label lblTitle = new Label();
            lblTitle.Text = "📱 PHONE PAIRING - SCAN THE CODE";
            lblTitle.Font = new Font("Segoe UI", 12f, FontStyle.Bold);
            lblTitle.ForeColor = ColorText;
            lblTitle.Location = new Point(20, 14);
            lblTitle.AutoSize = true;
            this.Controls.Add(lblTitle);

            // Pair Code
            lblPairCode = new Label();
            lblPairCode.Text = "Getting the code...";
            lblPairCode.Font = new Font("Segoe UI", 15f, FontStyle.Bold);
            lblPairCode.ForeColor = ColorPrimary;
            lblPairCode.Location = new Point(20, 46);
            lblPairCode.Size = new Size(470, 30);
            lblPairCode.TextAlign = ContentAlignment.MiddleCenter;
            this.Controls.Add(lblPairCode);

            // Expiry
            lblExpiry = new Label();
            lblExpiry.Text = "Asking the bridge for the live code...";
            lblExpiry.Font = new Font("Segoe UI", 8.5f);
            lblExpiry.ForeColor = ColorMuted;
            lblExpiry.Location = new Point(20, 78);
            lblExpiry.Size = new Size(470, 18);
            lblExpiry.TextAlign = ContentAlignment.MiddleCenter;
            this.Controls.Add(lblExpiry);

            // Toggle: QR mã 1 lần (30 phút) hay QR master (vĩnh viễn)
            btnShowLive = new RoundedButton(ButtonKind.Primary);
            btnShowLive.Text = "One-time code";
            btnShowLive.Location = new Point(120, 102);
            btnShowLive.Size = new Size(130, 26);
            btnShowLive.Click += delegate { ShowQr(false); };
            this.Controls.Add(btnShowLive);

            btnShowMaster = new RoundedButton(ButtonKind.Ghost);
            btnShowMaster.Text = "⭐ Permanent code";
            btnShowMaster.Location = new Point(258, 102);
            btnShowMaster.Size = new Size(142, 26);
            btnShowMaster.Click += delegate { ShowQr(true); };
            this.Controls.Add(btnShowMaster);

            // QR vẽ bitmap khổ cố định (QrAsciiRenderer): ô vuông pixel nguyên
            // không anti-alias, viền lặng trắng 4 module đúng spec. Cỡ ảnh đặt
            // trong SetQrImage(); trước khi bridge trả mã thì khung trắng
            // FixedSingle giữ chỗ cho layout không nhảy.
            picQr = new PictureBox();
            picQr.BackColor = Color.White;
            picQr.BorderStyle = BorderStyle.FixedSingle;
            picQr.SizeMode = PictureBoxSizeMode.Normal;
            picQr.Location = new Point(0, 140);
            picQr.ClientSize = new Size(220, 220);
            this.Controls.Add(picQr);

            // Link ghép 1 lần
            lblPairUrlNote = new Label();
            lblPairUrlNote.Text = "One-time pairing link (safe to send over any app - tapping it signs you in):";
            lblPairUrlNote.Font = new Font("Segoe UI", 8.5f);
            lblPairUrlNote.ForeColor = ColorMuted;
            lblPairUrlNote.Location = new Point(24, 496);
            lblPairUrlNote.AutoSize = true;
            this.Controls.Add(lblPairUrlNote);

            txtPairUrl = new TextBox();
            txtPairUrl.Location = new Point(24, 514);
            txtPairUrl.Size = new Size(456, 24);
            txtPairUrl.BackColor = ColorCard;
            txtPairUrl.ForeColor = ColorText;
            txtPairUrl.BorderStyle = BorderStyle.FixedSingle;
            txtPairUrl.ReadOnly = true;
            this.Controls.Add(txtPairUrl);

            btnCopyUrl = new RoundedButton(ButtonKind.Primary);
            btnCopyUrl.Text = "📋 Copy pairing link";
            btnCopyUrl.Location = new Point(24, 544);
            btnCopyUrl.Size = new Size(200, 30);
            btnCopyUrl.Font = new Font("Segoe UI", 9f, FontStyle.Bold);
            btnCopyUrl.Click += delegate {
                if (!string.IsNullOrEmpty(livePairUrl))
                {
                    Clipboard.SetText(livePairUrl);
                    MessageBox.Show(this, "Pairing link copied to the clipboard!", "Done", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
            };
            this.Controls.Add(btnCopyUrl);

            // Master token
            lblMasterNote = new Label();
            lblMasterNote.Text = "⭐ Permanent code - DO NOT share, scan it only on this computer:";
            lblMasterNote.Font = new Font("Segoe UI", 8.5f);
            lblMasterNote.ForeColor = ColorMuted;
            lblMasterNote.Location = new Point(24, 586);
            lblMasterNote.AutoSize = true;
            this.Controls.Add(lblMasterNote);

            txtMasterUrl = new TextBox();
            txtMasterUrl.Location = new Point(24, 604);
            txtMasterUrl.Size = new Size(456, 24);
            txtMasterUrl.BackColor = ColorCard;
            txtMasterUrl.ForeColor = ColorText;
            txtMasterUrl.BorderStyle = BorderStyle.FixedSingle;
            txtMasterUrl.ReadOnly = true;
            this.Controls.Add(txtMasterUrl);

            btnCopyMaster = new RoundedButton(ButtonKind.Ghost);
            btnCopyMaster.Text = "📋 Copy master link";
            btnCopyMaster.Location = new Point(24, 634);
            btnCopyMaster.Size = new Size(200, 30);
            btnCopyMaster.Click += delegate {
                if (!string.IsNullOrEmpty(liveMasterUrl))
                {
                    Clipboard.SetText(liveMasterUrl);
                    MessageBox.Show(this, "Master link copied!", "Done", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
            };
            this.Controls.Add(btnCopyMaster);

            // Close Button
            btnClose = new RoundedButton(ButtonKind.Ghost);
            btnClose.Text = "Close";
            btnClose.Location = new Point(200, 668);
            btnClose.Size = new Size(120, 28);
            btnClose.Click += delegate { this.Close(); };
            this.Controls.Add(btnClose);

            // Lấy mã live từ bridge — SAU khi form có handle (Load event): gọi
            // Invoke từ ThreadPool trước khi ShowDialog tạo handle là sập app.
            int portAtLoad = port;
            string tokenAtLoad = token;
            this.Load += delegate {
                FetchLiveCode(portAtLoad, tokenAtLoad);
            };

            Relayout();
        }

        // Xếp lại toàn bộ khối dưới theo chiều cao QR thật + căn QR giữa khung.
        // QR giờ khổ cố định nên form không còn co giãn khi chuyển mã — Relayout
        // vẫn cần cho lần dựng form và lần ảnh đầu tiên về.
        private void Relayout()
        {
            int clientW = this.ClientSize.Width;
            picQr.Left = Math.Max(12, (clientW - picQr.Width) / 2);

            int y = picQr.Bottom + 22;
            lblPairUrlNote.Location = new Point(24, y);
            y += lblPairUrlNote.Height + 6;
            txtPairUrl.Location = new Point(24, y);
            y += txtPairUrl.Height + 10;
            btnCopyUrl.Location = new Point(24, y);
            y += btnCopyUrl.Height + 14;
            lblMasterNote.Location = new Point(24, y);
            y += lblMasterNote.Height + 6;
            txtMasterUrl.Location = new Point(24, y);
            y += txtMasterUrl.Height + 10;
            btnCopyMaster.Location = new Point(24, y);
            y += btnCopyMaster.Height + 16;
            btnClose.Location = new Point((clientW - btnClose.Width) / 2, y);
            this.ClientSize = new Size(clientW, btnClose.Bottom + 12);
        }

        private void ShowQr(bool master)
        {
            showingMaster = master;
            SetQrImage(master ? masterQr : liveQr);
            // Viên ĐANG CHỌN = nền đen chữ trắng; viên còn lại = nền trắng chữ đen
            // RoundedButton tự vẽ màu theo kind — toggle bằng SetKind: nút ĐANG chọn là
            // Primary (đen), nút còn lại Ghost (trắng viền nhạt)
            btnShowLive.SetKind(master ? ButtonKind.Ghost : ButtonKind.Primary);
            btnShowMaster.SetKind(master ? ButtonKind.Primary : ButtonKind.Ghost);
            Relayout();
        }

        // Dịch ASCII QR thành bitmap khổ cố định và thay ảnh của picQr. Ảnh rỗng
        // (chưa có mã / parse hụt) = khung trắng giữ chỗ — 2 nút copy link bên
        // dưới vẫn là lối ghép dự phòng, QR hỏng không chặn chết việc ghép máy.
        private void SetQrImage(string asciiQr)
        {
            int dpi;
            using (Graphics g = this.CreateGraphics()) { dpi = (int)g.DpiX; }
            Bitmap bmp = QrAsciiRenderer.RenderBitmap(asciiQr, dpi);
            Image old = picQr.Image;
            picQr.Image = bmp;
            if (bmp != null) picQr.ClientSize = bmp.Size;
            if (old != null) old.Dispose();
        }

        private void FetchLiveCode(int port, string mobileToken)
        {
            ThreadPool.QueueUserWorkItem(delegate {
                try
                {
                    string endpoint = string.Format("http://127.0.0.1:{0}/api/pairing-code", port);
                    var req = (HttpWebRequest)WebRequest.Create(endpoint);
                    req.Headers.Add("Authorization", "Bearer " + mobileToken);
                    req.Timeout = 4000;

                    using (var res = (HttpWebResponse)req.GetResponse())
                    using (var sr = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                    {
                        string json = sr.ReadToEnd();
                        var jss = new JavaScriptSerializer();
                        var dict = jss.Deserialize<Dictionary<string, object>>(json);

                        string codeFormatted = dict.ContainsKey("codeFormatted") ? Convert.ToString(dict["codeFormatted"]) : "?";
                        int secondsLeft = dict.ContainsKey("secondsLeft") ? Convert.ToInt32(dict["secondsLeft"]) : 1800;
                        livePairUrl = dict.ContainsKey("pairUrl") ? Convert.ToString(dict["pairUrl"]) : "";
                        liveMasterUrl = dict.ContainsKey("masterUrl") ? Convert.ToString(dict["masterUrl"]) : "";
                        liveQr = dict.ContainsKey("qr") ? Convert.ToString(dict["qr"]) : "";
                        masterQr = dict.ContainsKey("masterQr") ? Convert.ToString(dict["masterQr"]) : "";

                        Ui.SafeInvoke(this, delegate {
                            lblPairCode.Text = codeFormatted;
                            lblExpiry.Text = string.Format("The one-time code lives ~{0} minutes - scan it with your phone camera", Math.Ceiling(secondsLeft / 60.0));
                            txtPairUrl.Text = livePairUrl;
                            txtMasterUrl.Text = liveMasterUrl;
                            ShowQr(false);
                        });
                    }
                }
                catch (Exception ex)
                {
                    Ui.SafeInvoke(this, delegate {
                        lblPairCode.Text = "Could not read the code";
                        lblExpiry.Text = "Bridge returned an error: " + ex.Message;
                    });
                }
            });
        }
    }

    // ================= QR ASCII -> BITMAP =======================================
    // qrcode-terminal (small:true) in QR ra CHỮ theo ngữ nghĩa terminal nền
    // tối: ô ĐEN của dữ liệu = dấu cách, ô TRẮNG = ký tự mực (nguồn chân lý:
    // bridge/src/vendor/qrcode-terminal/index.js — palette WHITE_ALL='█',
    // WHITE_BLACK='▀', BLACK_WHITE='▄', BLACK_ALL=' '). GUI cũ vẽ nguyên bản
    // chữ đó = QR nghịch màu, phải nhờ máy quét tự xử lý đảo màu. Renderer
    // này đọc NGƯỢC về dữ liệu thật rồi vẽ đen-trắng chuẩn: QR bình thường
    // mọi máy quét đều ăn, viền lặng trắng 4 module đúng spec.
    internal static class QrAsciiRenderer
    {
        // Khổ mong muốn của cả canvas (đã gồm viền lặng), tính ở 96 DPI;
        // nhân theo DPI thật lúc vẽ để màn 125/150% không co QR lại.
        // 260px: mã 33 module ra cell 6px (246px), mã 41 module ra cell 5px
        // (245px) — 2 canvas lệch nhau 1px, mắt thường thấy cùng khổ.
        private const int TargetPx = 260;
        private const int QuietZone = 4; // module trắng mỗi bên (spec QR)

        public static Bitmap RenderBitmap(string ascii, int dpi)
        {
            bool[,] data = ParseDataModules(ascii);
            if (data == null) return null;

            int rows = data.GetLength(0), cols = data.GetLength(1);
            int modules = cols + QuietZone * 2;
            float scale = Math.Max(1f, dpi / 96f);
            int cell = Math.Max(2, (int)Math.Round(TargetPx * scale / modules));

            Bitmap bmp = new Bitmap(modules * cell, modules * cell);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                // FillRectangle trên biên pixel nguyên — sắc nét mặc định, không
                // bật anti-alias; 2 mã (số module khác nhau) ra canvas lệch nhau
                // vài px là chấp nhận được, đổi lại từng ô đều tròn trịa.
                g.Clear(Color.White);
                using (SolidBrush black = new SolidBrush(Color.Black))
                {
                    for (int r = 0; r < rows; r++)
                        for (int c = 0; c < cols; c++)
                            if (data[r, c])
                                g.FillRectangle(black,
                                    (c + QuietZone) * cell, (r + QuietZone) * cell,
                                    cell, cell);
                }
            }
            return bmp;
        }

        // Dịch ngược ASCII về lưới dữ liệu (true = ô ĐEN), bỏ 2 dòng viền trên/
        // dưới và 2 cột viền '█' hai bên mà vendor in quanh thân mã.
        private static bool[,] ParseDataModules(string ascii)
        {
            if (string.IsNullOrEmpty(ascii)) return null;
            string[] lines = ascii.Replace("\r", "").Split('\n');
            int last = lines.Length - 1;
            while (last >= 0 && lines[last].Length == 0) last--; // '\n' cuối chuỗi
            if (last < 2) return null;

            // Dòng đầu = viền trên; dòng cuối = viền dưới CHỈ khi vendor in nó
            // (số module chẵn — dòng đó toàn '▀'). Dòng thân luôn bắt đầu '█'
            // nên không bao giờ lẫn với viền.
            int to = last;
            if (IsAll(lines[to], '\u2580')) to--;
            if (to < 1) return null;

            int lineLen = lines[1].Length;
            int cols = lineLen - 2; // trừ cột viền '█' trái + phải
            if (cols <= 0) return null;

            // Mỗi dòng chữ chứa 2 hàng module (ký tự nửa khối) → lưới cao to*2;
            // module lẻ thì vendor đệm 1 hàng trắng nên lưới có thể dư đúng 1.
            bool[,] grid = new bool[to * 2, cols];
            for (int i = 1; i <= to; i++)
            {
                string line = lines[i];
                if (line.Length != lineLen) return null;
                for (int c = 0; c < cols; c++)
                {
                    switch (line[c + 1]) // +1: bỏ cột viền trái
                    {
                        case ' ':           // BLACK_ALL — cả hai ô đen
                            grid[2 * (i - 1), c] = true;
                            grid[2 * (i - 1) + 1, c] = true;
                            break;
                        case '\u2580':      // WHITE_BLACK — trên trắng, dưới đen
                            grid[2 * (i - 1) + 1, c] = true;
                            break;
                        case '\u2584':      // BLACK_WHITE — trên đen, dưới trắng
                            grid[2 * (i - 1), c] = true;
                            break;
                        // '\u2588' (WHITE_ALL) và ký tự lạ: trắng, không gán
                    }
                }
            }

            // Module lẻ: vendor đệm đúng 1 hàng trắng cuối — cắt các hàng trắng
            // đuôi cho lưới đúng vuông mc×mc. endRow đếm theo HÀNG MODULE
            // (to*2), vòng while dừng NGAY khi chạm hàng có dữ liệu (dùng for
            // kèm endRow-- ở post-statement là bị trừ thừa 1 nhát khi break).
            int endRow = to * 2;
            while (endRow > 0)
            {
                bool anyBlack = false;
                for (int c = 0; c < cols; c++)
                    if (grid[endRow - 1, c]) { anyBlack = true; break; }
                if (!anyBlack) endRow--; else break;
            }
            if (endRow != cols) return null; // QR phải vuông — lệch là parse hỏng

            bool[,] square = new bool[endRow, cols];
            Array.Copy(grid, square, endRow * cols);
            return square;
        }

        private static bool IsAll(string s, char ch)
        {
            if (s.Length == 0) return false;
            foreach (char c in s)
                if (c != ch) return false;
            return true;
        }
    }
}
