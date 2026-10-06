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
    // GUI chỉ vẽ lại bằng font monospace, KHÔNG gửi mã ghép cho API QR ngoài.

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

        private Label lblQrRender;
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

            // QR render ASCII (nền trắng, chữ đen — font monospace giữ khối vuông).
            // KHÔNG ghim Left: ASCII mã master dài hơn mã 1 lần nên Width thay đổi —
            // Relayout() căn giữa theo Width thật sau mỗi lần đổi text (trước đây
            // cứng x=95 → mã lệch trái, cả khối link dưới bị ghim y=496 dù QR chỉ
            // cao ~330px → hụt một mảng trống lớn giữa QR và link)
            lblQrRender = new Label();
            lblQrRender.Text = "\n\n   Loading QR from the bridge...";
            lblQrRender.Font = new Font("Consolas", 7.5f);
            lblQrRender.BackColor = Color.White;
            lblQrRender.ForeColor = Color.Black;
            lblQrRender.Location = new Point(0, 140);
            lblQrRender.AutoSize = true;
            this.Controls.Add(lblQrRender);

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
        // QR 1 lần và master khác nhau cả rộng lẫn cao → không thể ghim tọa độ
        // cứng; form cũng tự co/giãn theo nội dung (FixedDialog nên vẫn đẹp)
        private void Relayout()
        {
            int clientW = this.ClientSize.Width;
            lblQrRender.Left = Math.Max(12, (clientW - lblQrRender.Width) / 2);

            int y = lblQrRender.Bottom + 22;
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
            string qrText = master ? masterQr : liveQr;
            lblQrRender.Text = string.IsNullOrEmpty(qrText) ? "\n\n   (no QR yet)" : qrText;
            // Viên ĐANG CHỌN = nền đen chữ trắng; viên còn lại = nền trắng chữ đen
            // RoundedButton tự vẽ màu theo kind — toggle bằng SetKind: nút ĐANG chọn là
            // Primary (đen), nút còn lại Ghost (trắng viền nhạt)
            btnShowLive.SetKind(master ? ButtonKind.Ghost : ButtonKind.Primary);
            btnShowMaster.SetKind(master ? ButtonKind.Primary : ButtonKind.Ghost);
            Relayout();
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
}
