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
        // Colors Zinc / Sky Theme
        private static readonly Color ColorBg = Color.FromArgb(24, 24, 27);         // #18181B
        private static readonly Color ColorCard = Color.FromArgb(39, 39, 42);       // #27272A
        private static readonly Color ColorCardBorder = Color.FromArgb(63, 63, 70); // #3F3F46
        private static readonly Color ColorText = Color.FromArgb(244, 244, 245);     // #F4F4F5
        private static readonly Color ColorMuted = Color.FromArgb(161, 161, 170);   // #A1A1AA
        private static readonly Color ColorPrimary = Color.FromArgb(2, 132, 199);    // #0284C7 Sky-600
        private static readonly Color ColorSuccess = Color.FromArgb(16, 185, 129);  // #10B981 Emerald-500
        private static readonly Color ColorDanger = Color.FromArgb(220, 38, 38);    // #DC2626 Red-600
        private static readonly Color ColorInputBg = Color.FromArgb(24, 24, 27);

        // State
        private System.Windows.Forms.Timer refreshTimer;
        private bool isBridgeRunning = false;
        private string tunnelUrl = "";
        private string currentTenant = "";
        private string currentMachineName = "";
        private string bridgeDir = "";
        private string workerDir = "";
        private string nodeExe = "";

        // UI Controls - Header & Tabs
        private Button btnTabMachine;
        private Button btnTabTenants;
        private Panel pnlMachine;
        private Panel pnlTenants;
        private Label lblAdminBadge;

        // UI Controls - Machine Tab
        private Label lblStatusBridge;
        private Label lblStatusRoom;
        private Label lblStatusTunnel;
        private Label lblStatusOpenWork;
        private Button btnStartBridge;
        private Button btnStopBridge;
        private Button btnRestartBridge;
        private CheckBox chkAutostart;
        private TextBox txtInviteLink;
        private TextBox txtRoomUser;
        private TextBox txtRoomPass;
        private TextBox txtMachineName;
        private TextBox txtWorkerUrl;

        // UI Controls - Tenants Tab
        private TextBox txtNewUser;
        private TextBox txtNewDisplayName;
        private TextBox txtNewPass;
        private Button btnCreateTenant;
        private TextBox txtCreatedResult;
        private Button btnCopyCreatedLink;
        private ListBox lstTenants;
        private Button btnRefreshTenants;
        private Button btnRevokeTenant;
        private Label lblTenantNote;

        public MainForm()
        {
            InitializeComponent();
            ResolvePaths();
            LoadConfigToUi();
            CheckStatus();

            // Badge admin: kiểm tra thật bằng WindowsPrincipal (manifest đòi
            // requireAdministrator nhưng task scheduler / compatibility mode
            // vẫn có thể hạ quyền — hiện đúng trạng thái để khỏi tự hù).
            bool isAdmin = new System.Security.Principal.WindowsPrincipal(
                System.Security.Principal.WindowsIdentity.GetCurrent()
            ).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
            lblAdminBadge.Text = isAdmin ? "ADMIN (ELEVATED)" : "THIẾU QUYỀN ADMIN";
            lblAdminBadge.ForeColor = isAdmin ? ColorSuccess : Color.Gold;
            lblAdminBadge.BackColor = isAdmin ? Color.FromArgb(20, 50, 35) : Color.FromArgb(70, 55, 15);

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

            // Tìm worker dir (nếu là máy chủ)
            string[] workerCandidates = new string[] {
                Path.Combine(baseDir, "worker"),
                Path.Combine(baseDir, "..", "worker"),
                Path.Combine(baseDir, "..", "..", "worker")
            };
            foreach (string w in workerCandidates)
            {
                if (File.Exists(Path.Combine(w, "scripts", "tenant.mjs")))
                {
                    workerDir = Path.GetFullPath(w);
                    break;
                }
            }

            // Tìm node.exe
            nodeExe = FindNodeExe();
        }

        private void InitializeComponent()
        {
            this.Text = "OpenPocket — Điều khiển OpenWork Desktop";
            this.Size = new Size(620, 750);
            this.MinimumSize = new Size(620, 750);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor = ColorBg;
            this.ForeColor = ColorText;
            this.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);
            this.Icon = SystemIcons.Application;

            // Header Bar
            Panel pnlHeader = new Panel();
            pnlHeader.Dock = DockStyle.Top;
            pnlHeader.Height = 85;
            pnlHeader.BackColor = ColorCard;
            pnlHeader.Padding = new Padding(16, 12, 16, 12);
            this.Controls.Add(pnlHeader);

            Label lblTitle = new Label();
            lblTitle.Text = "OpenPocket";
            lblTitle.Font = new Font("Segoe UI", 16f, FontStyle.Bold);
            lblTitle.ForeColor = Color.White;
            lblTitle.Location = new Point(16, 10);
            lblTitle.AutoSize = true;
            pnlHeader.Controls.Add(lblTitle);

            Label lblSubtitle = new Label();
            // Ngắn vừa phải — dài quá là đè lên badge ADMIN bên phải (bắt gặp thật)
            lblSubtitle.Text = "Điều khiển OpenWork từ điện thoại — miễn phí";
            lblSubtitle.Font = new Font("Segoe UI", 8.5f, FontStyle.Regular);
            lblSubtitle.ForeColor = ColorMuted;
            lblSubtitle.Location = new Point(18, 42);
            lblSubtitle.AutoSize = true;
            pnlHeader.Controls.Add(lblSubtitle);

            lblAdminBadge = new Label();
            lblAdminBadge.Text = "ADMIN (ELEVATED)";
            lblAdminBadge.Font = new Font("Segoe UI", 8f, FontStyle.Bold);
            lblAdminBadge.ForeColor = ColorSuccess;
            lblAdminBadge.BackColor = Color.FromArgb(20, 50, 35);
            lblAdminBadge.Padding = new Padding(6, 3, 6, 3);
            lblAdminBadge.Location = new Point(460, 16);
            lblAdminBadge.AutoSize = true;
            pnlHeader.Controls.Add(lblAdminBadge);

            // Tab Bar
            Panel pnlTabs = new Panel();
            pnlTabs.Dock = DockStyle.Top;
            pnlTabs.Height = 44;
            pnlTabs.BackColor = ColorBg;
            pnlTabs.Padding = new Padding(16, 4, 16, 4);
            this.Controls.Add(pnlTabs);

            btnTabMachine = CreateTabButton("🖥️  Máy của tôi", true);
            btnTabMachine.Location = new Point(16, 6);
            btnTabMachine.Click += delegate { SwitchTab(true); };
            pnlTabs.Controls.Add(btnTabMachine);

            btnTabTenants = CreateTabButton("🏢  Quản lý phòng", false);
            btnTabTenants.Location = new Point(232, 6);
            btnTabTenants.Click += delegate { SwitchTab(false); };
            pnlTabs.Controls.Add(btnTabTenants);

            // Tab Page Container
            Panel pnlContent = new Panel();
            pnlContent.Dock = DockStyle.Fill;
            pnlContent.AutoScroll = true;
            pnlContent.Padding = new Padding(16, 8, 16, 16);
            this.Controls.Add(pnlContent);

            // --- PAGE 1: MÁY CỦA TÔI ---
            pnlMachine = new Panel();
            pnlMachine.Dock = DockStyle.Fill;
            pnlMachine.AutoScroll = true;
            pnlContent.Controls.Add(pnlMachine);

            int y = 4;

            // Card 1: Trạng thái
            Panel cardStatus = CreateCard(ref y, 205, pnlMachine);
            CreateCardTitle("TRẠNG THÁI KẾT NỐI HIỆN TẠI", cardStatus);

            lblStatusBridge = CreateStatusLabel("Bridge: Đang kiểm tra...", 16, 34, cardStatus);
            lblStatusRoom = CreateStatusLabel("Phòng: Đang đọc cấu hình...", 16, 56, cardStatus);
            lblStatusTunnel = CreateStatusLabel("Cloudflare Tunnel: Đang kiểm tra...", 16, 78, cardStatus);
            lblStatusOpenWork = CreateStatusLabel("OpenWork Desktop: Đang kiểm tra...", 16, 100, cardStatus);

            btnStartBridge = CreateFlatButton("▶ Bật Bridge", ColorSuccess, 16, 130, 110, 32, cardStatus);
            btnStartBridge.Click += delegate { ActionStartBridge(); };

            btnStopBridge = CreateFlatButton("⏹ Dừng", ColorDanger, 134, 130, 80, 32, cardStatus);
            btnStopBridge.Click += delegate { ActionStopBridge(); };

            btnRestartBridge = CreateFlatButton("🔄 Khởi động lại", ColorCardBorder, 222, 130, 120, 32, cardStatus);
            btnRestartBridge.Click += delegate { ActionRestartBridge(); };

            chkAutostart = new CheckBox();
            // Hàng RIÊNG bên dưới các nút — dồn chung hàng là tràn chữ (bắt gặp thật)
            chkAutostart.Text = "Tự khởi động cùng Windows (chạy ngầm, quyền Admin)";
            chkAutostart.ForeColor = ColorText;
            chkAutostart.Font = new Font("Segoe UI", 9f, FontStyle.Regular);
            chkAutostart.Location = new Point(16, 172);
            chkAutostart.AutoSize = true;
            chkAutostart.CheckedChanged += OnAutostartChanged;
            cardStatus.Controls.Add(chkAutostart);

            y += 12;

            // Card 2: Ghép điện thoại (QR) & Tiện ích
            Panel cardPair = CreateCard(ref y, 75, pnlMachine);
            // Hai nút đủ dụng — nút "Thư mục" (mở %APPDATA%) đã XOÁ: chả có ý
            // nghĩa với người dùng, dại mà đụng vào là hỏng config (user chốt)
            Button btnShowQr = CreateFlatButton("📱 Xem mã ghép điện thoại (QR)", ColorPrimary, 16, 18, 270, 38, cardPair);
            btnShowQr.Font = new Font("Segoe UI", 10f, FontStyle.Bold);
            btnShowQr.Click += delegate { ActionShowPairingDialog(); };

            Button btnOpenLogs = CreateFlatButton("📄 Xem nhật ký (Logs)", ColorCardBorder, 298, 18, 240, 38, cardPair);
            btnOpenLogs.Click += delegate { ActionOpenLogs(); };

            y += 12;

            // Card 3: Cấu hình phòng (Dành cho người mới / lowtech friend)
            Panel cardConfig = CreateCard(ref y, 260, pnlMachine);
            CreateCardTitle("THAM GIA PHÒNG (DÀNH CHO NGƯỜI DÙNG MỚI)", cardConfig);

            Label lblHint = new Label();
            lblHint.Text = "Nhận link mời từ chủ nhà (dạng ...#i=marcus:pass) rồi dán vào bên dưới:";
            lblHint.ForeColor = ColorMuted;
            lblHint.Font = new Font("Segoe UI", 8.5f);
            lblHint.Location = new Point(16, 30);
            lblHint.Size = new Size(530, 20);
            cardConfig.Controls.Add(lblHint);

            txtInviteLink = CreateInput(16, 52, 420, cardConfig);
            txtInviteLink.Text = "";
            txtInviteLink.TextChanged += delegate { OnInviteLinkPasted(); };

            Button btnPaste = CreateFlatButton("📋 Dán link", ColorCardBorder, 444, 50, 106, 26, cardConfig);
            btnPaste.Click += delegate {
                if (Clipboard.ContainsText()) {
                    txtInviteLink.Text = Clipboard.GetText().Trim();
                }
            };

            CreateFieldLabel("Tên phòng (user):", 16, 88, cardConfig);
            txtRoomUser = CreateInput(16, 108, 170, cardConfig);

            CreateFieldLabel("Mật khẩu phòng:", 198, 88, cardConfig);
            txtRoomPass = CreateInput(198, 108, 170, cardConfig);
            txtRoomPass.PasswordChar = '•';

            CreateFieldLabel("Tên máy hiển thị:", 380, 88, cardConfig);
            txtMachineName = CreateInput(380, 108, 170, cardConfig);

            CreateFieldLabel("Địa chỉ Worker (cố định):", 16, 144, cardConfig);
            txtWorkerUrl = CreateInput(16, 164, 534, cardConfig);

            Button btnSaveConfig = CreateFlatButton("💾 Lưu cấu hình & Bật kết nối phòng", ColorPrimary, 16, 204, 270, 36, cardConfig);
            btnSaveConfig.Font = new Font("Segoe UI", 9.5f, FontStyle.Bold);
            btnSaveConfig.Click += delegate { ActionSaveAndJoin(); };

            y += 20;

            // --- PAGE 2: QUẢN LÝ PHÒNG (TENANTS) ---
            pnlTenants = new Panel();
            pnlTenants.Dock = DockStyle.Fill;
            pnlTenants.AutoScroll = true;
            pnlTenants.Visible = false;
            pnlContent.Controls.Add(pnlTenants);

            // Dock layout xử lý collection theo index GIẢM DẦN (index cao được
            // ưu tiên lấy mép trước): đưa tabs + header lên cuối để chúng lấy
            // mép trên trước, content fill phần còn lại. Thứ tự add ban đầu làm
            // content nguyên màn hình và CHÌM dưới header/tabs — các dòng
            // trạng thái bị che mất, chỉ thấy nút bấm (bắt gặp thật 13/09).
            this.Controls.SetChildIndex(pnlHeader, this.Controls.Count - 1);
            this.Controls.SetChildIndex(pnlTabs, this.Controls.Count - 1);

            int y2 = 4;

            // Note nếu không phải máy chủ
            lblTenantNote = new Label();
            lblTenantNote.Text = "⚙️ Quản lý phòng Cloudflare (Dành cho chủ Worker có tài khoản Cloudflare)";
            lblTenantNote.ForeColor = ColorMuted;
            lblTenantNote.Location = new Point(16, y2);
            lblTenantNote.Size = new Size(540, 22);
            pnlTenants.Controls.Add(lblTenantNote);
            y2 += 26;

            // Card Tạo phòng mới
            Panel cardNewTenant = CreateCard(ref y2, 230, pnlTenants);
            CreateCardTitle("TẠO PHÒNG MỚI (CẤP CHÌA CHO BẠN BÈ)", cardNewTenant);

            CreateFieldLabel("Tên phòng (user - chỉ gồm a-z, 0-9, gạch ngang, vd: marcus):", 16, 30, cardNewTenant);
            txtNewUser = CreateInput(16, 50, 240, cardNewTenant);

            CreateFieldLabel("Tên hiển thị (vd: Marcus Laptop):", 270, 30, cardNewTenant);
            txtNewDisplayName = CreateInput(270, 50, 280, cardNewTenant);

            CreateFieldLabel("Mật khẩu (≥8 ký tự, để trống = tự sinh ngẫu nhiên):", 16, 84, cardNewTenant);
            txtNewPass = CreateInput(16, 104, 240, cardNewTenant);

            btnCreateTenant = CreateFlatButton("➕ Tạo phòng & Tạo link mời", ColorSuccess, 270, 102, 280, 30, cardNewTenant);
            btnCreateTenant.Font = new Font("Segoe UI", 9.5f, FontStyle.Bold);
            btnCreateTenant.Click += delegate { ActionCreateTenant(); };

            CreateFieldLabel("Kết quả tạo phòng / Link mời tự copy:", 16, 140, cardNewTenant);
            txtCreatedResult = CreateInput(16, 160, 420, cardNewTenant);
            txtCreatedResult.ReadOnly = true;

            btnCopyCreatedLink = CreateFlatButton("📋 Sao chép", ColorPrimary, 444, 158, 106, 26, cardNewTenant);
            btnCopyCreatedLink.Click += delegate {
                if (!string.IsNullOrEmpty(txtCreatedResult.Text)) {
                    Clipboard.SetText(txtCreatedResult.Text);
                    MessageBox.Show(this, "Đã sao chép link mời vào bộ nhớ tạm! Bạn có thể dán gửi Zalo cho bạn bè.", "Thành công", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
            };

            y2 += 12;

            // Card Danh sách phòng
            Panel cardListTenant = CreateCard(ref y2, 260, pnlTenants);
            CreateCardTitle("DANH SÁCH PHÒNG ĐÃ CẤP TRÊN CLOUDFLARE KV", cardListTenant);

            lstTenants = new ListBox();
            lstTenants.Location = new Point(16, 32);
            lstTenants.Size = new Size(534, 170);
            lstTenants.BackColor = ColorInputBg;
            lstTenants.ForeColor = ColorText;
            lstTenants.BorderStyle = BorderStyle.FixedSingle;
            lstTenants.Font = new Font("Consolas", 9.5f);
            cardListTenant.Controls.Add(lstTenants);

            btnRefreshTenants = CreateFlatButton("🔄 Làm mới danh sách", ColorCardBorder, 16, 214, 170, 30, cardListTenant);
            btnRefreshTenants.Click += delegate { ActionRefreshTenants(); };

            btnRevokeTenant = CreateFlatButton("❌ Thu hồi phòng đã chọn", ColorDanger, 360, 214, 190, 30, cardListTenant);
            btnRevokeTenant.Click += delegate { ActionRevokeTenant(); };
        }

        // ================= UI HELPERS =================

        private Button CreateTabButton(string text, bool active)
        {
            Button btn = new Button();
            btn.Text = text;
            btn.Size = new Size(195, 34);
            btn.FlatStyle = FlatStyle.Flat;
            btn.FlatAppearance.BorderSize = 0;
            btn.Font = new Font("Segoe UI", 9.5f, active ? FontStyle.Bold : FontStyle.Regular);
            btn.BackColor = active ? ColorPrimary : ColorCard;
            btn.ForeColor = Color.White;
            btn.Cursor = Cursors.Hand;
            return btn;
        }

        private void SwitchTab(bool machineTab)
        {
            btnTabMachine.BackColor = machineTab ? ColorPrimary : ColorCard;
            btnTabMachine.Font = new Font("Segoe UI", 9.5f, machineTab ? FontStyle.Bold : FontStyle.Regular);

            btnTabTenants.BackColor = !machineTab ? ColorPrimary : ColorCard;
            btnTabTenants.Font = new Font("Segoe UI", 9.5f, !machineTab ? FontStyle.Bold : FontStyle.Regular);

            pnlMachine.Visible = machineTab;
            pnlTenants.Visible = !machineTab;

            if (!machineTab)
            {
                ActionRefreshTenants();
            }
        }

        private Panel CreateCard(ref int y, int height, Panel parent)
        {
            Panel card = new Panel();
            card.Location = new Point(16, y);
            card.Size = new Size(568, height);
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
            lbl.ForeColor = ColorPrimary;
            lbl.Location = new Point(14, 8);
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
            lbl.Size = new Size(530, 20);
            parent.Controls.Add(lbl);
            return lbl;
        }

        private void CreateFieldLabel(string text, int x, int y, Panel parent)
        {
            Label lbl = new Label();
            lbl.Text = text;
            lbl.Font = new Font("Segoe UI", 8.5f);
            lbl.ForeColor = ColorMuted;
            lbl.Location = new Point(x, y);
            lbl.AutoSize = true;
            parent.Controls.Add(lbl);
        }

        private TextBox CreateInput(int x, int y, int width, Panel parent)
        {
            TextBox txt = new TextBox();
            txt.Location = new Point(x, y);
            txt.Size = new Size(width, 24);
            txt.BackColor = ColorInputBg;
            txt.ForeColor = Color.White;
            txt.BorderStyle = BorderStyle.FixedSingle;
            txt.Font = new Font("Segoe UI", 9.5f);
            parent.Controls.Add(txt);
            return txt;
        }

        private Button CreateFlatButton(string text, Color bg, int x, int y, int width, int height, Panel parent)
        {
            Button btn = new Button();
            btn.Text = text;
            btn.Location = new Point(x, y);
            btn.Size = new Size(width, height);
            btn.FlatStyle = FlatStyle.Flat;
            btn.FlatAppearance.BorderSize = 0;
            btn.BackColor = bg;
            btn.ForeColor = Color.White;
            btn.Cursor = Cursors.Hand;
            parent.Controls.Add(btn);
            return btn;
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
            currentMachineName = config.ContainsKey("machineName") ? Convert.ToString(config["machineName"]) : "";
            string secret = config.ContainsKey("lookupSecret") ? Convert.ToString(config["lookupSecret"]) : "";
            string workerUrl = config.ContainsKey("lookupUrl") ? Convert.ToString(config["lookupUrl"]) : "https://YOUR-WORKER.workers.dev";

            txtRoomUser.Text = currentTenant;
            txtMachineName.Text = currentMachineName;
            txtRoomPass.Text = secret;
            txtWorkerUrl.Text = workerUrl;

            // Kiểm tra autostart task
            CheckAutostartTask();
        }

        private void OnInviteLinkPasted()
        {
            string raw = txtInviteLink.Text.Trim();
            if (string.IsNullOrEmpty(raw)) return;

            // Pattern: #i=user:secret
            var m = Regex.Match(raw, @"#i=([A-Za-z0-9][A-Za-z0-9-]{0,31}):([^&\s]+)");
            if (m.Success)
            {
                txtRoomUser.Text = m.Groups[1].Value.ToLower();
                txtRoomPass.Text = m.Groups[2].Value;
                try
                {
                    Uri uri = new Uri(raw);
                    txtWorkerUrl.Text = uri.GetLeftPart(UriPartial.Authority);
                }
                catch { }

                if (string.IsNullOrEmpty(txtMachineName.Text))
                {
                    txtMachineName.Text = Environment.MachineName;
                }
            }
        }

        private void ActionSaveAndJoin()
        {
            string user = txtRoomUser.Text.Trim().ToLower();
            string pass = txtRoomPass.Text.Trim();
            string machine = txtMachineName.Text.Trim();
            string url = txtWorkerUrl.Text.Trim().TrimEnd('/');

            if (!Regex.IsMatch(user, @"^[a-z0-9][a-z0-9-]{0,31}$"))
            {
                MessageBox.Show(this, "Tên phòng không hợp lệ. Chỉ gồm a-z, 0-9, dấu gạch ngang (vd: marcus).", "Lỗi", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (string.IsNullOrEmpty(pass))
            {
                MessageBox.Show(this, "Vui lòng nhập mật khẩu phòng.", "Lỗi", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            var config = LoadConfig();
            config["lookupTenant"] = user;
            config["lookupSecret"] = pass;
            config["machineName"] = !string.IsNullOrEmpty(machine) ? machine : user;
            config["lookupUrl"] = !string.IsNullOrEmpty(url) ? url : "https://YOUR-WORKER.workers.dev";
            SaveConfig(config);

            // Bật tự khởi động Task Scheduler luôn để người dùng không phải cấu hình lại
            EnsureAutostartTaskEnabled();

            // Khởi động lại bridge
            ActionRestartBridge();

            MessageBox.Show(this, string.Format("Đã cấu hình máy vào phòng \"{0}\" và khởi động lại Bridge!\nĐiện thoại có thể mở lại link mời để điều khiển máy này.", user), "Đã tham gia phòng", MessageBoxButtons.OK, MessageBoxIcon.Information);
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

            isBridgeRunning = IsPortOpen("127.0.0.1", port, 500);

            if (isBridgeRunning)
            {
                lblStatusBridge.Text = string.Format("● Bridge: Đang chạy (Cổng {0})", port);
                lblStatusBridge.ForeColor = ColorSuccess;
                btnStartBridge.Enabled = false;
                btnStopBridge.Enabled = true;
                btnRestartBridge.Enabled = true;
            }
            else
            {
                lblStatusBridge.Text = "○ Bridge: Đã dừng";
                lblStatusBridge.ForeColor = ColorDanger;
                btnStartBridge.Enabled = true;
                btnStopBridge.Enabled = false;
                btnRestartBridge.Enabled = false;
            }

            // 2. Phòng hiện tại
            currentTenant = config.ContainsKey("lookupTenant") ? Convert.ToString(config["lookupTenant"]) : "";
            currentMachineName = config.ContainsKey("machineName") ? Convert.ToString(config["machineName"]) : "";

            if (!string.IsNullOrEmpty(currentTenant))
            {
                lblStatusRoom.Text = string.Format("Phòng: {0}{1}", currentTenant,
                    !string.IsNullOrEmpty(currentMachineName) ? (" (" + currentMachineName + ")") : "");
            }
            else
            {
                lblStatusRoom.Text = "Phòng: Chủ máy (machine:main)";
            }

            // 3. Đọc tunnel URL từ log
            tunnelUrl = ReadTunnelUrlFromLog();
            if (!string.IsNullOrEmpty(tunnelUrl))
            {
                lblStatusTunnel.Text = string.Format("Cloudflare Tunnel: {0}", tunnelUrl);
                lblStatusTunnel.ForeColor = ColorSuccess;
            }
            else if (isBridgeRunning)
            {
                lblStatusTunnel.Text = "Cloudflare Tunnel: Đang thiết lập kết nối...";
                lblStatusTunnel.ForeColor = Color.Gold;
            }
            else
            {
                lblStatusTunnel.Text = "Cloudflare Tunnel: Chưa kết nối";
                lblStatusTunnel.ForeColor = ColorMuted;
            }

            // 4. Check OpenWork Desktop port 8787
            bool openworkRunning = IsPortOpen("127.0.0.1", 8787, 300);
            if (openworkRunning)
            {
                lblStatusOpenWork.Text = "OpenWork Desktop: Đã phát hiện (Cổng 8787)";
                lblStatusOpenWork.ForeColor = ColorSuccess;
            }
            else
            {
                lblStatusOpenWork.Text = "OpenWork Desktop: Chưa mở (Sẽ tự mở khi điện thoại kết nối)";
                lblStatusOpenWork.ForeColor = ColorMuted;
            }
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
                    using (StreamReader sr = new StreamReader(fs, Encoding.UTF8))
                    {
                        string content = sr.ReadToEnd();
                        Match last = default(Match);
                        foreach (Match m in Regex.Matches(content, @"https://[a-z0-9-]+\.trycloudflare\.com")) last = m;
                        if (last != null && last.Success) found = last.Value;
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

        // ================= ACTIONS =================

        private void ActionStartBridge()
        {
            // Guard: bridge đang sống mà vẫn /run task = instance mới spawn lên
            // rồi chết EADDRINUSE — chỉ thêm rác vào log. Chặn luôn.
            if (isBridgeRunning)
            {
                MessageBox.Show(this, "Bridge đang chạy rồi (đèn xanh phía trên). Không cần bật lại.", "Đang chạy", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            // Ưu tiên chạy task elevated
            try
            {
                Process.Start("schtasks.exe", "/run /tn OpenPocketBridge");
                Thread.Sleep(800);
                CheckStatus();
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Không khởi động được task: " + ex.Message, "Lỗi", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
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
                // pid file — dò đúng process node mang "bridge\src\index.js" trong
                // command line rồi kill (GUI elevated nên kill được).
                try
                {
                    using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(
                        "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'node.exe'"))
                    {
                        foreach (ManagementObject proc in searcher.Get())
                        {
                            string cmdLine = Convert.ToString(proc["CommandLine"]) ?? "";
                            string lower = cmdLine.ToLower();
                            if (lower.Contains("bridge") && lower.Contains("index.js"))
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

                Thread.Sleep(800);
                CheckStatus();
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Lỗi khi dừng: " + ex.Message, "Lỗi", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void ActionRestartBridge()
        {
            ActionStopBridge();
            Thread.Sleep(1200);
            ActionStartBridge();
        }

        private void ActionShowPairingDialog()
        {
            if (!isBridgeRunning)
            {
                MessageBox.Show(this, "Bridge chưa chạy. Vui lòng bấm [Bật Bridge] trước khi xem mã ghép.", "Thông báo", MessageBoxButtons.OK, MessageBoxIcon.Warning);
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
                MessageBox.Show(this, "Chưa có file log. Hãy khởi động Bridge trước.", "Thông báo", MessageBoxButtons.OK, MessageBoxIcon.Information);
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
                p.WaitForExit();
                return p.ExitCode == 0;
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
                    MessageBox.Show(this, "Không tìm thấy file bridge/src/index.js", "Lỗi", MessageBoxButtons.OK, MessageBoxIcon.Error);
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
                p.WaitForExit();

                chkAutostart.Checked = (p.ExitCode == 0);
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Không thể tạo task tự khởi động: " + ex.Message, "Lỗi", MessageBoxButtons.OK, MessageBoxIcon.Error);
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
                p.WaitForExit();
                chkAutostart.Checked = false;
            }
            catch { }
        }

        // ================= TENANT MANAGEMENT =================

        private void ActionCreateTenant()
        {
            string user = txtNewUser.Text.Trim().ToLower();
            string name = txtNewDisplayName.Text.Trim();
            string pass = txtNewPass.Text.Trim();

            if (!Regex.IsMatch(user, @"^[a-z0-9][a-z0-9-]{1,31}$"))
            {
                MessageBox.Show(this, "Tên phòng chỉ gồm 2-32 ký tự chữ thường a-z, số 0-9, gạch ngang (vd: marcus, nam-laptop).", "Lỗi định dạng", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            if (string.IsNullOrEmpty(pass))
            {
                // KHÔNG còn mật khẩu mặc định 12345678 — chữ đầu tiên kẻ phá thử
                // với mọi phòng. Để trống = tự sinh 48 hex (nằm sẵn trong link mời).
                byte[] entropy = new byte[24];
                using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(entropy);
                pass = "owes_" + BitConverter.ToString(entropy).Replace("-", "").ToLowerInvariant();
            }
            else if (pass.Length < 8 || Regex.IsMatch(pass, @"[\s""':&]"))
            {
                MessageBox.Show(this, "Mật khẩu phòng cần ít nhất 8 ký tự, không chứa dấu cách, nháy kép/nháy đơn, ':' hoặc '&'.", "Mật khẩu không hợp lệ", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            // Đọc + kiểm tra workerUrl trên UI thread (trước khi khóa nút):
            // URL lỗi định dạng sẽ xê dịch tham số khi ghép lệnh node bên dưới.
            string workerUrl = txtWorkerUrl.Text.Trim().TrimEnd('/');
            if (string.IsNullOrEmpty(workerUrl)) workerUrl = "https://YOUR-WORKER.workers.dev";
            if (!workerUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase) || Regex.IsMatch(workerUrl, @"\s"))
            {
                MessageBox.Show(this, "Địa chỉ worker phải bắt đầu bằng https:// và không chứa dấu cách.", "Lỗi định dạng", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            string tenantScript = Path.Combine(workerDir, "scripts", "tenant.mjs");
            if (!File.Exists(tenantScript))
            {
                MessageBox.Show(this, "Không tìm thấy worker/scripts/tenant.mjs.\nChức năng tạo phòng chỉ hoạt động trên máy Chủ dự án.", "Thiếu thành phần", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            btnCreateTenant.Enabled = false;
            btnCreateTenant.Text = "Đang tạo trên Cloudflare...";

            ThreadPool.QueueUserWorkItem(delegate {
                try
                {
                    var psi = new ProcessStartInfo(nodeExe);
                    // Nháy kép/CR/LF trong tên hiển thị sẽ thoát khỏi cặp nháy của
                    // Arguments và xê dịch tham số tenant.mjs — bỏ trước khi ghép lệnh.
                    string displayName = (string.IsNullOrEmpty(name) ? user : name)
                        .Replace("\"", "").Replace("\r", "").Replace("\n", "");
                    psi.Arguments = string.Format("\"{0}\" add {1} \"{2}\" {3} --pass \"{4}\"",
                        tenantScript, user, displayName, workerUrl, pass);
                    psi.WorkingDirectory = workerDir;
                    psi.CreateNoWindow = true;
                    psi.UseShellExecute = false;
                    psi.RedirectStandardOutput = true;
                    psi.RedirectStandardError = true;
                    // node in UTF-8 — phải khai báo để dấu — và tiếng Việt không vỡ
                    psi.StandardOutputEncoding = Encoding.UTF8;
                    psi.StandardErrorEncoding = Encoding.UTF8;

                    var p = Process.Start(psi);
                    string stdout = p.StandardOutput.ReadToEnd();
                    string stderr = p.StandardError.ReadToEnd();
                    p.WaitForExit();

                    this.Invoke(new MethodInvoker(delegate {
                        btnCreateTenant.Enabled = true;
                        btnCreateTenant.Text = "➕ Tạo phòng & Tạo link mời";

                        if (p.ExitCode == 0)
                        {
                            string inviteLink = string.Format("{0}/#i={1}:{2}", workerUrl, user, pass);
                            txtCreatedResult.Text = inviteLink;
                            Clipboard.SetText(inviteLink);
                            MessageBox.Show(this, string.Format("🎉 Đã tạo phòng \"{0}\" thành công trên Cloudflare KV!\n\nLink mời đã tự động sao chép vào bộ nhớ tạm:\n{1}\n\nHãy dán link này gửi cho bạn bè qua Zalo.", user, inviteLink), "Thành công", MessageBoxButtons.OK, MessageBoxIcon.Information);
                            ActionRefreshTenants();
                        }
                        else
                        {
                            string err = !string.IsNullOrEmpty(stderr) ? stderr : stdout;
                            MessageBox.Show(this, "Lỗi khi tạo phòng qua Cloudflare:\n" + err, "Thất bại", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        }
                    }));
                }
                catch (Exception ex)
                {
                    this.Invoke(new MethodInvoker(delegate {
                        btnCreateTenant.Enabled = true;
                        btnCreateTenant.Text = "➕ Tạo phòng & Tạo link mời";
                        MessageBox.Show(this, "Lỗi thực thi: " + ex.Message, "Lỗi", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    }));
                }
            });
        }

        private void ActionRefreshTenants()
        {
            string tenantScript = Path.Combine(workerDir, "scripts", "tenant.mjs");
            if (!File.Exists(tenantScript))
            {
                lblTenantNote.Text = "ℹ️ Máy này là phiên bản người dùng (Client) — không chứa worker/scripts. Chỉ xem máy tại tab 'Máy của tôi'.";
                lstTenants.Items.Clear();
                lstTenants.Items.Add("(Chức năng chỉ dành cho Chủ tòa nhà Cloudflare)");
                btnCreateTenant.Enabled = false;
                btnRefreshTenants.Enabled = false;
                btnRevokeTenant.Enabled = false;
                return;
            }

            btnRefreshTenants.Enabled = false;
            btnRefreshTenants.Text = "Đang tải...";
            lstTenants.Items.Clear();
            lstTenants.Items.Add("Đang kết nối Cloudflare KV để lấy danh sách phòng...");

            ThreadPool.QueueUserWorkItem(delegate {
                try
                {
                    var psi = new ProcessStartInfo(nodeExe);
                    psi.Arguments = string.Format("\"{0}\" list", tenantScript);
                    psi.WorkingDirectory = workerDir;
                    psi.CreateNoWindow = true;
                    psi.UseShellExecute = false;
                    psi.RedirectStandardOutput = true;
                    psi.RedirectStandardError = true;
                    // node in UTF-8 — phải khai báo để dấu — (em-dash trong "user — tên") không vỡ,
                    // nếu không regex dòng phòng sẽ không khớp nữa
                    psi.StandardOutputEncoding = Encoding.UTF8;
                    psi.StandardErrorEncoding = Encoding.UTF8;

                    var p = Process.Start(psi);
                    string stdout = p.StandardOutput.ReadToEnd();
                    p.WaitForExit();

                    this.Invoke(new MethodInvoker(delegate {
                        btnRefreshTenants.Enabled = true;
                        btnRefreshTenants.Text = "🔄 Làm mới danh sách";
                        lstTenants.Items.Clear();

                        if (p.ExitCode == 0 && !string.IsNullOrEmpty(stdout))
                        {
                            string[] lines = stdout.Split(new char[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
                            foreach (string line in lines)
                            {
                                // Format thật của tenant.mjs list:
                                // "  marcus  —  Marcus Laptop  (tạo 09:36:38 13/9/2026)"
                                if (Regex.IsMatch(line, @"^\s*[a-z0-9][a-z0-9-]{1,31}\s+—"))
                                {
                                    lstTenants.Items.Add(line.Trim());
                                }
                            }
                            if (lstTenants.Items.Count == 0)
                            {
                                lstTenants.Items.Add("Chưa có phòng nào được tạo.");
                            }
                        }
                        else
                        {
                            lstTenants.Items.Add("Không tải được danh sách phòng. Hãy kiểm tra kết nối mạng.");
                        }
                    }));
                }
                catch (Exception ex)
                {
                    this.Invoke(new MethodInvoker(delegate {
                        btnRefreshTenants.Enabled = true;
                        btnRefreshTenants.Text = "🔄 Làm mới danh sách";
                        lstTenants.Items.Clear();
                        lstTenants.Items.Add("Lỗi: " + ex.Message);
                    }));
                }
            });
        }

        private void ActionRevokeTenant()
        {
            if (lstTenants.SelectedItem == null)
            {
                MessageBox.Show(this, "Vui lòng chọn một dòng phòng trong danh sách phía trên.", "Chưa chọn phòng", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            string selected = lstTenants.SelectedItem.ToString();
            // Parse tên phòng từ dòng format tenant.mjs list:
            // "marcus  —  Marcus Laptop  (tạo ...)"
            var m = Regex.Match(selected, @"^([a-z0-9][a-z0-9-]{1,31})\s+—");
            if (!m.Success)
            {
                MessageBox.Show(this, "Không nhận diện được tên phòng từ dòng đã chọn.", "Lỗi", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            string user = m.Groups[1].Value;

            if (MessageBox.Show(this, string.Format("Bạn có chắc chắn muốn thu hồi (xóa) phòng \"{0}\"?\nNgười dùng phòng này sẽ mất quyền truy cập ngay lập tức.", user), "Xác nhận thu hồi", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
            {
                return;
            }

            string tenantScript = Path.Combine(workerDir, "scripts", "tenant.mjs");
            try
            {
                var psi = new ProcessStartInfo(nodeExe);
                psi.Arguments = string.Format("\"{0}\" revoke {1}", tenantScript, user);
                psi.WorkingDirectory = workerDir;
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                var p = Process.Start(psi);
                p.WaitForExit();

                MessageBox.Show(this, string.Format("Đã thu hồi phòng \"{0}\"!", user), "Đã xóa", MessageBoxButtons.OK, MessageBoxIcon.Information);
                ActionRefreshTenants();
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Lỗi khi thu hồi: " + ex.Message, "Lỗi", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

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
        private static readonly Color ColorBg = Color.FromArgb(24, 24, 27);
        private static readonly Color ColorCard = Color.FromArgb(39, 39, 42);
        private static readonly Color ColorPrimary = Color.FromArgb(2, 132, 199);
        private static readonly Color ColorText = Color.FromArgb(244, 244, 245);
        private static readonly Color ColorMuted = Color.FromArgb(161, 161, 170);

        private Label lblQrRender;
        private Label lblPairCode;
        private Label lblExpiry;
        private TextBox txtPairUrl;
        private TextBox txtMasterUrl;
        private Button btnCopyUrl;
        private Button btnCopyMaster;
        private Button btnShowLive;
        private Button btnShowMaster;

        private string liveQr = "";
        private string masterQr = "";
        private string livePairUrl = "";
        private string liveMasterUrl = "";
        private bool showingMaster = false;

        public PairingQrDialog(Dictionary<string, object> config, string bridgeDataDir)
        {
            this.Text = "Mã ghép điện thoại — OpenPocket";
            this.ClientSize = new Size(520, 700);
            this.StartPosition = FormStartPosition.CenterParent;
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.MinimizeBox = false;
            this.BackColor = ColorBg;
            this.ForeColor = ColorText;
            this.Font = new Font("Segoe UI", 9.5f);

            int port = 8788;
            if (config.ContainsKey("port"))
            {
                int p;
                if (int.TryParse(Convert.ToString(config["port"]), out p) && p > 0) port = p;
            }
            string token = config.ContainsKey("mobileToken") ? Convert.ToString(config["mobileToken"]) : "";

            // Title
            Label lblTitle = new Label();
            lblTitle.Text = "📱 GHÉP ĐIỆN THOẠI — QUÉT MÃ";
            lblTitle.Font = new Font("Segoe UI", 12f, FontStyle.Bold);
            lblTitle.ForeColor = Color.White;
            lblTitle.Location = new Point(20, 14);
            lblTitle.AutoSize = true;
            this.Controls.Add(lblTitle);

            // Pair Code
            lblPairCode = new Label();
            lblPairCode.Text = "Đang lấy mã...";
            lblPairCode.Font = new Font("Segoe UI", 15f, FontStyle.Bold);
            lblPairCode.ForeColor = ColorPrimary;
            lblPairCode.Location = new Point(20, 46);
            lblPairCode.Size = new Size(470, 30);
            lblPairCode.TextAlign = ContentAlignment.MiddleCenter;
            this.Controls.Add(lblPairCode);

            // Expiry
            lblExpiry = new Label();
            lblExpiry.Text = "Đang hỏi bridge lấy mã sống...";
            lblExpiry.Font = new Font("Segoe UI", 8.5f);
            lblExpiry.ForeColor = ColorMuted;
            lblExpiry.Location = new Point(20, 78);
            lblExpiry.Size = new Size(470, 18);
            lblExpiry.TextAlign = ContentAlignment.MiddleCenter;
            this.Controls.Add(lblExpiry);

            // Toggle: QR mã 1 lần (30 phút) hay QR master (vĩnh viễn)
            btnShowLive = new Button();
            btnShowLive.Text = "Mã 1 lần";
            btnShowLive.Location = new Point(120, 102);
            btnShowLive.Size = new Size(130, 26);
            btnShowLive.FlatStyle = FlatStyle.Flat;
            btnShowLive.FlatAppearance.BorderSize = 0;
            btnShowLive.BackColor = ColorPrimary;
            btnShowLive.ForeColor = Color.White;
            btnShowLive.Cursor = Cursors.Hand;
            btnShowLive.Click += delegate { ShowQr(false); };
            this.Controls.Add(btnShowLive);

            btnShowMaster = new Button();
            btnShowMaster.Text = "⭐ Mã vĩnh viễn";
            btnShowMaster.Location = new Point(258, 102);
            btnShowMaster.Size = new Size(142, 26);
            btnShowMaster.FlatStyle = FlatStyle.Flat;
            btnShowMaster.FlatAppearance.BorderSize = 0;
            btnShowMaster.BackColor = ColorCard;
            btnShowMaster.ForeColor = Color.White;
            btnShowMaster.Cursor = Cursors.Hand;
            btnShowMaster.Click += delegate { ShowQr(true); };
            this.Controls.Add(btnShowMaster);

            // QR render ASCII (nền trắng, chữ đen — font monospace giữ khối vuông)
            lblQrRender = new Label();
            lblQrRender.Text = "\n\n   Đang tải QR từ bridge...";
            lblQrRender.Font = new Font("Consolas", 7.5f);
            lblQrRender.BackColor = Color.White;
            lblQrRender.ForeColor = Color.Black;
            lblQrRender.Location = new Point(95, 140);
            lblQrRender.AutoSize = true;
            this.Controls.Add(lblQrRender);

            // Link ghép 1 lần
            Label lblPairUrlNote = new Label();
            lblPairUrlNote.Text = "Link ghép 1 lần (gửi Zalo cũng được — bấm là vào):";
            lblPairUrlNote.Font = new Font("Segoe UI", 8.5f);
            lblPairUrlNote.ForeColor = ColorMuted;
            lblPairUrlNote.Location = new Point(24, 496);
            lblPairUrlNote.AutoSize = true;
            this.Controls.Add(lblPairUrlNote);

            txtPairUrl = new TextBox();
            txtPairUrl.Location = new Point(24, 514);
            txtPairUrl.Size = new Size(456, 24);
            txtPairUrl.BackColor = ColorCard;
            txtPairUrl.ForeColor = Color.White;
            txtPairUrl.BorderStyle = BorderStyle.FixedSingle;
            txtPairUrl.ReadOnly = true;
            this.Controls.Add(txtPairUrl);

            btnCopyUrl = new Button();
            btnCopyUrl.Text = "📋 Sao chép link ghép";
            btnCopyUrl.Location = new Point(24, 544);
            btnCopyUrl.Size = new Size(200, 30);
            btnCopyUrl.FlatStyle = FlatStyle.Flat;
            btnCopyUrl.FlatAppearance.BorderSize = 0;
            btnCopyUrl.BackColor = ColorPrimary;
            btnCopyUrl.ForeColor = Color.White;
            btnCopyUrl.Font = new Font("Segoe UI", 9f, FontStyle.Bold);
            btnCopyUrl.Cursor = Cursors.Hand;
            btnCopyUrl.Click += delegate {
                if (!string.IsNullOrEmpty(livePairUrl))
                {
                    Clipboard.SetText(livePairUrl);
                    MessageBox.Show(this, "Đã sao chép link ghép vào bộ nhớ tạm!", "Thành công", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
            };
            this.Controls.Add(btnCopyUrl);

            // Master token
            Label lblMasterNote = new Label();
            lblMasterNote.Text = "⭐ Mã vĩnh viễn — KHÔNG chia sẻ, chỉ quét tại máy này:";
            lblMasterNote.Font = new Font("Segoe UI", 8.5f);
            lblMasterNote.ForeColor = ColorMuted;
            lblMasterNote.Location = new Point(24, 586);
            lblMasterNote.AutoSize = true;
            this.Controls.Add(lblMasterNote);

            txtMasterUrl = new TextBox();
            txtMasterUrl.Location = new Point(24, 604);
            txtMasterUrl.Size = new Size(456, 24);
            txtMasterUrl.BackColor = ColorCard;
            txtMasterUrl.ForeColor = Color.White;
            txtMasterUrl.BorderStyle = BorderStyle.FixedSingle;
            txtMasterUrl.ReadOnly = true;
            this.Controls.Add(txtMasterUrl);

            btnCopyMaster = new Button();
            btnCopyMaster.Text = "📋 Sao chép link master";
            btnCopyMaster.Location = new Point(24, 634);
            btnCopyMaster.Size = new Size(200, 30);
            btnCopyMaster.FlatStyle = FlatStyle.Flat;
            btnCopyMaster.FlatAppearance.BorderSize = 0;
            btnCopyMaster.BackColor = ColorCard;
            btnCopyMaster.ForeColor = Color.White;
            btnCopyMaster.Cursor = Cursors.Hand;
            btnCopyMaster.Click += delegate {
                if (!string.IsNullOrEmpty(liveMasterUrl))
                {
                    Clipboard.SetText(liveMasterUrl);
                    MessageBox.Show(this, "Đã sao chép link master!", "Thành công", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
            };
            this.Controls.Add(btnCopyMaster);

            // Close Button
            Button btnClose = new Button();
            btnClose.Text = "Đóng";
            btnClose.Location = new Point(200, 668);
            btnClose.Size = new Size(120, 28);
            btnClose.FlatStyle = FlatStyle.Flat;
            btnClose.FlatAppearance.BorderSize = 0;
            btnClose.BackColor = ColorCard;
            btnClose.ForeColor = ColorText;
            btnClose.Click += delegate { this.Close(); };
            this.Controls.Add(btnClose);

            // Lấy mã live từ bridge — SAU khi form có handle (Load event): gọi
            // Invoke từ ThreadPool trước khi ShowDialog tạo handle là sập app.
            int portAtLoad = port;
            string tokenAtLoad = token;
            this.Load += delegate {
                FetchLiveCode(portAtLoad, tokenAtLoad);
            };
        }

        private void ShowQr(bool master)
        {
            showingMaster = master;
            string qrText = master ? masterQr : liveQr;
            lblQrRender.Text = string.IsNullOrEmpty(qrText) ? "\n\n   (chưa có QR)" : qrText;
            btnShowLive.BackColor = master ? ColorCard : ColorPrimary;
            btnShowMaster.BackColor = master ? ColorPrimary : ColorCard;
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

                        this.Invoke(new MethodInvoker(delegate {
                            lblPairCode.Text = codeFormatted;
                            lblExpiry.Text = string.Format("Mã 1 lần sống ~{0} phút — quét bằng camera điện thoại", Math.Ceiling(secondsLeft / 60.0));
                            txtPairUrl.Text = livePairUrl;
                            txtMasterUrl.Text = liveMasterUrl;
                            ShowQr(false);
                        }));
                    }
                }
                catch (Exception ex)
                {
                    this.Invoke(new MethodInvoker(delegate {
                        lblPairCode.Text = "Không đọc được mã";
                        lblExpiry.Text = "Bridge trả lỗi: " + ex.Message;
                    }));
                }
            });
        }
    }
}
