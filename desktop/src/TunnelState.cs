using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace OpenPocket.Desktop
{
    // ================= TUNNEL STATE — đọc trạng thái tunnel của bridge ==========
    // Tách khỏi OpenPocket.cs (tách module candidate 7, 06/10). Bridge tự ghi
    // trạng thái ra đĩa (tunnel-state.json + log); GUI chỉ ĐỌC lại để hiển thị.
    internal static class TunnelState
    {
        // Quét CẢ hai log (CLI `openpocket start` ghi bridge.log, task
        // scheduler ghi bridge-task.log) — dừng ở bridge.log là hụt URL
        // khi cầu nối chạy bằng task. Lấy match của file SỬA GẦN NHẤT.
        public static string UrlFromLog(string dataDir)
        {
            try
            {
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
        public static string UrlFromState(string dataDir)
        {
            try
            {
                string path = Path.Combine(dataDir, "tunnel-state.json");
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
        public static int BackoffMinutes(string dataDir)
        {
            try
            {
                string path = Path.Combine(dataDir, "tunnel-state.json");
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
    }
}
