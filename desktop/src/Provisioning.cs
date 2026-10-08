using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace OpenPocket.Desktop
{
    // ================= PROVISIONING — định danh máy trên worker =================
    // Tách khỏi OpenPocket.cs (tách module candidate 7, 06/10): các hàm thuần
    // của luồng tự cấp định danh (room + mật khẩu ngầm qua POST /api/tenant/
    // create). Luồng điều phối (BeginProvisionIfNeeded) vẫn ở MainForm vì nó
    // gắn chặt trạng thái UI.
    internal static class Provisioning
    {
        // Địa chỉ web trung gian nhúng trong exe (zip không kèm config —
        // %APPDATA% máy người dùng trống, lần đầu chạy app tự ghi vào đó).
        // GIÁ TRỊ THẬT nằm ở `desktop/worker.url` (gitignored), build.bat sinh ra
        // `WorkerUrl.cs` — cùng khuôn với InviteKey.cs. Source không chứa địa
        // chỉ thật; build thiếu worker.url thì exe dùng placeholder và QR trỏ
        // vào địa chỉ không tồn tại.
        public const string DefaultWorkerUrl = WorkerUrl.Value;

        // a-z0-9 (bỏ ký tự dễ nhầm), "pc-" + 8 ký tự ngẫu nhiên — khớp TENANT_RE
        public static string NewRoomId()
        {
            const string alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
            byte[] raw = new byte[8];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(raw);
            string id = "pc-";
            foreach (byte b in raw) id += alphabet[b % alphabet.Length].ToString();
            return id;
        }

        public static string NewSecret()
        {
            byte[] entropy = new byte[24];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(entropy);
            return "ows_" + BitConverter.ToString(entropy).Replace("-", "").ToLowerInvariant();
        }

        // Rút HTTP status + mã JSON "code" ra khỏi một WebException. Worker trả
        // lỗi dạng { code, message } (xem worker/src/index.js), nên đọc body ở
        // đây giúp câu báo lỗi chỉ đúng mã thay vì "(403) Forbidden" trơ trọi.
        public static void ReadHttpError(WebException wex, out int status, out string code)
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
        public static string ErrorText(int status, string code)
        {
            // Mã lỗi so ở đây là ErrorCode.* — sinh từ shared/contract.js lúc
            // build (src\ErrorCode.cs): worker đổi mã là exe theo theo, không
            // còn chuỗi gõ tay trôi nổi.
            if (status == 403 && code == ErrorCode.RoomCreateDisabled)
                return "Room creation is turned off on the worker. Ask the worker owner to re-enable it (ALLOW_ROOM_CREATE).";
            // 403 "invite_required": worker yêu cầu mã mời mà exe này không có
            // (build từ source thiếu invite.key) hoặc mã không khớp secret
            // ROOM_CREATE_KEY của worker — bản chính chủ thì không bao giờ gặp.
            if (status == 403 && code == ErrorCode.InviteRequired)
                return InviteConfig.RoomInviteKey.Length == 0
                    ? "This build carries no invite key (invite.key was missing at build time) - it cannot create rooms. Use the app build from the worker owner."
                    : "This worker only accepts the owner's app build - the invite key did not match.";
            if (status == 409 && code == ErrorCode.Taken)
                return "That room name was taken while creating. Press Retry - the app will pick a new name automatically.";
            if (status == 429 && code == ErrorCode.RateLimited)
                return "Too many attempts - wait a minute and press Retry.";
            if (status == 503 || status == 502)
                return "Worker unreachable - check your connection and press Retry.";
            // 403 "full": hết 50 slot phòng trên worker — cùng dạng "không tự
            // sửa được, phải hỏi chủ worker", nên cũng phải kèm đường sửa.
            if (status == 403 && code == ErrorCode.Full)
                return "No room slots left on the worker - ask the worker owner for an invite.";
            if (status == 0)
                return "Cannot reach the identity server - check your connection, then press Retry.";
            return string.Format("The identity server answered {0}{1}. Press Retry.",
                status, code == "" ? "" : " (" + code + ")");
        }
    }
}
