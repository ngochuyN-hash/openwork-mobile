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
            return Path.Combine(appData, HostContract.DataDirName, HostContract.ConfigFileName);
        }

        public static string DataDir()
        {
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            return Path.Combine(appData, HostContract.DataDirName);
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

        // Cổng bridge chuẩn hoá: mặc định khi config thiếu/sai — cùng mặc định
        // với bridge/src/config.js (loadConfig). Giá trị nằm trong
        // HostContract (sinh từ shared/host-contract.js).
        public static int Port(Dictionary<string, object> config)
        {
            int port = HostContract.BridgePort;
            if (config != null && config.ContainsKey(HostContract.ConfigKeyPort))
            {
                int p;
                if (int.TryParse(Convert.ToString(config[HostContract.ConfigKeyPort]), out p) && p > 0) port = p;
            }
            return port;
        }

        public static string MobileToken(Dictionary<string, object> config)
        {
            return (config != null && config.ContainsKey(HostContract.ConfigKeyMobileToken)) ? Convert.ToString(config[HostContract.ConfigKeyMobileToken]) : "";
        }
    }
}
