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
            error = null;
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
