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

    // ================= MAIN FORM — layout + điều phối ===========================
    // Tách module (candidate 7, 06/10): file này CHỈ giữ layout cửa sổ + luồng
    // điều phối (bấm nút -> gọi module -> cập nhật đèn). Toàn bộ logic nặng đã
    // rời đi:
    //   Ui.cs            — nút bo góc tự vẽ, path bo tròn, icon app, SafeInvoke
    //   BridgeConfig.cs  — đường dẫn + đọc config.json của bridge
    //   BridgeProcess.cs — tìm node, bật/dừng đúng tiến trình bridge, dọn log
    //   TunnelState.cs   — FALLBACK đọc tunnel-state.json (nguồn chính: GET /api/state)
    //   AutostartTask.cs — adapter mỏng: shell-out qua CLI `openpocket tasks/autostart/watchdog`
    //   BridgeHttp.cs    — POST/GET API localhost (Bearer master token)
    //   Provisioning.cs  — hàm thuần của luồng định danh máy (room + secret)
    //   PairingQrDialog.cs — popup QR ghép nối
    public class MainForm : Form
    {
        // Colors — TOKEN SKILL UI (pwa-workspace-ui/references/tokens.md 13/09):
        // nền trắng, thẻ trắng, viền hairline, nút chính ĐEN, chấm trạng thái
        // mới là điểm màu — KHÔNG còn xanh/đỏ bão hòa trên thân nút (nút vào
        // component RoundedButton tự vẽ: Primary đen / Ghost viền / viền đỏ).
        private static readonly Color ColorCard = Color.White;                          // #FFFFFF
        private static readonly Color ColorCardBorder = Color.FromArgb(228, 231, 236);  // #E4E7EC hairline
        private static readonly Color ColorText = Color.FromArgb(28, 32, 36);           // #1C2024
        private static readonly Color ColorMuted = Color.FromArgb(96, 100, 108);        // #60646C text-dim
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

            // Tự lành autostart khi mở exe (lệnh user 07/10: "autostart là 1 phần
            // chức năng exe"). Chạy NỀN cho khỏi khựng UI — mỗi lệnh schtasks có
            // thể ngốn tới 10s. Hai việc: (1) task autostart TỒN TẠI mà trigger
            // chết thì dựng lại; (2) thiếu máy canh (watchdog 5 phút chạy
            // `openpocket ensure`) thì cài — bridge chết ngầm hoặc máy bật lại
            // mà không có logon-event mới (Fast Startup) được hồi sinh trong 5
            // phút. TUYỆT ĐỐI không tạo task MỚI thay người dùng đã tắt (luật
            // giữ từ bản cũ): thiếu task = thôi, có task hỏng = sửa.
            ThreadPool.QueueUserWorkItem(delegate {
                try
                {
                    string healError;
                    if (AutostartTask.NeedsRepair(bridgeDir, nodeExe))
                    {
                        AutostartTask.Enable(bridgeDir, nodeExe, out healError);
                    }
                    // Máy canh dựng LẠI mỗi lần mở exe khi autostart đang bật
                    // (idempotent /F): cài bản cũ mang cờ chống-pin mặc định của
                    // schtasks — dựng lại là tự sửa, khỏi soi cờ từng bản.
                    if (AutostartTask.Exists(bridgeDir, nodeExe))
                    {
                        AutostartTask.EnableWatchdog(bridgeDir, nodeExe, out healError);
                    }
                    SafeInvoke(delegate { chkAutostart.Checked = AutostartTask.Healthy(bridgeDir, nodeExe); });
                }
                catch { }
            });
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
            // để CHẠY. Thiếu gì Bật Bridge cũng báo rõ (BridgeProcess.EnsureDepsPresent).

            // Tìm node.exe
            nodeExe = BridgeProcess.FindNodeExe();
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
                using (System.Drawing.Drawing2D.GraphicsPath p = Ui.RoundedPath(
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
            this.Icon = AppIcons.Current;
            trayIcon = new NotifyIcon();
            trayIcon.Icon = AppIcons.Current;
            trayIcon.Text = "OpenPocket - Control OpenWork from your phone";
            trayIcon.Visible = true;
            ContextMenuStrip trayMenu = new ContextMenuStrip();
            trayMenu.Items.Add("Open OpenPocket", null, delegate { ShowFromTray(); });
            trayMenu.Items.Add("Quit completely", null, delegate {
                reallyExit = true;
                // Log không giữ ở máy (owner 13/09): bridge vẫn chạy nền nên chỉ
                // truncate được — mấy dòng nó ghi sau đó là của ngày mới.
                BridgeProcess.WipeLogs(false);
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

        private void SafeInvoke(Action action)
        {
            Ui.SafeInvoke(this, action);
        }

        // ================= CONFIG & LOGIC =================

        private void LoadConfigToUi()
        {
            var config = BridgeConfig.Load();
            currentTenant = config.ContainsKey(HostContract.ConfigKeyLookupTenant) ? Convert.ToString(config[HostContract.ConfigKeyLookupTenant]) : "";

            // Kiểm tra autostart task — soi TRIGGER thật (Healthy), không chỉ
            // "tồn tại": task chết vẫn tồn tại và từng sáng đèn oan. Phần tự
            // lành chạy nền ở cuối ctor. Hỏi qua CLI (tasks --json) — đây là
            // nhịp node spawn hiếm hoi trên UI thread, chỉ chạy 1 lần lúc mở.
            chkAutostart.Checked = AutostartTask.Healthy(bridgeDir, nodeExe);
        }

        // ================= LẦN ĐẦU CHẠY: ĐỊNH DANH MÁY + TỰ CÀI =================

        // Ghi cấu hình tối thiểu để QR ghép chạy qua internet (lookupUrl) — gọi
        // một lần trong ctor, KHÔNG ghi đè gì đã có (máy đang dùng giữ nguyên).
        private void EnsureConfigDefaults()
        {
            try
            {
                var config = BridgeConfig.Load();
                bool dirty = false;
                if (!config.ContainsKey(HostContract.ConfigKeyLookupUrl) || string.IsNullOrEmpty(Convert.ToString(config[HostContract.ConfigKeyLookupUrl])))
                {
                    config[HostContract.ConfigKeyLookupUrl] = Provisioning.DefaultWorkerUrl;
                    dirty = true;
                }
                if (!config.ContainsKey(HostContract.ConfigKeyMachineName) || string.IsNullOrEmpty(Convert.ToString(config[HostContract.ConfigKeyMachineName])))
                {
                    config[HostContract.ConfigKeyMachineName] = Environment.MachineName;
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
            var config = BridgeConfig.Load();
            string tenant = config.ContainsKey(HostContract.ConfigKeyLookupTenant) ? Convert.ToString(config[HostContract.ConfigKeyLookupTenant]) : "";
            string secret = config.ContainsKey(HostContract.ConfigKeyLookupSecret) ? Convert.ToString(config[HostContract.ConfigKeyLookupSecret]) : "";
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
                string user = Provisioning.NewRoomId();
                string pass = Provisioning.NewSecret();
                var cfg = BridgeConfig.Load();
                string url = cfg.ContainsKey(HostContract.ConfigKeyLookupUrl) ? Convert.ToString(cfg[HostContract.ConfigKeyLookupUrl]).Trim().TrimEnd('/') : "";
                if (string.IsNullOrEmpty(url)) url = Provisioning.DefaultWorkerUrl;
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
                        // Mã mời nhúng trong exe lúc build (src\InviteKey.cs sinh
                        // từ desktop\invite.key): worker chỉ mở cửa tạo phòng cho
                        // bản build của chủ worker — exe tự biên dịch từ source
                        // (không có invite.key) sẽ bị 403 invite_required.
                        if (InviteConfig.RoomInviteKey.Length > 0)
                            req.Headers["x-owm-invite"] = InviteConfig.RoomInviteKey;
                        req.ContentLength = body.Length;
                        req.Timeout = 15000;
                        req.ReadWriteTimeout = 15000;
                        using (var rs = req.GetRequestStream()) rs.Write(body, 0, body.Length);
                        using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                        using (StreamReader sr = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                        {
                            var dict = jss.Deserialize<Dictionary<string, object>>(sr.ReadToEnd());
                            ok = dict != null && dict.ContainsKey("ok") && Convert.ToBoolean(dict["ok"]);
                        }
                        if (ok)
                        {
                            var save = BridgeConfig.Load();
                            save[HostContract.ConfigKeyLookupTenant] = user;
                            save[HostContract.ConfigKeyLookupSecret] = pass;
                            save[HostContract.ConfigKeyLookupUrl] = url;
                            if (!save.ContainsKey(HostContract.ConfigKeyMachineName) || string.IsNullOrEmpty(Convert.ToString(save[HostContract.ConfigKeyMachineName])))
                                save[HostContract.ConfigKeyMachineName] = Environment.MachineName;
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
                        Provisioning.ReadHttpError(wex, out status, out code);
                        if (status == 409 && code == "taken" && nameRetry < ProvisionNameRetries)
                        {
                            nameRetry++;
                            user = Provisioning.NewRoomId();
                            continue;
                        }
                        provisionError = Provisioning.ErrorText(status, code);
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

        private void CheckStatus()
        {
            // 1. Check bridge port 8788
            var config = BridgeConfig.Load();
            int port = BridgeConfig.Port(config);

            // 150ms là đủ cho cổng localhost — tick 3.5s cũ chờ 500ms làm GUI
            // giật cục trên máy chậm (audit pass này).
            isBridgeRunning = BridgeProcess.IsPortOpen("127.0.0.1", port, 150);

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
            currentTenant = config.ContainsKey(HostContract.ConfigKeyLookupTenant) ? Convert.ToString(config[HostContract.ConfigKeyLookupTenant]) : "";

            // 3. Trạng thái tunnel: bridge chạy thì hỏi qua INTERFACE HTTP của
            // nó (GET /api/state → tunnel:{phase,url,nextRetryAt}) — hết luồn
            // qua đĩa/log như trước (regex "parse" JSON + scrape log đã xoá,
            // 07/10). Nguồn chính là API; file tunnel-state.json chỉ còn là
            // FALLBACK khi bridge không trả lời được (vừa kill / kẹt socket).
            // GET chạy trên UI thread nên timeout ngắn: localhost thường
            // <50ms, kẹt tối đa 2s rồi lọt xuống fallback file. Lưu ý: bridge
            // chạy mà phase "starting" (tunnel đang lên) thì hiện Connecting
            // luôn — không đọc file kẻo dính URL "up" STALE của lần trước.
            string dataDir = BridgeConfig.DataDir();
            int backoffMin = -1;
            tunnelUrl = "";
            bool apiOk = false;
            if (isBridgeRunning)
            {
                string stateError;
                var state = BridgeHttp.GetSync(port, BridgeConfig.MobileToken(config), "/api/state", 2000, out stateError);
                if (state != null)
                {
                    apiOk = true;
                    var t = state.ContainsKey(HostContract.StateTunnelField) ? state[HostContract.StateTunnelField] as Dictionary<string, object> : null;
                    if (t != null)
                    {
                        string phase = Convert.ToString(t.ContainsKey(HostContract.StateTunnelKeyPhase) ? t[HostContract.StateTunnelKeyPhase] : "");
                        if (phase == HostContract.TunnelPhaseUp)
                            tunnelUrl = Convert.ToString(t.ContainsKey(HostContract.StateTunnelKeyUrl) && t[HostContract.StateTunnelKeyUrl] != null ? t[HostContract.StateTunnelKeyUrl] : "");
                        if (phase == HostContract.TunnelPhaseBackoff)
                        {
                            try
                            {
                                long nextRetryAt = Convert.ToInt64(t.ContainsKey(HostContract.StateTunnelKeyNextRetryAt) ? t[HostContract.StateTunnelKeyNextRetryAt] : 0);
                                long epochNow = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
                                long remainingMs = nextRetryAt - epochNow;
                                if (remainingMs > 0) backoffMin = (int)Math.Ceiling(remainingMs / 60000.0);
                            }
                            catch { }
                        }
                    }
                }
            }
            if (!apiOk)
            {
                backoffMin = TunnelState.BackoffMinutes(dataDir);
                tunnelUrl = TunnelState.UrlFromState(dataDir);
            }
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
            foreach (System.Diagnostics.Process p in System.Diagnostics.Process.GetProcessesByName("OpenWork"))
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
            if (!BridgeProcess.EnsureDepsPresent(this, bridgeDir, nodeExe)) return;

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
                        if (AutostartTask.Exists(bridgeDir, nodeExe))
                        {
                            // Chạy task có sẵn — PHẢI kiểm kết quả: trước đây
                            // /run hụt (task hỏng, thiếu quyền…) mà không ai hay,
                            // đèn xanh chỉ là mơ hồ của tick sau.
                            string runError;
                            if (!AutostartTask.RunExisting(bridgeDir, nodeExe, out runError))
                            {
                                MessageBox.Show(this, runError, "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                                return;
                            }
                        }
                        else
                        {
                            // Chưa có task (cài mới, hoặc autostart người dùng
                            // vừa TẮT): chạy node trực tiếp. TUYỆT ĐỐI không tự
                            // tạo lại task ở đây — bản cũ tự bật lại autostart
                            // ngay sau khi người dùng bỏ tick, rất khó chịu.
                            BridgeProcess.StartDirect(bridgeDir, nodeExe);
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

        private void ActionStopBridge()
        {
            try
            {
                string error = BridgeProcess.Stop(bridgeDir);
                if (error != "")
                {
                    MessageBox.Show(this, "Error while stopping: " + error, "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }
                // Bridge đã chết — xóa hẳn file log (owner 13/09: log không giữ ở máy).
                BridgeProcess.WipeLogs(true);
                CheckStatus();
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Error while stopping: " + ex.Message, "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void ActionRestartBridge()
        {
            ActionStopBridge();
            Thread.Sleep(1200);
            ActionStartBridge();
        }

        // ================= BRIDGE HTTP (POST JSON, Bearer master token) =========

        // POST tới bridge localhost bằng master token trong config (GUI là chủ
        // máy). onDone(dict, err): dict = đáp án JSON khi 2xx, null = lỗi (err
        // mang mô tả). Chạy thread pool, đáp án marshal về UI thread.
        private void PostBridgeJson(string path, string json, Action<Dictionary<string, object>, string> onDone)
        {
            var config = BridgeConfig.Load();
            int port = BridgeConfig.Port(config);
            string token = BridgeConfig.MobileToken(config);
            ThreadPool.QueueUserWorkItem(delegate {
                string error;
                Dictionary<string, object> result = BridgeHttp.PostSync(port, token, path, json, out error);
                SafeInvoke(delegate { onDone(result, error); });
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

            PairingQrDialog dlg = new PairingQrDialog(BridgeConfig.Load(), BridgeConfig.DataDir());
            dlg.ShowDialog(this);
        }

        private void ActionOpenLogs()
        {
            string dataDir = BridgeConfig.DataDir();
            string logPath = Path.Combine(dataDir, HostContract.LogBridge);
            if (!File.Exists(logPath))
            {
                logPath = Path.Combine(dataDir, HostContract.LogTask);
            }
            if (File.Exists(logPath))
            {
                System.Diagnostics.Process.Start("notepad.exe", logPath);
            }
            else
            {
                MessageBox.Show(this, "No log file yet. Start the Bridge first.", "Notice", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
        }

        // ================= AUTOSTART CHECKBOX =================

        private void OnAutostartChanged(object sender, EventArgs e)
        {
            if (chkAutostart.Focused)
            {
                if (chkAutostart.Checked)
                {
                    string error;
                    if (!AutostartTask.Enable(bridgeDir, nodeExe, out error))
                    {
                        chkAutostart.Checked = false;
                        if (error != "")
                        {
                            MessageBox.Show(this, "Could not create the autostart task: " + error, "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        }
                    }
                    else
                    {
                        chkAutostart.Checked = true;
                        // Máy canh đi cùng autostart — hụt thì lần mở exe sau
                        // sẽ tự cài lại (khối tự lành ở ctor).
                        string watchdogError;
                        AutostartTask.EnableWatchdog(bridgeDir, nodeExe, out watchdogError);
                    }
                }
                else
                {
                    AutostartTask.Disable(bridgeDir, nodeExe);
                    AutostartTask.DisableWatchdog(bridgeDir, nodeExe); // tắt là tắt cả cặp
                    chkAutostart.Checked = false;
                }
            }
        }

        // ================= TENANT MANAGEMENT — ĐÃ BỎ =================
        // 1 PC là đủ (quyết định của chủ 13/09): tab phòng, link mời và mọi
        // tính năng đăng nhập tài khoản bị dời bỏ khỏi GUI. Định danh máy được
        // cấp NGẦM bằng BeginProvisionIfNeeded; worker/bridge vẫn giữ đường
        // multi-tenant ngủ đông cho ai cần (không UI nào gọi tới).

        // ================= GHI CONFIG — QUA API BRIDGE (candidate 3) =============

        // Lưu config QUA bridge (POST /api/config/identity trên localhost) thay
        // vì ghi file trực tiếp — bridge là người giữ config.json nhất quán
        // (saveConfig + ACL). Bridge đang sống: 200 = bridge ghi xong. Bridge
        // chết: fallback ghi file như trước (khi đó không ai khác đang giữ
        // config nên ghi trực tiếp là an toàn — vừa ghi xong chính mình boot).
        private void SaveConfig(Dictionary<string, object> config)
        {
            if (TrySaveViaBridge(config)) return;
            BridgeConfig.Save(config);
        }

        // Ghi qua bridge; false khi bridge không nhận (chết, 4xx/5xx, sai token)
        private bool TrySaveViaBridge(Dictionary<string, object> config)
        {
            if (!isBridgeRunning) return false;
            int port = BridgeConfig.Port(config);
            string token = BridgeConfig.MobileToken(config);
            var payload = new Dictionary<string, object>();
            // Whitelist 4 key nằm trong IdentityKeys.cs — SINH TỰ ĐỘNG từ
            // shared/identity-keys.txt (cùng nguồn với bridge/src/identity.js,
            // candidate 2 review 07/10). Thêm key: sửa file txt đó + build lại,
            // đừng sửa mảng tay tại đây nữa.
            foreach (string key in IdentityKeys.All)
            {
                if (config.ContainsKey(key)) payload[key] = config[key];
            }
            string json = new JavaScriptSerializer().Serialize(payload);
            string error;
            var dict = BridgeHttp.PostSync(port, token, "/api/config/identity", json, out error);
            return dict != null && dict.ContainsKey("ok") && Convert.ToBoolean(dict["ok"]);        }
    }
}
