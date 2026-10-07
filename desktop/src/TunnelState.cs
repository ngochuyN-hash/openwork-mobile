using System;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;

namespace OpenPocket.Desktop
{
    // ================= TUNNEL STATE — FALLBACK đọc trạng thái tunnel ===========
    // 07/10: nguồn CHÍNH là interface HTTP của bridge (GET /api/state →
    // tunnel: {phase, url, nextRetryAt}) qua BridgeHttp.GetSync — GUI hết
    // luồn qua đĩa. Module này chỉ còn vai trò FALLBACK khi bridge không trả
    // lời được (vừa kill, kẹt socket): đọc tunnel-state.json do
    // bridge/src/tunnel.js ghi. Trước đây file bị "parse" bằng Regex.IsMatch
    // — vỡ IM LẶNG nếu bridge đổi shape; giờ parse JSON thật bằng
    // JavaScriptSerializer. UrlFromLog (scrape log, bản sao regex
    // trycloudflare thứ 3) đã XOÁ: 259d7b1 chấm dứt việc GUI lệ thuộc log,
    // và bridge chạy bằng task không in URL ra log nên nó vô dụng từ đó.
    internal static class TunnelState
    {
        // tunnel-state.json → dict gọn; null khi file thiếu / JSON hỏng.
        private static Dictionary<string, object> Load(string dataDir)
        {
            try
            {
                string path = Path.Combine(dataDir, "tunnel-state.json");
                if (!File.Exists(path)) return null;
                return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(path));
            }
            catch { return null; }
        }

        // URL tunnel hiện tại (phase "up") — rỗng khi file thiếu / pha khác.
        public static string UrlFromState(string dataDir)
        {
            var st = Load(dataDir);
            if (st == null) return "";
            if (Convert.ToString(st.ContainsKey("phase") ? st["phase"] : "") != "up") return "";
            return Convert.ToString(st.ContainsKey("url") && st["url"] != null ? st["url"] : "");
        }

        // Số PHÚT còn lại phải chờ khi phase "backoff" (Cloudflare 429),
        // -1 khi không có file / đã hết chờ. Lý do tồn tại: trước đây user
        // thấy "không kết nối được" là bấm Restart — mỗi Restart = xin
        // Cloudflare 1 tunnel mới = 429 tự gia hạn mãi.
        public static int BackoffMinutes(string dataDir)
        {
            var st = Load(dataDir);
            if (st == null) return -1;
            if (Convert.ToString(st.ContainsKey("phase") ? st["phase"] : "") != "backoff") return -1;
            long nextAttemptAt;
            try { nextAttemptAt = Convert.ToInt64(st.ContainsKey("nextAttemptAt") ? st["nextAttemptAt"] : 0); }
            catch { return -1; }
            long epochNow = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
            long remainingMs = nextAttemptAt - epochNow;
            if (remainingMs <= 0) return -1;
            return (int)Math.Ceiling(remainingMs / 60000.0);
        }
    }
}
