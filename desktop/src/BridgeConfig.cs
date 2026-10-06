using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace OpenPocket.Desktop
{
    // ================= CONFIG STORE — cầu nối giữa GUI và config.json ===========
    // Tách khỏi OpenPocket.cs (tách module candidate 7, 06/10). Đường dẫn +
    // đọc/ghi config.json của bridge (%APPDATA%\openwork-bridge\config.json).
    // GUI ĐỌC file trực tiếp — chủ nhà đã chốt giữ plaintext (xem
    // bridge/src/config.js hardenConfigFile), đây chỉ là đọc local.
    internal static class BridgeConfig
    {
        public static string GetConfigPath()
        {
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            return Path.Combine(appData, "openwork-bridge", "config.json");
        }

        public static string DataDir()
        {
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            return Path.Combine(appData, "openwork-bridge");
        }

        public static Dictionary<string, object> Load()
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

        public static void Save(Dictionary<string, object> dict)
        {
            string dir = DataDir();
            if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
            var jss = new JavaScriptSerializer();
            string json = jss.Serialize(dict);
            File.WriteAllText(GetConfigPath(), json, Encoding.UTF8);
        }

        // Cổng bridge chuẩn hoá: 8788 khi config thiếu/sai — cùng mặc định với
        // bridge/src/config.js (loadConfig).
        public static int Port(Dictionary<string, object> config)
        {
            int port = 8788;
            if (config != null && config.ContainsKey("port"))
            {
                int p;
                if (int.TryParse(Convert.ToString(config["port"]), out p) && p > 0) port = p;
            }
            return port;
        }

        public static string MobileToken(Dictionary<string, object> config)
        {
            return (config != null && config.ContainsKey("mobileToken")) ? Convert.ToString(config["mobileToken"]) : "";
        }
    }
}
