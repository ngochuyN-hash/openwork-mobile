using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Security.Cryptography;
using System.Threading;
using System.Management;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace OpenPocket.Desktop
{
    static class Program
    {
        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }

    public class MainForm : Form
    {
        // Colors — TOKEN SKILL UI (pwa-workspace-ui/references/tokens.md 13/09):
        // nền trắng, thẻ trắng, viền hairline, nút chính ĐEN, chấm trạng thái
        // mới là điểm màu — KHÔNG còn xanh/đỏ bão hòa trên thân nút (nút vào
        // component RoundedButton tự vẽ: Primary đen / Ghost viền / viền đỏ).
        private static readonly Color ColorCard = Color.White;                          // #FFFFFF
        private static readonly Color ColorCardBorder = Color.FromArgb(228, 231, 236);  // #E4E7EC hairline
        private static readonly Color ColorStroke = Color.FromArgb(211, 216, 222);      // #D3D8DE viền đậm (ghost)
        private static readonly Color ColorText = Color.FromArgb(28, 32, 36);           // #1C2024
        private static readonly Color ColorMuted = Color.FromArgb(96, 100, 108);        // #60646C text-dim
        private static readonly Color ColorFaint = Color.FromArgb(139, 141, 152);       // #8B8D98 text-faint
        private static readonly Color ColorPrimary = Color.FromArgb(28, 32, 36);        // #1C2024 nút chính ĐEN
        private static readonly Color ColorHover = Color.FromArgb(238, 241, 244);       // #EEF1F4 bg-hover / nút khoá
        private static readonly Color ColorSuccess = Color.FromArgb(48, 164, 108);      // #30A46C — chỉ đèn + chữ trạng thái
        private static readonly Color ColorDanger = Color.FromArgb(214, 69, 69);        // #D64545 — chỉ đèn + viền Dừng
        private static readonly Color ColorAmber = Color.FromArgb(180, 83, 9);          // #B45309 cảnh báo trên nền sáng

        // State
        private System.Windows.Forms.Timer refreshTimer;
        private bool isBridgeRunning = false;
        private string tunnelUrl = "";
        private string currentTenant = "";
        private string bridgeDir = "";
        private string nodeExe = "";
        // 1 PC, hết tài khoản: lần đầu mở app, app TỰ cấp định danh máy (room
        // ngầm + mật khẩu ngầm qua /api/tenant/create) — người dùng chỉ bấm
        // Bật và quét QR. Bridge KHÔNG còn dependency npm nào (qrcode-terminal
        // đã vendor thành src trong bridge/src/vendor) — không cần node_modules.
        private bool provisioning = false;
        private bool provisionDone = false;
        // Lỗi provision KHÔNG nuốt âm thầm nữa: giữ message + hiện lên hàng
        // trạng thái riêng với nút thử lại (audit pass này).
        private string provisionError = "";
        // Vừa tạo định danh xong mà bridge đang chạy: gợi ý khởi động lại để
        // bridge nạp identity mới (điện thoại mới thấy được máy).
        private bool provisionHintRestart = false;

        // Bấm X = ẩn xuống khay chạy nền (owner yêu cầu 13/09); thoát hẳn chỉ
        // qua menu chuột phải của icon khay
        private NotifyIcon trayIcon;
        private bool reallyExit = false;
        private bool balloonShown = false;
        private ToolTip tipAdmin;
        // Tint nền pill badge admin — vẽ ở pnlHeader.Paint (trẻ vẽ đè sau nên
        // chữ không bị fill phủ); BackColor của label để trong suốt
        private Color badgeTint = Color.FromArgb(220, 252, 231);

        // ================= NÚT BO GÓC KHỬ RĂNG CƯA =================
        // Region cắt cứng (cũ) không có AntiAlias nên góc bo thành bậc thang —
        // owner 13/09 tối: "bị răng cưa như đè nhiều box hình chữ nhật lên
        // vậy". Một component duy nhất cho mọi nút: radius 8, thân/viền tự vẽ
        // bằng GraphicsPath có AntiAlias, nền control trắng hoà vào thẻ.
        // Ngôn ngữ theo skill UI: Primary = nền đen chữ trắng; Ghost = nền
        // trắng viền đậm mảnh; DangerGhost = nền trắng viền đỏ chữ đỏ; khóa
        // = nhạt hẳn mất màu vai (đèn trạng thái mới giữ màu).
        internal enum ButtonKind { Primary, Ghost, DangerGhost, SuccessGhost, InlineIcon }

        internal class RoundedButton : Control
        {
            // Token skill UI — bản riêng để dialog (class lồng cùng cha) dùng
            // được mà không đụng bảng màu của MainForm
            private static readonly Color CCard = Color.White;
            private static readonly Color CPrimary = Color.FromArgb(28, 32, 36);     // #1C2024
            private static readonly Color CPrimaryHover = Color.FromArgb(52, 57, 63);
            private static readonly Color CText = Color.FromArgb(28, 32, 36);
            private static readonly Color CStroke = Color.FromArgb(211, 216, 222);   // #D3D8DE
            private static readonly Color CHairline = Color.FromArgb(228, 231, 236); // #E4E7EC
            private static readonly Color CHover = Color.FromArgb(238, 241, 244);    // #EEF1F4
            private static readonly Color CFaint = Color.FromArgb(139, 141, 152);    // #8B8D98
            private static readonly Color CMuted = Color.FromArgb(96, 100, 108);     // #60646C
            private static readonly Color CDanger = Color.FromArgb(214, 69, 69);     // #D64545
            private static readonly Color CDangerHover = Color.FromArgb(252, 240, 240);
            private static readonly Color CSuccess = Color.FromArgb(48, 164, 108);   // #30A46C
            private static readonly Color CSuccessHover = Color.FromArgb(240, 250, 245);

            private ButtonKind kind; // SetKind() đổi kind lúc chạy (toggle dialog QR)
            private Color fill, stroke, textColor;
            private bool hover;
            // Bán kính bo góc — icon tròn để = chiều cao/2
            public int Radius = 8;

            // Dựng trên Control THUẦN, không phải Button: ButtonBase cứ tự vẽ
            // nền/viền/focus-rect sau lưng OnPaint — trên máy owner hằn vết
            // vuông đen ở góc mỗi nút (13/09 tối). Control tự vẽ 100% thì
            // không lớp nào chen vào nữa.
            public RoundedButton(ButtonKind kind)
            {
                this.kind = kind;
                BackColor = CCard;
                Cursor = Cursors.Hand;
                TabStop = false;
                SetStyle(ControlStyles.AllPaintingInWmPaint |
                    ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint |
                    ControlStyles.ResizeRedraw, true);
                ApplyLook(true);
            }

            // Đổi kind lúc chạy (dialog QR toggle "Mã 1 lần" ↔ "Mã vĩnh viễn" —
            // trước đây nút Button đảo BackColor tay, RoundedButton tự vẽ nên
            // phải tái áp màu qua kind)
            public void SetKind(ButtonKind kind)
            {
                this.kind = kind;
                ApplyLook(true);
            }

            // Enabled đổi cả MÀU THÂN — FlatStyle giữ màu nền khi Enabled=false
            // (bài học pass 5) nên trạng thái khoá phải tự vẽ lại
            public void ApplyLook(bool on)
            {
                if (on)
                {
                    fill = CCard;
                    if (kind == ButtonKind.Primary)
                    {
                        fill = CPrimary; stroke = CPrimary; textColor = Color.White;
                    }
                    else if (kind == ButtonKind.DangerGhost)
                    {
                        stroke = CDanger; textColor = CDanger;
                    }
                    else if (kind == ButtonKind.SuccessGhost)
                    {
                        stroke = CSuccess; textColor = CSuccess;
                    }
                    else if (kind == ButtonKind.InlineIcon)
                    {
                        // Icon ẩn danh nằm trong dòng chữ: KHÔNG viền, glyph xám
                        // nhã — hover mới nổi nền tròn mờ (không hòa viền vào
                        // thiết kế — owner 14/09 sáng)
                        stroke = Color.Transparent; textColor = CMuted;
                    }
                    else
                    {
                        stroke = CStroke; textColor = CText;
                    }
                }
                else
                {
                    fill = kind == ButtonKind.Primary ? CHover : CCard;
                    stroke = (kind == ButtonKind.Primary || kind == ButtonKind.InlineIcon)
                        ? Color.Transparent : CHairline;
                    textColor = CFaint;
                }
                ForeColor = textColor;
                Invalidate();
            }

            protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
            protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }

            // Base Button vẽ nền+viền flat-style trước OnPaint — viền vuông đen
            // đó bị fill bo đè mất giữa, chỉ hở 4 góc thành "răng" đen. Tự lấp
            // nền trắng phẳng, không cho base vẽ gì thêm.
            protected override void OnPaintBackground(PaintEventArgs e)
            {
                using (SolidBrush b = new SolidBrush(BackColor))
                    e.Graphics.FillRectangle(b, 0, 0, Width, Height);
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                // Path thụt 1px để nét viền không bị mép control cắt mất nửa nét
                using (System.Drawing.Drawing2D.GraphicsPath p = MainForm.RoundedPath(Width - 1, Height - 1, Radius))
                {
                    Color f = (Enabled && hover) ? HoverFill() : fill;
                    using (SolidBrush b = new SolidBrush(f)) e.Graphics.FillPath(b, p);
                    using (Pen pen = new Pen(stroke)) e.Graphics.DrawPath(pen, p);
                }
                TextRenderer.DrawText(e.Graphics, Text, Font, new Rectangle(0, 0, Width, Height),
                    Enabled ? textColor : CFaint,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter |
                    TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis);
            }

            private Color HoverFill()
            {
                if (kind == ButtonKind.Primary) return CPrimaryHover;
                if (kind == ButtonKind.DangerGhost) return CDangerHover;
                if (kind == ButtonKind.SuccessGhost) return CSuccessHover;
                return CHover;
            }
        }

        // Icon app: đúng hình khối OpenWork (lục giác bo isometric + lỗ O +
        // sọc chéo) nhưng ĐẢO MÀU — nét trắng trên nền đen (owner chỉ định
        // 13/09, rasterize từ web/public/openwork-mark.svg). Nguồn chân lý là
        // src\app.ico nhúng vào exe qua /win32icon; lúc chạy bấm lại từ exe để
        // title bar / khay / dialog QR dùng chung một nguồn.
        static Icon _appIcon;
        internal static Icon AppIcon
        {
            get
            {
                if (_appIcon == null)
                {
                    try { _appIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
                    catch { }
                    if (_appIcon == null)
                    {
                        // fallback hiếm hoi: vòng O trắng nền đen (bản rút gọn)
                        Bitmap bmp = new Bitmap(32, 32);
                        using (Graphics g = Graphics.FromImage(bmp))
                        {
                            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                            using (SolidBrush bg = new SolidBrush(Color.FromArgb(24, 24, 27)))
                            using (System.Drawing.Drawing2D.GraphicsPath path = RoundedPath(32, 32, 8))
                            {
                                g.FillPath(bg, path);
                            }
                            using (Pen ring = new Pen(Color.White, 5f))
                            {
                                g.DrawEllipse(ring, 7, 7, 18, 18);
                            }
                        }
                        _appIcon = Icon.FromHandle(bmp.GetHicon());
                    }
                }
                return _appIcon;
            }
        }

        // UI Controls - Header
        private Label lblAdminBadge;
        private Panel pnlHeader;

        // UI Controls - single page
        private Panel pnlContent;
        private Panel cardStatus;
        private Panel cardConfig;
        private Panel cardPair;
        private Label lblStatusBridge;
        private Label lblStatusTunnel;
        private Label lblStatusTunnelUrl;
        private Label lblStatusOpenWork;
        private RoundedButton btnStartBridge;
        private RoundedButton btnStopBridge;
        private RoundedButton btnRestartBridge;
        private RoundedButton btnTunnelRestart;
        private RoundedButton btnShowQr;
        private RoundedButton btnOpenLogs;
        private CheckBox chkAutostart;
        // Hàng định danh máy (provision): trạng thái + nút thử lại khi lỗi
        private Label lblProvision;
        private RoundedButton btnProvisionRetry;

        public MainForm()
        {
            InitializeComponent();
            ResolvePaths();
            EnsureConfigDefaults();
            LoadConfigToUi();
            BeginProvisionIfNeeded();
            CheckStatus();

            // Badge admin: kiểm tra thật bằng WindowsPrincipal (manifest đòi
            // requireAdministrator nhưng task scheduler / compatibility mode
            // vẫn có thể hạ quyền — hiện đúng trạng thái để khỏi tự hù).
            bool isAdmin = new System.Security.Principal.WindowsPrincipal(
                System.Security.Principal.WindowsIdentity.GetCurrent()
            ).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
            lblAdminBadge.Text = isAdmin ? "ADMIN (ELEVATED)" : "ADMIN RIGHTS MISSING";
            lblAdminBadge.ForeColor = isAdmin ? Color.FromArgb(21, 128, 61) : ColorAmber;
            badgeTint = isAdmin ? Color.FromArgb(220, 252, 231) : Color.FromArgb(254, 243, 199);
            pnlHeader.Invalidate(); // pill vẽ ở parent — phải vẽ lại header
            // Text đổi → AutoSize đổi bề rộng → neo lại once lúc mở
            lblAdminBadge.Left = pnlHeader.Width - lblAdminBadge.Width - 16;
            lblAdminBadge.Top = (pnlHeader.Height - lblAdminBadge.Height) / 2;

            // Badge phải NÊU CÁCH SỬA, không chỉ báo động (audit 13/09): rê
            // chuột lên là biết thiếu quyền thì hỏng gì và lấy lại bằng cách nào.
            tipAdmin = new ToolTip();
            tipAdmin.SetToolTip(lblAdminBadge, isAdmin
                ? "Running with Administrator rights — can control every window, including ones running as Admin."
                : "Missing Admin rights: windows running as Admin cannot be controlled. Quit completely (tray icon) and relaunch OpenPocket.exe manually, accepting the UAC prompt.");
            // Icon ↻ thay chữ — nghĩa của nút chuyển sang tooltip
            tipAdmin.SetToolTip(btnTunnelRestart, "Reopen the Cloudflare tunnel right away — without waiting for the 429 counter");
            tipAdmin.SetToolTip(btnProvisionRetry, "Recreate the machine identity (room + hidden password) — use when the first attempt failed");

            refreshTimer = new System.Windows.Forms.Timer();
            refreshTimer.Interval = 3500;
            refreshTimer.Tick += delegate { CheckStatus(); };
            refreshTimer.Start();
        }

        private void ResolvePaths()
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            // Tìm bridge dir
            string[] bridgeCandidates = new string[] {
                Path.Combine(baseDir, "bridge"),
                Path.Combine(baseDir, "..", "bridge"),
                Path.Combine(baseDir, "..", "..", "bridge"),
                baseDir
            };
            foreach (string b in bridgeCandidates)
            {
                if (File.Exists(Path.Combine(b, "src", "index.js")))
                {
                    bridgeDir = Path.GetFullPath(b);
                    break;
                }
            }

            // Bridge zero-dependency (qrcode-terminal đã vendor trong
            // bridge/src/vendor) — không cần node_modules, chỉ cần node.exe
            // để CHẠY. Thiếu gì Bật Bridge cũng báo rõ (EnsureBridgeDepsPresent).

            // Tìm node.exe
            nodeExe = FindNodeExe();
        }

        private void InitializeComponent()
        {
            this.Text = "OpenPocket - Control OpenWork from your phone";
            // MỘT cột, nền trắng toàn phần: TRẠNG THÁI (đèn kết nối) → tự khởi
            // động (cấu hình duy nhất còn lại) → hành động. Client 496x396 =
            // header 48 + trạng thái 188 + kẽ 8 + hàng tự-khởi-động 24 + kẽ 8
            // + hành động 120. BỀ RỘNG giữ khổ 512 cũ (owner 13/09 tối: không
            // thu hẹp, phải CÂN ĐỐI 2 bên). Lưới spacing 8px: 8px trong nhóm,
            // 12px giữa dòng, 24px giữa nhóm, lề 16 hai bên, nút đồng nhất
            // cao 40. Lịch sử 13/09: ô Tên máy thêm đêm (be8344e) xoá ngay khi
            // owner thấy — "mỗi người sở hữu cái này là 1 người dùng rồi,
            // phân như vậy làm gì đâu"; nút theo skill UI (Primary đen /
            // Ghost viền / viền đỏ cho Dừng), tự vẽ AntiAlias hết răng cưa.
            // Mọi hàng nút/ô dàn ĐẦY bề ngang bằng RelayoutContent().
            this.ClientSize = new Size(496, 396);
            this.MinimumSize = this.Size;
            this.StartPosition = FormStartPosition.CenterScreen;
            // Nền TRẮNG toàn phần (owner 13/09: "gọt sạch hết còn nền trắng
            // thôi") — nền xám F4 từng lộ thành dải sáng nhạt bất đối xứng
            this.BackColor = ColorCard;
            this.ForeColor = ColorText;
            this.Font = new Font("Segoe UI", 9.75f, FontStyle.Regular);
            this.Icon = SystemIcons.Application;

            // Nội dung một cột: thẻ trạng thái + thẻ QR. pnlContent thêm vào form
            // TRƯỚC, header thêm SAU — dock xử lý theo index giảm dần nên header
            // lấy mép Top trước, content Fill phần còn lại (bài học header chìm).
            Panel pnlContent = new Panel();
            pnlContent.Dock = DockStyle.Fill;
            // Padding 0: thẻ trắng chạm mép cửa sổ, không còn viền xám nào
            pnlContent.Padding = new Padding(0);
            this.pnlContent = pnlContent;

            int yL = 0;
            cardStatus = CreateCard(0, ref yL, 496, 188, pnlContent);
            CreateCardTitle("CONNECTION STATUS", cardStatus);

            lblStatusBridge = CreateStatusLabel("● Bridge: Checking...", 16, 39, cardStatus);
            lblStatusBridge.Size = new Size(448, 22);
            lblStatusBridge.Font = new Font("Segoe UI", 9.75f);

            lblStatusTunnel = CreateStatusLabel("● Cloudflare Tunnel: Checking...", 16, 71, cardStatus);
            lblStatusTunnel.Size = new Size(448, 22);
            lblStatusTunnel.Font = new Font("Segoe UI", 9.75f);
            lblStatusTunnelUrl = new Label();
            lblStatusTunnelUrl.Text = "(fetching the public address...)";
            lblStatusTunnelUrl.Font = new Font("Consolas", 9f);
            lblStatusTunnelUrl.ForeColor = ColorText;
            lblStatusTunnelUrl.Location = new Point(32, 97);
            // Cao 18 (1 dòng): khổ full-width 464px chứa thoải mái URL ~57 ký
            // tự và hint 429 — lỡ dành 2 dòng là hở một băng trắng lớn giữa
            // các dòng trạng thái (owner 13/09: "khoảng trống lệch nhau quá")
            lblStatusTunnelUrl.Size = new Size(432, 18);
            cardStatus.Controls.Add(lblStatusTunnelUrl);

            // Restart tunnel CHỦ ĐỘNG (owner 13/09: bộ đếm backoff 429 "hên xui"):
            // xin tunnel mới ngay không đợi hẹn — bridge vẫn sống, chỉ cloudflared
            // được thay. Vô hiệu khi bridge dừng (CheckStatus khoá theo đèn xanh).
            // Nút restart tunnel = ICON TRÒN KHÔNG VIỀN (owner 14/09: "bỏ viền
            // đi… nhìn nút đó như không hòa được với thiết kế") — glyph ↻ xám
            // nằm hoà vào dòng, rê chuột mới nổi nền tròn mờ; nghĩa để tooltip
            btnTunnelRestart = CreateButton("\uE72C", ButtonKind.InlineIcon, 360, 68, 24, 24, cardStatus);
            btnTunnelRestart.Font = new Font("Segoe MDL2 Assets", 10f);
            btnTunnelRestart.Radius = 12;
            btnTunnelRestart.Click += delegate { ActionRestartTunnel(); };
            // Label tunnel tạo TRƯỚC nút nên nằm TRÊN (z-order theo thứ tự add,
            // index 0 đỉnh) — bề rộng 448 ban đầu của label đè trắng nút; kéo
            // nút lên đỉnh để không bao giờ bị nền label che
            btnTunnelRestart.BringToFront();

            lblStatusOpenWork = CreateStatusLabel("● OpenWork Desktop: Checking...", 16, 127, cardStatus);
            lblStatusOpenWork.Size = new Size(448, 22);
            lblStatusOpenWork.Font = new Font("Segoe UI", 9.75f);

            // Hàng ĐỊNH DANH MÁY (provision): lỗi lần đầu từng bị nuốt SILENT —
            // đèn Bridge vẫn xanh nhưng máy không bao giờ hiện trên điện thoại.
            // Lỗi giờ hiện chữ đỏ + nút ↻ thử lại ngay trên thẻ trạng thái;
            // máy đã ghép ngon thì hàng này tự ẩn (UpdateProvisionStatus).
            lblProvision = CreateStatusLabel("● Machine identity: checking...", 16, 159, cardStatus);
            lblProvision.Size = new Size(424, 20);
            lblProvision.AutoEllipsis = true;
            btnProvisionRetry = CreateButton("\uE72C", ButtonKind.InlineIcon, 456, 157, 24, 24, cardStatus);
            btnProvisionRetry.Font = new Font("Segoe MDL2 Assets", 10f);
            btnProvisionRetry.Radius = 12;
            btnProvisionRetry.Click += delegate { ActionRetryProvision(); };

            // Hàng TỰ KHỞI ĐỘNG: cấu hình DUY NHẤT còn lại của cửa sổ (owner
            // 13/09 đêm: "mỗi người sở hữu cái này là 1 người dùng rồi" — cụm
            // CẤU HÌNH MÁY + ô Tên máy bị xoá sập vì vô nghĩa khi phát cho
            // người khác; tên định danh máy vẫn tồn tại ngầm trong config cho
            // điện thoại đọc, chỉ hết chỗ trên GUI). Không cần tiêu đề khối —
            // checkbox tự giải thích.
            yL += 8;
            cardConfig = CreateCard(0, ref yL, 496, 24, pnlContent);
            chkAutostart = new CheckBox();
            chkAutostart.Text = "Start with Windows (hidden, Admin rights)";
            chkAutostart.ForeColor = ColorText;
            chkAutostart.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);
            chkAutostart.Location = new Point(16, 3);
            chkAutostart.AutoSize = true;
            chkAutostart.CheckedChanged += OnAutostartChanged;
            cardConfig.Controls.Add(chkAutostart);

            // Thẻ HÀNH ĐỘNG: hàng nút bridge trước (quy trình: bật bridge rồi
            // mới ghép máy), hàng QR sau — QR ĐEN rộng nhất là nút chủ đạo.
            // Mọi nút đồng nhất cao 40 cho đều nhịp dọc. "Dừng" là nút PHÁ HỎY
            // nên hạ vai + tách mép phải (ux-layout-rules 13/09: solid đỏ đứng
            // giữa hàng giật attention khỏi QR, ngang vai nút lành) — ghost
            // viền đỏ chữ đỏ trên nền trắng, khoá thì về xám như mọi nút.
            cardPair = CreateCard(0, ref yL, 496, 120, pnlContent);

            btnStartBridge = CreateButton("Start Bridge", ButtonKind.SuccessGhost, 16, 14, 149, 40, cardPair);
            btnStartBridge.Font = new Font("Segoe UI", 10f, FontStyle.Bold);
            btnStartBridge.Click += delegate { ActionStartBridge(); };

            btnRestartBridge = CreateButton("Restart", ButtonKind.Ghost, 173, 14, 149, 40, cardPair);
            btnRestartBridge.Font = new Font("Segoe UI", 10f);
            btnRestartBridge.Click += delegate { ActionRestartBridge(); };

            btnStopBridge = CreateButton("Stop", ButtonKind.DangerGhost, 330, 14, 150, 40, cardPair);
            btnStopBridge.Font = new Font("Segoe UI", 10f);
            btnStopBridge.Click += delegate { ActionStopBridge(); };

            btnShowQr = CreateButton("View pairing code (QR)", ButtonKind.Primary, 16, 66, 304, 40, cardPair);
            btnShowQr.Font = new Font("Segoe UI", 10f, FontStyle.Bold);
            btnShowQr.Click += delegate { ActionShowPairingDialog(); };

            btnOpenLogs = CreateButton("View logs", ButtonKind.Ghost, 328, 66, 152, 40, cardPair);
            btnOpenLogs.Font = new Font("Segoe UI", 10f);
            btnOpenLogs.Click += delegate { ActionOpenLogs(); };

            // Header thanh mảnh kiểu OpenWork: trắng, tên app + badge bên phải,
            // ngăn với content bằng đường kẻ 1px. Pill badge vẽ ở PARENT (con
            // vẽ đè sau nên chữ không bị fill phủ) — Label chỉ giữ chữ trong
            // suốt, hết cảnh hộp chữ nhật góc vuông (audit UI 13/09 tối)
            pnlHeader = new Panel();
            pnlHeader.Dock = DockStyle.Top;
            pnlHeader.Height = 48;
            pnlHeader.BackColor = ColorCard;
            pnlHeader.Paint += delegate(object s, PaintEventArgs e) {
                e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                using (Pen pen = new Pen(ColorCardBorder)) {
                    e.Graphics.DrawLine(pen, 0, pnlHeader.Height - 1, pnlHeader.Width, pnlHeader.Height - 1);
                }
                // Pill badge: radius = nửa chiều cao (pill 999 của skill)
                using (System.Drawing.Drawing2D.GraphicsPath p = RoundedPath(
                    lblAdminBadge.Width - 1, lblAdminBadge.Height - 1, (lblAdminBadge.Height - 1) / 2))
                using (SolidBrush b = new SolidBrush(badgeTint)) {
                    e.Graphics.TranslateTransform(lblAdminBadge.Left, lblAdminBadge.Top);
                    e.Graphics.FillPath(b, p);
                    e.Graphics.ResetTransform();
                }
            };

            // Header chỉ còn tên app — mô tả đã có ở title bar cửa sổ, lặp lại
            // cách nhau 40px là chữ thừa (audit 13/09). Căn giữa dọc thanh 48.
            Label lblTitle = new Label();
            lblTitle.Text = "OpenPocket";
            lblTitle.Font = new Font("Segoe UI", 13f, FontStyle.Bold);
            lblTitle.ForeColor = ColorText;
            lblTitle.Location = new Point(20, 12);
            lblTitle.AutoSize = true;
            pnlHeader.Controls.Add(lblTitle);

            lblAdminBadge = new Label();
            lblAdminBadge.Text = "ADMIN (ELEVATED)";
            lblAdminBadge.Font = new Font("Segoe UI", 8f, FontStyle.Bold);
            lblAdminBadge.ForeColor = ColorSuccess;
            lblAdminBadge.BackColor = Color.Transparent; // pill do pnlHeader vẽ
            lblAdminBadge.Padding = new Padding(8, 4, 8, 4);
            lblAdminBadge.AutoSize = true;
            // Neo phải động — form 536 không đủ chỗ cho toạ độ cứng x=524 của
            // bản 680; badge luôn dính mép phải ở mọi bề rộng
            pnlHeader.Resize += delegate {
                lblAdminBadge.Left = pnlHeader.Width - lblAdminBadge.Width - 16;
                lblAdminBadge.Top = (pnlHeader.Height - lblAdminBadge.Height) / 2;
            };
            pnlHeader.Controls.Add(lblAdminBadge);

            this.Controls.Add(pnlContent);
            this.Controls.Add(pnlHeader);

            // Cân đối động: panel nội dung đổi bề rộng (lần đầu hiện form, kéo
            // cửa sổ) là hàng nút dàn lại đầy chiều ngang — không bao giờ trở
            // lại cảnh cụm nút lệch trái, hụt phải
            pnlContent.Resize += delegate { RelayoutContent(); };

            // Icon app + khay hệ thống: X chỉ ẩn xuống khay, "Thoát hẳn" mới
            // kết thúc app (owner yêu cầu 13/09 — tắt cửa sổ mà bridge theo dõi
            // vẫn chạy nền)
            this.Icon = AppIcon;
            trayIcon = new NotifyIcon();
            trayIcon.Icon = AppIcon;
            trayIcon.Text = "OpenPocket - Control OpenWork from your phone";
            trayIcon.Visible = true;
            ContextMenuStrip trayMenu = new ContextMenuStrip();
            trayMenu.Items.Add("Open OpenPocket", null, delegate { ShowFromTray(); });
            trayMenu.Items.Add("Quit completely", null, delegate {
                reallyExit = true;
                // Log không giữ ở máy (owner 13/09): bridge vẫn chạy nền nên chỉ
                // truncate được — mấy dòng nó ghi sau đó là của ngày mới.
                WipeLogFiles(false);
                this.Close();
            });
            trayIcon.ContextMenuStrip = trayMenu;
            trayIcon.DoubleClick += delegate { ShowFromTray(); };

            this.FormClosing += delegate(object s, FormClosingEventArgs e) {
                if (!reallyExit && e.CloseReason == CloseReason.UserClosing)
                {
                    e.Cancel = true;
                    this.Hide();
                    if (!balloonShown)
                    {
                        balloonShown = true;
                        trayIcon.BalloonTipTitle = "OpenPocket is still running";
                        trayIcon.BalloonTipText = "Hidden to the system tray - double-click the icon to reopen, right-click and choose Quit completely to exit.";
                        trayIcon.ShowBalloonTip(4000);
                    }
                }
            };
            this.FormClosed += delegate {
                trayIcon.Visible = false;
                trayIcon.Dispose();
            };
        }

        // Dàn lại bố cục theo bề rộng thật của panel nội dung: thẻ kéo full
        // width, hai hàng nút chia đều hết chiều ngang (lề 16, kẽ 8). Gọi mỗi
        // lần pnlContent Resize — Region bo góc của nút phải dựng lại theo
        // bề rộng mới nên Round() được gọi lại ở đây.
        private void RelayoutContent()
        {
            int cw = pnlContent.ClientSize.Width;
            int inner = cw - 32;
            if (inner < 240) return;

            cardStatus.Width = cw;
            cardConfig.Width = cw;
            cardPair.Width = cw;
            lblStatusBridge.Width = inner;
            // Nút Restart tunnel đứng CÙNG HÀNG chữ "Cloudflare Tunnel:" — URL
            // là một từ liền không có khoảng trắng, Label không tự wrap được,
            // nên nhường URL nguyên hàng full-width (13/09 tối)
            lblStatusTunnel.Width = inner - 132;
            lblStatusOpenWork.Width = inner;
            lblStatusTunnelUrl.Width = inner;
            lblProvision.Width = inner - 32;
            btnProvisionRetry.Left = 16 + inner - 24;
            PlaceTunnelRestart();

            int gap = 8;
            int bw = (inner - 2 * gap) / 3;
            // Hàng bridge: Bật Bridge | Khởi động lại | Dừng — nút phá hủy đón
            // mép phải, xa nhất so với nút bật (ux-layout-rules 13/09)
            btnStartBridge.SetBounds(16, 14, bw, 40);
            btnRestartBridge.SetBounds(16 + bw + gap, 14, bw, 40);
            btnStopBridge.SetBounds(16 + 2 * (bw + gap), 14, inner - 2 * (bw + gap), 40);

            // QR chiếm 2/3 hàng dưới — nút chủ đạo về kích thước; nhật ký là
            // tiện ích phụ nên nhường bề rộng
            int qw = (inner - gap) * 2 / 3;
            btnShowQr.SetBounds(16, 66, qw, 40);
            btnOpenLogs.SetBounds(16 + qw + gap, 66, inner - qw - gap, 40);
        }

        // Mở lại cửa sổ từ khay: hiện + khôi phục nếu đang thu nhỏ + kéo lên trước
        private void ShowFromTray()
        {
            this.Show();
            if (this.WindowState == FormWindowState.Minimized) this.WindowState = FormWindowState.Normal;
            this.Activate();
        }

        // Vẽ đường bo tròn (path) dùng chung cho Region + viền thẻ — dialog QR
        // cũng mượn (internal để class cùng file dùng được)
        internal static System.Drawing.Drawing2D.GraphicsPath RoundedPath(int w, int h, int r)
        {
            System.Drawing.Drawing2D.GraphicsPath p = new System.Drawing.Drawing2D.GraphicsPath();
            p.AddArc(0, 0, r, r, 180, 90);
            p.AddArc(w - r - 1, 0, r, r, 270, 90);
            p.AddArc(w - r - 1, h - r - 1, r, r, 0, 90);
            p.AddArc(0, h - r - 1, r, r, 90, 90);
            p.CloseFigure();
            return p;
        }

        // ================= UI HELPERS =================

    private Panel CreateCard(int x, ref int y, int width, int height, Panel parent)
    {
        Panel card = new Panel();
        card.Location = new Point(x, y);
        card.Size = new Size(width, height);
        card.BackColor = ColorCard;
        card.Padding = new Padding(12);
        parent.Controls.Add(card);
        y += height;
        return card;
    }

        private void CreateCardTitle(string text, Panel card)
        {
            Label lbl = new Label();
            lbl.Text = text;
            lbl.Font = new Font("Segoe UI", 8f, FontStyle.Bold);
            lbl.ForeColor = ColorMuted;
            lbl.Location = new Point(16, 10);
            lbl.AutoSize = true;
            card.Controls.Add(lbl);
        }

        private Label CreateStatusLabel(string text, int x, int y, Panel parent)
        {
            Label lbl = new Label();
            lbl.Text = text;
            lbl.Font = new Font("Segoe UI", 9f);
            lbl.ForeColor = ColorText;
            lbl.Location = new Point(x, y);
            lbl.Size = new Size(388, 20);
            parent.Controls.Add(lbl);
            return lbl;
        }

        private RoundedButton CreateButton(string text, ButtonKind kind, int x, int y, int width, int height, Panel parent)
        {
            RoundedButton btn = new RoundedButton(kind);
            btn.Text = text;
            btn.Location = new Point(x, y);
            btn.Size = new Size(width, height);
            btn.Font = new Font("Segoe UI", 10f);
            parent.Controls.Add(btn);
            return btn;
        }

        // Nút disabled phải NHẬT MÀU hẳn (audit 13/09: nút khoá còn giữ màu vai
        // là mâu thuẫn với đèn trạng thái) — RoundedButton tự vẽ nên đổi được
        // cả thân lẫn viền, nút khoá về nhạt mất màu
        private void SetBridgeButton(RoundedButton btn, bool on)
        {
            btn.Enabled = on;
            btn.ApplyLook(on);
        }

        // Icon restart ↻ ngồi NGAY TRƯỚC dấu ":" của dòng tunnel (owner 14/09:
        // "dời hẳn về trước dấu ':'" + "căn lên 1 tí cho mặt chữ ngang đúng
        // trung tâm nút") — đo bề rộng chữ BỎ dấu ":" rồi để icon đè lên chỗ
        // ấy (fill trắng đặc che sạch); label cao 22 nhưng mặt chữ nằm nửa
        // trên nên icon nâng 3px. Trạng thái không kết thúc bằng ":" (429,
        // đang thiết lập…) thì icon bám sát đuôi chữ.
        private void PlaceTunnelRestart()
        {
            string t = lblStatusTunnel.Text;
            int x;
            if (t.EndsWith(":"))
            {
                // MeasureText lệch +10px so với label vẽ thật trên bố cục
                // fixed-pixel DPI-unaware này (đo thực tế 14/09) — trừ bù để
                // icon đè ĐÚNG lên chỗ dấu ":"
                string noColon = t.Substring(0, t.Length - 1);
                x = lblStatusTunnel.Left + TextRenderer.MeasureText(noColon,
                    lblStatusTunnel.Font, Size.Empty, TextFormatFlags.NoPadding).Width - 7;
            }
            else
            {
                x = lblStatusTunnel.Left + TextRenderer.MeasureText(t,
                    lblStatusTunnel.Font, Size.Empty, TextFormatFlags.NoPadding).Width + 6;
            }
            btnTunnelRestart.Left = x;
            // Owner 14/09: nâng 5px thì quá cao — hạ lại còn -2 để mặt chữ
            // xuyên đúng qua tâm icon
            btnTunnelRestart.Top = lblStatusTunnel.Top - 2;
        }

        // ================= SAFE UI MARSHAL =================

        // Callback nền (provision, POST bridge, fetch QR) có thể bay về SAU khi
        // form đã chết: bấm "Thoát hẳn" ở khay trong lúc "Restart tunnel" còn
        // đang chờ là this.Invoke ném ObjectDisposedException giết cả tiến
        // trình (crash lúc thoát). SafeInvoke bỏ qua khi target đã gone —
        // kiểm IsDisposed + IsHandleCreated TRƯỚC, nuốt race ở khoảng giữa.
        internal static void SafeInvoke(Control target, Action action)
        {
            if (target == null || action == null) return;
            try
            {
                if (target.IsDisposed || !target.IsHandleCreated) return;
                if (target.InvokeRequired) target.Invoke(action);
                else action();
            }
            catch (ObjectDisposedException) { }
            catch (InvalidOperationException) { }
        }

        // Bản gọn cho form này: SafeInvoke(delegate { ... }) trên UI marshal
        private void SafeInvoke(Action action)
        {
            MainForm.SafeInvoke(this, action);
        }

        // ================= CONFIG & LOGIC =================

        private string GetConfigPath()
        {
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            return Path.Combine(appData, "openwork-bridge", "config.json");
        }

        private string GetBridgeDataDir()
        {
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            return Path.Combine(appData, "openwork-bridge");
        }

        private Dictionary<string, object> LoadConfig()
        {
            string path = GetConfigPath();
            if (!File.Exists(path)) return new Dictionary<string, object>();
            try
            {
                string json = File.ReadAllText(path, Encoding.UTF8);
                var jss = new JavaScriptSerializer();
                var dict = jss.Deserialize<Dictionary<string, object>>(json);
                if (dict != null) return dict;
            }
            catch { }
            return new Dictionary<string, object>();
        }

        private void SaveConfig(Dictionary<string, object> dict)
        {
            string dir = GetBridgeDataDir();
            if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
            var jss = new JavaScriptSerializer();
            string json = jss.Serialize(dict);
            File.WriteAllText(GetConfigPath(), json, Encoding.UTF8);
        }

        private void LoadConfigToUi()
        {
            var config = LoadConfig();
            currentTenant = config.ContainsKey("lookupTenant") ? Convert.ToString(config["lookupTenant"]) : "";

            // Kiểm tra autostart task
            CheckAutostartTask();
        }

        // ================= LẦN ĐẦU CHẠY: ĐỊNH DANH MÁY + TỰ CÀI =================

        // Địa chỉ web trung gian là hằng số nhúng trong exe (zip không kèm config —
        // %APPDATA% máy người dùng trống, lần đầu chạy app tự ghi vào đó).
        private const string DefaultWorkerUrl = "https://YOUR-WORKER.workers.dev";

        // Ghi cấu hình tối thiểu để QR ghép chạy qua internet (lookupUrl) — gọi
        // một lần trong ctor, KHÔNG ghi đè gì đã có (máy đang dùng giữ nguyên).
        private void EnsureConfigDefaults()
        {
            try
            {
                var config = LoadConfig();
                bool dirty = false;
                if (!config.ContainsKey("lookupUrl") || string.IsNullOrEmpty(Convert.ToString(config["lookupUrl"])))
                {
                    config["lookupUrl"] = DefaultWorkerUrl;
                    dirty = true;
                }
                if (!config.ContainsKey("machineName") || string.IsNullOrEmpty(Convert.ToString(config["machineName"])))
                {
                    config["machineName"] = Environment.MachineName;
                    dirty = true;
                }
                if (dirty) SaveConfig(config);
            }
            catch { }
        }

        // 1 PC, không tài khoản: máy chưa có định danh (lookupTenant trống) thì TỰ
        // cấp một cái ngầm — room id ngẫu nhiên + mật khẩu ngẫu nhiên 48 hex qua
        // POST /api/tenant/create. Người dùng KHÔNG gõ gì, thứ họ thấy duy nhất
        // là QR. Chạy ngầm từ ctor; Bật Bridge đợi xong rồi mới boot (bridge đọc
        // config lúc mở — thiếu định danh thì đăng ký không được).
        private void BeginProvisionIfNeeded()
        {
            if (provisionDone || provisioning) return;
            var config = LoadConfig();
            string tenant = config.ContainsKey("lookupTenant") ? Convert.ToString(config["lookupTenant"]) : "";
            string secret = config.ContainsKey("lookupSecret") ? Convert.ToString(config["lookupSecret"]) : "";
            if (!string.IsNullOrEmpty(tenant) && !string.IsNullOrEmpty(secret)) { provisionDone = true; return; }

            provisioning = true;
            ThreadPool.QueueUserWorkItem(delegate {
                bool ok = false;
                // 409 "taken" = có người chen vào giữa lúc ghi trên KV
                // (worker/src/index.js:320). Tên phòng random 11 ký tự nên hiếm,
                // nhưng cứ tự đổi tên thử lại tối đa ProvisionNameRetries lần
                // TRONG LUỒNG NÀY: thành công ở lượt sau thì user không thấy lỗi.
                const int ProvisionNameRetries = 3;
                int nameRetry = 0;
                string user = NewRoomId();
                string pass = NewSecret();
                var cfg = LoadConfig();
                string url = cfg.ContainsKey("lookupUrl") ? Convert.ToString(cfg["lookupUrl"]).Trim().TrimEnd('/') : "";
                if (string.IsNullOrEmpty(url)) url = DefaultWorkerUrl;
                var jss = new JavaScriptSerializer();
                while (true)
                {
                    ok = false;
                    provisionError = "";
                    try
                    {
                        byte[] body = Encoding.UTF8.GetBytes(jss.Serialize(new Dictionary<string, object> {
                            { "user", user }, { "secret", pass }, { "name", Environment.MachineName }
                        }));
                        HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url + "/api/tenant/create");
                        req.Method = "POST";
                        req.ContentType = "application/json";
                        req.ContentLength = body.Length;
                        req.Timeout = 15000;
                        req.ReadWriteTimeout = 15000;
                        using (Stream rs = req.GetRequestStream()) rs.Write(body, 0, body.Length);
                        using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                        using (StreamReader sr = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                        {
                            var dict = jss.Deserialize<Dictionary<string, object>>(sr.ReadToEnd());
                            ok = dict != null && dict.ContainsKey("ok") && Convert.ToBoolean(dict["ok"]);
                        }
                        if (ok)
                        {
                            var save = LoadConfig();
                            save["lookupTenant"] = user;
                            save["lookupSecret"] = pass;
                            save["lookupUrl"] = url;
                            if (!save.ContainsKey("machineName") || string.IsNullOrEmpty(Convert.ToString(save["machineName"])))
                                save["machineName"] = Environment.MachineName;
                            SaveConfig(save);
                            break;
                        }
                    }
                    catch (WebException wex)
                    {
                        // Lỗi HTTP có body JSON { code, message } — đọc ra mã
                        // thật rồi dựng câu KÈM CÁCH SỬA (luật dự án: cảnh báo
                        // không chỉ đường sửa thì user chỉ biết nhìn chằm chằm).
                        int status = 0;
                        string code = "";
                        ReadHttpError(wex, out status, out code);
                        if (status == 409 && code == "taken" && nameRetry < ProvisionNameRetries)
                        {
                            nameRetry++;
                            user = NewRoomId();
                            continue;
                        }
                        provisionError = ProvisionErrorText(status, code);
                        break;
                    }
                    catch (Exception ex)
                    {
                        provisionError = ex.Message;
                        break;
                    }
                    // 2xx nhưng body không có ok=true
                    provisionError = "The identity server rejected the request (check network / lookupUrl)";
                    break;
                }
                if (!ok && provisionError == "")
                    provisionError = "The identity server rejected the request (check network / lookupUrl)";
                if (ok) provisionError = "";

                SafeInvoke(delegate {
                    provisioning = false;
                    provisionDone = ok;
                    if (ok) provisionHintRestart = isBridgeRunning;
                    CheckStatus();
                });
            });
        }

        // Rút HTTP status + mã JSON "code" ra khỏi một WebException. Worker trả
        // lỗi dạng { code, message } (xem worker/src/index.js), nên đọc body ở
        // đây giúp câu báo lỗi chỉ đúng mã thay vì "(403) Forbidden" trơ trọi.
        private static void ReadHttpError(WebException wex, out int status, out string code)
        {
            status = 0;
            code = "";
            HttpWebResponse resp = wex.Response as HttpWebResponse;
            if (resp == null) return;
            try
            {
                status = (int)resp.StatusCode;
                string body = "";
                try
                {
                    using (Stream rs = resp.GetResponseStream())
                    using (StreamReader sr = new StreamReader(rs, Encoding.UTF8))
                        body = sr.ReadToEnd();
                }
                catch { }
                if (body != "")
                {
                    try
                    {
                        var dict = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(body);
                        if (dict != null && dict.ContainsKey("code")) code = Convert.ToString(dict["code"]);
                    }
                    catch { }
                }
            }
            finally { try { resp.Close(); } catch { } }
        }

        // Luật dự án: CẢNH BÁO PHẢI KÈM CÁCH SỬA. Mỗi mã lỗi của worker có một
        // câu riêng — đọc xong biết ngay làm gì tiếp (bấm ↻, đợi, hay hỏi chủ
        // worker). Không map được thì vẫn phải có "bấm ↻" trong câu.
        private static string ProvisionErrorText(int status, string code)
        {
            if (status == 403 && code == "room_create_disabled")
                return "Room creation is turned off on the worker. Ask the worker owner to re-enable it (ALLOW_ROOM_CREATE).";
            if (status == 409 && code == "taken")
                return "That room name was taken while creating. Press Retry - the app will pick a new name automatically.";
            if (status == 429 && code == "rate_limited")
                return "Too many attempts - wait a minute and press Retry.";
            if (status == 503 || status == 502)
                return "Worker unreachable - check your connection and press Retry.";
            // 403 "full": hết 50 slot phòng trên worker — cùng dạng "không tự
            // sửa được, phải hỏi chủ worker", nên cũng phải kèm đường sửa.
            if (status == 403 && code == "full")
                return "No room slots left on the worker - ask the worker owner for an invite.";
            if (status == 0)
                return "Cannot reach the identity server - check your connection, then press Retry.";
            return string.Format("The identity server answered {0}{1}. Press Retry.",
                status, code == "" ? "" : " (" + code + ")");
        }

        private static string NewRoomId()
        {
            // a-z0-9 (bỏ ký tự dễ nhầm), "pc-" + 8 ký tự ngẫu nhiên — khớp TENANT_RE
            const string alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
            byte[] raw = new byte[8];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(raw);
            string id = "pc-";
            foreach (byte b in raw) id += alphabet[b % alphabet.Length].ToString();
            return id;
        }

        private static string NewSecret()
        {
            byte[] entropy = new byte[24];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(entropy);
            return "ows_" + BitConverter.ToString(entropy).Replace("-", "").ToLowerInvariant();
        }

        // Bridge zero-dependency (qrcode-terminal nằm trong bridge/src/vendor) —
        // KHÔNG còn npm install, KHÔNG còn node_modules (khối cũ chạy ngầm tối
        // đa 5 phút mà không nói gì, và giữ nút "Đang cài bridge" treo không
        // hồi kết). Kiểm presence ĐỒNG BỘ: thiếu là bản zip đóng gói hỏng — báo rõ.
        private bool EnsureBridgeDepsPresent()
        {
            if (bridgeDir == "" || !File.Exists(Path.Combine(bridgeDir, "src", "index.js")))
            {
                MessageBox.Show(this,
                    "Bridge folder not found (bridge\\src\\index.js must sit next to OpenPocket.exe).\nGet the zip with the correct layout again, then tap Start Bridge.",
                    "Missing component", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return false;
            }
            if (!File.Exists(nodeExe))
            {
                MessageBox.Show(this,
                    "Node.js (node.exe) not found.\nInstall Node.js 20+ (nodejs.org), then tap Start Bridge again.",
                    "Missing component", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return false;
            }
            return true;
        }


        private void CheckStatus()
        {
            // 1. Check bridge port 8788
            int port = 8788;
            var config = LoadConfig();
            if (config.ContainsKey("port"))
            {
                int p;
                if (int.TryParse(Convert.ToString(config["port"]), out p) && p > 0) port = p;
            }

            // 150ms là đủ cho cổng localhost — tick 3.5s cũ chờ 500ms làm GUI
            // giật cục trên máy chậm (audit pass này).
            isBridgeRunning = IsPortOpen("127.0.0.1", port, 150);

            if (isBridgeRunning)
            {
                lblStatusBridge.Text = string.Format("● Bridge: Running (Port {0})", port) +
                    (provisioning ? " (creating the machine identity first time...)" : "");
                lblStatusBridge.ForeColor = ColorSuccess;
                SetBridgeButton(btnStartBridge, false);
                SetBridgeButton(btnStopBridge, true);
                SetBridgeButton(btnRestartBridge, true);
                SetBridgeButton(btnTunnelRestart, true);
            }
            else
            {
                lblStatusBridge.Text = "○ Bridge: Stopped";
                lblStatusBridge.ForeColor = ColorDanger;
                SetBridgeButton(btnStartBridge, true);
                SetBridgeButton(btnStopBridge, false);
                SetBridgeButton(btnRestartBridge, false);
                SetBridgeButton(btnTunnelRestart, false);
            }

            // 2. Tên máy — chỉ nạp lại vào ô khi ô KHÔNG đang focus và KHÔNG có
            // lệnh lưu đang bay, kẻo ghi đè mất chữ user đang gõ
            currentTenant = config.ContainsKey("lookupTenant") ? Convert.ToString(config["lookupTenant"]) : "";

            // 3. Đọc tunnel URL: nguồn chính là tunnel-state.json (bridge tự ghi
            // URL vào đó mỗi lần bắt được tunnel), quét log chỉ là dự phòng —
            // bridge chạy bằng task scheduler thì stdout không phải TTY nên
            // printPairing bỏ qua, log KHÔNG còn dòng URL nào để quét và dòng
            // trạng thái kẹt "Connecting..." mãi dù tunnel đã lên. Nút Restart
            // tunnel vẫn cho phép chủ động thử ngay khi 429.
            int backoffMin = ReadTunnelBackoffMinutes();
            tunnelUrl = ReadTunnelUrlFromState();
            if (string.IsNullOrEmpty(tunnelUrl)) tunnelUrl = ReadTunnelUrlFromLog();
            if (backoffMin > 0)
            {
                lblStatusTunnel.Text = "● Cloudflare: waiting to reopen the tunnel (429)";
                // Bỏ đuôi "bấm [Restart tunnel]" — nút thật đang đứng kế bên,
                // ghi lại tên nút là chữ thừa (audit 13/09).
                lblStatusTunnelUrl.Text = "Will retry automatically in ~" + backoffMin + " min.";
                lblStatusTunnel.ForeColor = ColorAmber;
            }
            else if (!string.IsNullOrEmpty(tunnelUrl))
            {
                lblStatusTunnel.Text = "● Cloudflare Tunnel:";
                lblStatusTunnelUrl.Text = tunnelUrl;
                lblStatusTunnel.ForeColor = ColorSuccess;
            }
            else if (isBridgeRunning)
            {
                lblStatusTunnel.Text = "● Cloudflare Tunnel: Connecting...";
                lblStatusTunnelUrl.Text = "";
                lblStatusTunnel.ForeColor = ColorAmber;
            }
            else
            {
                lblStatusTunnel.Text = "○ Cloudflare Tunnel: Not connected";
                lblStatusTunnelUrl.Text = "";
                lblStatusTunnel.ForeColor = ColorMuted;
            }

            // 4. OpenWork Desktop đang mở hay tắt — soi TIẾN TRÌNH "OpenWork"
            // (bản desktop Electron). Soi cổng 8787 cũ không đáng tin: app mở
            // rồi mà GUI vẫn báo "Chưa mở" — owner bắt sửa 13/09 đêm.
            bool openworkRunning = false;
            foreach (Process p in Process.GetProcessesByName("OpenWork"))
            {
                openworkRunning = true;
                p.Dispose();
            }
            if (openworkRunning)
            {
                lblStatusOpenWork.Text = "● OpenWork Desktop: Launching";
                lblStatusOpenWork.ForeColor = ColorSuccess;
            }
            else
            {
                lblStatusOpenWork.Text = "○ OpenWork Desktop: Not running (will start when your phone connects)";
                lblStatusOpenWork.ForeColor = ColorMuted;
            }

            // Chấm ● / ○ giờ có trên cả 3 dòng, icon restart lại ngồi sát sau
            // chữ tunnel — text đổi thì phải xếp lại vị trí icon
            PlaceTunnelRestart();

            // Hàng định danh máy: đang tạo / lỗi / gợi ý khởi động lại. Hint
            // tắt khi bridge DỪNG lại (người dùng đã khởi động lại xong).
            if (provisionHintRestart && !isBridgeRunning) provisionHintRestart = false;
            UpdateProvisionStatus();
        }

        // Hàng "Định danh máy" trên thẻ trạng thái — hiện CHỈ khi có chuyện để
        // nói: đang tạo, tạo THẤT BẠI (đỏ + nút ↻ thử lại), hoặc vừa tạo xong
        // mà bridge đang chạy (gợi ý Khởi động lại để bridge nạp identity mới).
        // Máy đã có định danh ổn định thì hàng này ẩn sạch, không nhiễu.
        private void UpdateProvisionStatus()
        {
            if (lblProvision == null || btnProvisionRetry == null) return;
            if (provisionDone && provisionError == "" && !provisionHintRestart)
            {
                lblProvision.Visible = false;
                btnProvisionRetry.Visible = false;
                return;
            }
            lblProvision.Visible = true;
            btnProvisionRetry.Visible = true;
            if (provisioning)
            {
                lblProvision.Text = "● Machine identity: creating first time...";
                lblProvision.ForeColor = ColorAmber;
                btnProvisionRetry.Enabled = false;
            }
            else if (provisionError != "")
            {
                lblProvision.Text = "● Machine identity: FAILED - " + provisionError;
                lblProvision.ForeColor = ColorDanger;
                btnProvisionRetry.Enabled = true;
            }
            else if (provisionHintRestart)
            {
                lblProvision.Text = "● Machine identity: exists - tap Restart Bridge to show it on your phone";
                lblProvision.ForeColor = ColorSuccess;
                btnProvisionRetry.Enabled = false;
            }
            else
            {
                lblProvision.Text = "○ Machine identity: none yet - tap the retry icon to create it";
                lblProvision.ForeColor = ColorMuted;
                btnProvisionRetry.Enabled = true;
            }
        }

        // Nút ↻ trên hàng định danh: tạo lại identity sau lần thất bại. Trước
        // đây lỗi bị nuốt SILENT nên người dùng nhìn đèn xanh mà không bao giờ
        // hiểu sao máy không lên điện thoại — giờ thấy lỗi và tự thử lại được.
        private void ActionRetryProvision()
        {
            if (provisioning) return;
            provisionError = "";
            UpdateProvisionStatus();
            BeginProvisionIfNeeded();
        }

        private bool IsPortOpen(string host, int port, int timeoutMs)
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

        private string ReadTunnelUrlFromLog()
        {
            try
            {
                string dataDir = GetBridgeDataDir();
                // Quét CẢ hai log (CLI `openpocket start` ghi bridge.log, task
                // scheduler ghi bridge-task.log) — dừng ở bridge.log là hụt URL
                // khi cầu nối chạy bằng task. Lấy match của file SỬA GẦN NHẤT.
                string best = "";
                DateTime bestTime = DateTime.MinValue;
                foreach (string name in new string[] { "bridge-task.log", "bridge.log" })
                {
                    string logPath = Path.Combine(dataDir, name);
                    if (!File.Exists(logPath)) continue;
                    DateTime modified = File.GetLastWriteTime(logPath);
                    string found = "";
                    using (FileStream fs = new FileStream(logPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                    {
                        // Đọc CHỈ 32KB CUỐI file (FileStream.Seek): bản cũ
                        // ReadToEnd TOÀN BỘ log mỗi nhịp 3.5s — log phình to là
                        // GUI giật cục. URL tunnel luôn nằm ở dòng gần cuối
                        // nên phần đuôi là đủ.
                        const int TailBytes = 32 * 1024;
                        long start = Math.Max(0, fs.Length - TailBytes);
                        fs.Seek(start, SeekOrigin.Begin);
                        using (StreamReader sr = new StreamReader(fs, Encoding.UTF8))
                        {
                            string tail = sr.ReadToEnd();
                            Match last = default(Match);
                            foreach (Match m in Regex.Matches(tail, @"https://[a-z0-9-]+\.trycloudflare\.com")) last = m;
                            if (last != null && last.Success) found = last.Value;
                        }
                    }
                    if (found != "" && modified > bestTime)
                    {
                        best = found;
                        bestTime = modified;
                    }
                }
                return best;
            }
            catch { }
            return "";
        }

        // tunnel-state.json do bridge/src/tunnel.js ghi mỗi lần đổi pha — khi
        // tunnel đang sống file luôn mang phase "up" + URL hiện tại. Trả URL đó,
        // rỗng khi file thiếu / pha không phải "up" (backoff để nhánh 429 lo).
        private string ReadTunnelUrlFromState()
        {
            try
            {
                string path = Path.Combine(GetBridgeDataDir(), "tunnel-state.json");
                if (!File.Exists(path)) return "";
                string content = File.ReadAllText(path);
                if (!Regex.IsMatch(content, @"""phase""\s*:\s*""up""")) return "";
                Match url = Regex.Match(content, @"""url""\s*:\s*""(https://[a-z0-9-]+\.trycloudflare\.com)""");
                return url.Success ? url.Groups[1].Value : "";
            }
            catch { }
            return "";
        }

        // tunnel-state.json do bridge/src/tunnel.js ghi: {"phase":"backoff",
        // "streak":N,"nextAttemptAt":<epoch ms>,...}. Trả số PHÚT còn lại phải
        // chờ (>0 khi đang bị Cloudflare 429), -1 khi không có file/đã hết chờ.
        // Lý do tồn tại: trước đây user thấy "không kết nối được" là bấm Restart
        // — mỗi lần Restart = xin Cloudflare 1 tunnel mới = 429 tự gia hạn mãi.
        private int ReadTunnelBackoffMinutes()
        {
            try
            {
                string path = Path.Combine(GetBridgeDataDir(), "tunnel-state.json");
                if (!File.Exists(path)) return -1;
                string content = File.ReadAllText(path);
                if (!Regex.IsMatch(content, @"""phase""\s*:\s*""backoff""")) return -1;
                Match next = Regex.Match(content, @"""nextAttemptAt""\s*:\s*(\d+)");
                if (!next.Success) return -1;
                long nextAttemptAt = Convert.ToInt64(next.Groups[1].Value);
                long epochNow = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
                long remainingMs = nextAttemptAt - epochNow;
                if (remainingMs <= 0) return -1;
                return (int)Math.Ceiling(remainingMs / 60000.0);
            }
            catch { }
            return -1;
        }

        // ================= ACTIONS =================

        private void ActionStartBridge()
        {
            // Guard: bridge đang sống mà vẫn /run task = instance mới spawn lên
            // rồi chết EADDRINUSE — chỉ thêm rác vào log. Chặn luôn.
            if (isBridgeRunning)
            {
                MessageBox.Show(this, "The Bridge is already running (green light above). No need to start it again.", "Already running", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            // Dependency vendored trong zip — kiểm presence ĐỒNG BỘ (false =
            // thiếu thành phần, MessageBox đã báo rõ, nút không kẹt trạng thái).
            if (!EnsureBridgeDepsPresent()) return;

            SetBridgeButton(btnStartBridge, false);
            btnStartBridge.Text = "Preparing...";
            ThreadPool.QueueUserWorkItem(delegate {
                // Định danh máy (lần đầu, qua mạng) phải xong TRƯỚC khi boot —
                // bridge đọc config một lúc mở, thiếu là đăng ký không được.
                for (int i = 0; i < 30 && provisioning; i++) Thread.Sleep(500);
                SafeInvoke(delegate {
                    SetBridgeButton(btnStartBridge, true);
                    btnStartBridge.Text = "Start Bridge";
                    try
                    {
                        if (IsAutostartTaskExisting())
                        {
                            // Chạy task có sẵn — PHẢI kiểm exit code: trước đây
                            // /run hụt (task hỏng, thiếu quyền…) mà không ai hay,
                            // đèn xanh chỉ là mơ hồ của tick sau.
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
                                    MessageBox.Show(this, "Could not start the bridge: the schtasks /run command did not exit after 10 seconds.", "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                                    return;
                                }
                                if (p.ExitCode != 0)
                                {
                                    string err = "";
                                    try { err = p.StandardError.ReadToEnd().Trim(); } catch { }
                                    if (err == "") { try { err = p.StandardOutput.ReadToEnd().Trim(); } catch { } }
                                    MessageBox.Show(this, "Could not start the bridge - the OpenPocketBridge task failed (schtasks exit " + p.ExitCode + "): " + err, "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                                    return;
                                }
                            }
                        }
                        else
                        {
                            // Chưa có task (cài mới, hoặc autostart người dùng
                            // vừa TẮT): chạy node trực tiếp. TUYỆT ĐỐI không tự
                            // tạo lại task ở đây — bản cũ tự bật lại autostart
                            // ngay sau khi người dùng bỏ tick, rất khó chịu.
                            StartBridgeDirect();
                        }
                        Thread.Sleep(800);
                        CheckStatus();
                    }
                    catch (Exception ex)
                    {
                        MessageBox.Show(this, "Could not start the bridge: " + ex.Message, "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    }
                });
            });
        }

        // Bật bridge KHÔNG qua task scheduler: node chạy trực tiếp, cửa sổ ẩn,
        // log ghi tiếp bridge-task.log (cùng dòng lệnh với .vbs của task). GUI
        // chạy elevated (manifest) nên tiến trình con kế thừa quyền — tương
        // đương /RL HIGHEST. Được dùng khi task tự khởi động chưa tồn tại:
        // Bật Bridge phải LUÔN chạy được, còn autostart chỉ qua checkbox.
        private void StartBridgeDirect()
        {
            string entry = Path.Combine(bridgeDir, "src", "index.js");
            string logPath = Path.Combine(GetBridgeDataDir(), "bridge-task.log");
            var psi = new ProcessStartInfo("cmd.exe",
                "/c \"\"" + nodeExe + "\" \"" + entry + "\" >> \"" + logPath + "\" 2>&1\"");
            psi.WorkingDirectory = bridgeDir;
            psi.CreateNoWindow = true;
            psi.UseShellExecute = false;
            Process.Start(psi);
        }

        private void ActionStopBridge()
        {
            try
            {
                // Dừng task nếu task đang có instance chạy
                try
                {
                    var psiEnd = new ProcessStartInfo("schtasks.exe", "/end /tn OpenPocketBridge");
                    psiEnd.CreateNoWindow = true;
                    psiEnd.UseShellExecute = false;
                    Process.Start(psiEnd).WaitForExit(3000);
                }
                catch { }

                // 1. Kill theo pid file (bridge do `openpocket start` mở)
                string pidFile = Path.Combine(GetBridgeDataDir(), "bridge.pid");
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

                Thread.Sleep(800);
                // Bridge đã chết — xóa hẳn file log (owner 13/09: log không giữ ở máy).
                WipeLogFiles(true);
                CheckStatus();
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Error while stopping: " + ex.Message, "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        // Dọn log bridge trong data dir. deleteFiles = xóa hẳn file (dùng SAU khi
        // bridge đã chết); false = truncate về 0 (bridge vẫn chạy, file bị giữ
        // handle append nên không xóa được). Mở FileShare.ReadWrite để không
        // vấp handle của tiến trình ghi.
        private void WipeLogFiles(bool deleteFiles)
        {
            string[] names = new string[] { "bridge.log", "bridge-task.log", "watchdog.log" };
            foreach (string name in names)
            {
                string path = Path.Combine(GetBridgeDataDir(), name);
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

        private void ActionRestartBridge()
        {
            ActionStopBridge();
            Thread.Sleep(1200);
            ActionStartBridge();
        }

        // ================= BRIDGE HTTP (POST JSON, Bearer master token) =================

        // POST tới bridge localhost bằng master token trong config (GUI là chủ
        // máy). onDone(dict, err): dict = đáp án JSON khi 2xx, null = lỗi (err
        // mang mô tả). Chạy thread pool, đáp án marshal về UI thread.
        private void PostBridgeJson(string path, string json, Action<Dictionary<string, object>, string> onDone)
        {
            var config = LoadConfig();
            int port = 8788;
            if (config.ContainsKey("port"))
            {
                int p;
                if (int.TryParse(Convert.ToString(config["port"]), out p) && p > 0) port = p;
            }
            string token = config.ContainsKey("mobileToken") ? Convert.ToString(config["mobileToken"]) : "";
            ThreadPool.QueueUserWorkItem(delegate {
                Dictionary<string, object> dict = null;
                string error = null;
                try
                {
                    var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + path);
                    req.Method = "POST";
                    req.ContentType = "application/json";
                    req.Headers.Add("Authorization", "Bearer " + token);
                    req.Timeout = 8000;
                    if (json != null)
                    {
                        byte[] body = Encoding.UTF8.GetBytes(json);
                        req.ContentLength = body.Length;
                        using (Stream stream = req.GetRequestStream()) stream.Write(body, 0, body.Length);
                    }
                    using (var res = (HttpWebResponse)req.GetResponse())
                    using (var sr = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                    {
                        dict = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(sr.ReadToEnd()) ?? new Dictionary<string, object>();
                    }
                }
                catch (Exception ex)
                {
                    error = ex.Message;
                }
                Dictionary<string, object> result = dict;
                string errText = error;
                SafeInvoke(delegate { onDone(result, errText); });
            });
        }

        // Nút "Restart tunnel": xin Cloudflare tunnel mới NGAY, không đợi bộ đếm
        // backoff (owner 13/09: đặt giờ nhiều hồi hên xui — IP đã đổi mà vẫn kẹt
        // hẹn cũ). Trạng thái thật để poll 3.5s tự cập nhật từ tunnel-state.json.
        private void ActionRestartTunnel()
        {
            if (!isBridgeRunning) return;
            btnTunnelRestart.Enabled = false;
            btnTunnelRestart.Text = "Restarting...";
            lblStatusTunnel.Text = "Cloudflare: requesting a new tunnel...";
            lblStatusTunnel.ForeColor = ColorAmber;
            PostBridgeJson("/api/tunnel/restart", null, (dict, err) => {
                btnTunnelRestart.Text = "Restart tunnel";
                btnTunnelRestart.Enabled = isBridgeRunning;
                if (dict == null)
                {
                    lblStatusTunnel.Text = "Cloudflare: could not restart (" + err + ")";
                    lblStatusTunnel.ForeColor = ColorDanger;
                }
                // dict != null: bridge đã nhận — poll sắp tới tự hiện trạng thái mới
            });
        }

        private void ActionShowPairingDialog()
        {
            if (!isBridgeRunning)
            {
                MessageBox.Show(this, "The Bridge is not running. Please tap [Start Bridge] before viewing the pairing code.", "Notice", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            PairingQrDialog dlg = new PairingQrDialog(LoadConfig(), GetBridgeDataDir());
            dlg.ShowDialog(this);
        }

        private void ActionOpenLogs()
        {
            string logPath = Path.Combine(GetBridgeDataDir(), "bridge.log");
            if (!File.Exists(logPath))
            {
                logPath = Path.Combine(GetBridgeDataDir(), "bridge-task.log");
            }
            if (File.Exists(logPath))
            {
                Process.Start("notepad.exe", logPath);
            }
            else
            {
                MessageBox.Show(this, "No log file yet. Start the Bridge first.", "Notice", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
        }

        // ================= AUTOSTART TASK =================

        private bool IsAutostartTaskExisting()
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

        private void CheckAutostartTask()
        {
            chkAutostart.Checked = IsAutostartTaskExisting();
        }

        private void OnAutostartChanged(object sender, EventArgs e)
        {
            if (chkAutostart.Focused)
            {
                if (chkAutostart.Checked)
                {
                    EnsureAutostartTaskEnabled();
                }
                else
                {
                    DisableAutostartTask();
                }
            }
        }

        private void EnsureAutostartTaskEnabled()
        {
            try
            {
                string bridgeEntry = Path.Combine(bridgeDir, "src", "index.js");
                if (!File.Exists(bridgeEntry))
                {
                    MessageBox.Show(this, "File bridge/src/index.js not found", "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }

                string dataDir = GetBridgeDataDir();
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

                chkAutostart.Checked = exited && p.ExitCode == 0;
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Could not create the autostart task: " + ex.Message, "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void DisableAutostartTask()
        {
            try
            {
                var psi = new ProcessStartInfo("schtasks.exe", "/Delete /TN OpenPocketBridge /F");
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                var p = Process.Start(psi);
                p.WaitForExit(10000); // timeout — không đóng băng UI vô hạn
                chkAutostart.Checked = false;
            }
            catch { }
        }

        // ================= TENANT MANAGEMENT — ĐÃ BỎ =================
        // 1 PC là đủ (quyết định của chủ 13/09): tab phòng, link mời và mọi
        // tính năng đăng nhập tài khoản bị dời bỏ khỏi GUI. Định danh máy được
        // cấp NGẦM bằng BeginProvisionIfNeeded; worker/bridge vẫn giữ đường
        // multi-tenant ngủ đông cho ai cần (không UI nào gọi tới).

        private static string FindNodeExe()
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
    }

    // ================= PAIRING QR POPUP DIALOG =================
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
        private MainForm.RoundedButton btnCopyUrl;
        private MainForm.RoundedButton btnCopyMaster;
        private MainForm.RoundedButton btnShowLive;
        private MainForm.RoundedButton btnShowMaster;
        private MainForm.RoundedButton btnClose;

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
            this.Icon = MainForm.AppIcon;

            int port = 8788;
            if (config.ContainsKey("port"))
            {
                int p;
                if (int.TryParse(Convert.ToString(config["port"]), out p) && p > 0) port = p;
            }
            string token = config.ContainsKey("mobileToken") ? Convert.ToString(config["mobileToken"]) : "";

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
            btnShowLive = new MainForm.RoundedButton(MainForm.ButtonKind.Primary);
            btnShowLive.Text = "One-time code";
            btnShowLive.Location = new Point(120, 102);
            btnShowLive.Size = new Size(130, 26);
            btnShowLive.Click += delegate { ShowQr(false); };
            this.Controls.Add(btnShowLive);

            btnShowMaster = new MainForm.RoundedButton(MainForm.ButtonKind.Ghost);
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

            btnCopyUrl = new MainForm.RoundedButton(MainForm.ButtonKind.Primary);
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

            btnCopyMaster = new MainForm.RoundedButton(MainForm.ButtonKind.Ghost);
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
            btnClose = new MainForm.RoundedButton(MainForm.ButtonKind.Ghost);
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
            btnShowLive.SetKind(master ? MainForm.ButtonKind.Ghost : MainForm.ButtonKind.Primary);
            btnShowMaster.SetKind(master ? MainForm.ButtonKind.Primary : MainForm.ButtonKind.Ghost);
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

                        MainForm.SafeInvoke(this, delegate {
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
                    MainForm.SafeInvoke(this, delegate {
                        lblPairCode.Text = "Could not read the code";
                        lblExpiry.Text = "Bridge returned an error: " + ex.Message;
                    });
                }
            });
        }
    }
}
