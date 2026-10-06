using System;
using System.Drawing;
using System.Windows.Forms;

namespace OpenPocket.Desktop
{
    // ================= UI PRIMITIVES — dùng chung bởi MainForm + dialog =========
    // Tách khỏi OpenPocket.cs (tách module candidate 7, 06/10): mọi thứ VẼ được
    // mà hai form cùng cần — enum kind nút bo góc tự vẽ, path bo tròn, icon
    // app, marshal UI an toàn. KHÔNG mang logic nghiệp vụ nào.

    // Ngôn ngữ theo skill UI: Primary = nền đen chữ trắng; Ghost = nền trắng
    // viền đậm mảnh; DangerGhost = nền trắng viền đỏ chữ đỏ; khóa = nhạt hẳn
    // mất màu vai (đèn trạng thái mới giữ màu).
    internal enum ButtonKind { Primary, Ghost, DangerGhost, SuccessGhost, InlineIcon }

    internal static class Ui
    {
        // Vẽ đường bo tròn (path) dùng chung cho Region + viền thẻ + nút —
        // dialog QR cũng mượn.
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
    }

    // Icon app: đúng hình khối OpenWork (lục giác bo isometric + lỗ O +
    // sọc chéo) nhưng ĐẢO MÀU — nét trắng trên nền đen (owner chỉ định
    // 13/09, rasterize từ web/public/openwork-mark.svg). Nguồn chân lý là
    // src\app.ico nhúng vào exe qua /win32icon; lúc chạy bấm lại từ exe để
    // title bar / khay / dialog QR dùng chung một nguồn.
    internal static class AppIcons
    {
        static Icon _appIcon;
        internal static Icon Current
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
                            using (System.Drawing.Drawing2D.GraphicsPath path = Ui.RoundedPath(32, 32, 8))
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
    }

    // ================= NÚT BO GÓC KHỬ RĂNG CƯA =================
    // Region cắt cứng (cũ) không có AntiAlias nên góc bo thành bậc thang —
    // owner 13/09 tối: "bị răng cưa như đè nhiều box hình chữ nhật lên
    // vậy". Một component duy nhất cho mọi nút: radius 8, thân/viền tự vẽ
    // bằng GraphicsPath có AntiAlias, nền control trắng hoà vào thẻ.
    internal class RoundedButton : Control
    {
        // Token skill UI — bản riêng để dialog (class khác cùng namespace) dùng
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
            using (System.Drawing.Drawing2D.GraphicsPath p = Ui.RoundedPath(Width - 1, Height - 1, Radius))
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
}
