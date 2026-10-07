using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Web.Script.Serialization;

namespace OpenPocket.Desktop
{
    // ================= BRIDGE HTTP — gọi API localhost của bridge ===============
    // GUI là chủ máy: gọi API localhost của bridge bằng master token trong
    // config. Token CHỈ đi header Authorization (đúng luật bridge/src/auth.js
    // — đường ?_t= trên query đã bị đóng hẳn, không được mở lại).
    internal static class BridgeHttp
    {
        // POST đồng bộ — gọi từ thread nền (lưu config, round-trip cục bộ).
        // Trả dict JSON khi 2xx, null khi lỗi (error mang mô tả).
        public static Dictionary<string, object> PostSync(int port, string token, string path, string json, out string error)
        {
            return RequestSync("POST", port, token, path, json, 8000, out error);
        }

        // GET đồng bộ — cùng seam với POST (Bearer master token, chỉ header).
        // timeoutMs do caller quyết: GUI đọc /api/state trên UI thread mỗi tick
        // 3.5s nên phải NGẮN (localhost thường <50ms; kẹt thì lọt fallback).
        public static Dictionary<string, object> GetSync(int port, string token, string path, int timeoutMs, out string error)
        {
            return RequestSync("GET", port, token, path, null, timeoutMs, out error);
        }

        private static Dictionary<string, object> RequestSync(string method, int port, string token, string path, string json, int timeoutMs, out string error)
        {
            error = null;
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + path);
                req.Method = method;
                req.Headers.Add("Authorization", "Bearer " + token);
                req.Timeout = timeoutMs;
                req.ReadWriteTimeout = timeoutMs;
                if (json != null)
                {
                    req.ContentType = "application/json";
                    byte[] body = Encoding.UTF8.GetBytes(json);
                    req.ContentLength = body.Length;
                    using (Stream stream = req.GetRequestStream()) stream.Write(body, 0, body.Length);
                }
                using (var res = (HttpWebResponse)req.GetResponse())
                using (var sr = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                {
                    return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(sr.ReadToEnd())
                        ?? new Dictionary<string, object>();
                }
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return null;
            }
        }
    }
}
