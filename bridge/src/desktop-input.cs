// desktop-input — daemon điều khiển chuột + bàn phím cho OpenWork Mobile v1.7.
// Học cơ chế desktop-bridge.cs của 9remote: compile MỘT LẦN bằng csc (.NET
// Framework có sẵn trên mọi Windows), SendInput thuần không cần lib ngoài.
// Bridge nói chuyện qua stdin/stdout, mỗi dòng một lệnh dạng:
//   <id>|<OP>|<args...>     (args tự do mã hóa base64 — không lo ký tự lạ)
//     PING                        -> <id>|OK|<rộng>x<cao>
//     MOVE <x> <y>                -> di con trỏ (pixel màn chính)
//     CLICK <x> <y> <btn> <dbl>   -> bấm (btn 1 trái 2 phải 3 giữa, dbl 1 = double)
//     DOWN <x> <y> <btn>          -> nhấn giữ
//     UP <x> <y> <btn>            -> nhả
//     WHEEL <dx> <dy>             -> cuộn (notch, dương = lên/phải)
//     KEY <name>                  -> bấm 1 phím (enter/esc/tab/…, chữ, số, f1..f12)
//     COMBO <k1,k2> <key>         -> giữ k1..k2 (ctrl/alt/shift/win) rồi bấm key
//     TEXT <base64-utf8>          -> gõ chuỗi Unicode (tiếng Việt có dấu OK), không Enter
//     STOP                        -> thoát
// Reply: "<id>|OK" hoặc "<id>|ERR|<lỗi>".
// LƯU Ý: csc v4.0.30319 chỉ hiểu C# 5 — không dùng string interpolation/$"" ,
// không ?. , không out var. (Bài học copy từ chính file .cs của 9remote.)
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

class DesktopInput
{
  [DllImport("user32.dll", SetLastError = true)]
  static extern uint SendInput(uint n, INPUT[] p, int cb);
  [DllImport("user32.dll")]
  static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")]
  static extern int GetSystemMetrics(int index);

  const uint INPUT_MOUSE = 0;
  const uint INPUT_KEYBOARD = 1;
  const uint MOUSEEVENTF_MOVE = 0x0001;
  const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  const uint MOUSEEVENTF_LEFTUP = 0x0004;
  const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
  const uint MOUSEEVENTF_RIGHTUP = 0x0010;
  const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
  const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
  const uint MOUSEEVENTF_WHEEL = 0x0800;
  const uint MOUSEEVENTF_HWHEEL = 0x1000;
  const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_UNICODE = 0x0004;
  const int SM_CXSCREEN = 0;
  const int SM_CYSCREEN = 1;

  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)]
  struct MKH
  {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public MKH u; }

  static int screenW = 0;
  static int screenH = 0;
  static Dictionary<string, ushort> vkMap;

  static INPUT Mouse(uint flags, int dx, int dy, uint data)
  {
    INPUT i = new INPUT();
    i.type = INPUT_MOUSE;
    i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data;
    return i;
  }

  static INPUT Key(ushort vk, ushort scan, uint flags)
  {
    INPUT i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags;
    return i;
  }

  static void Send(INPUT[] arr)
  {
    if (SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT))) == 0)
      throw new Exception("SendInput lỗi winerr=" + Marshal.GetLastWin32Error());
  }

  // Tọa độ pixel -> chuẩn 0..65535 của MOUSEEVENTF_ABSOLUTE (màn chính).
  static INPUT AbsMove(int x, int y)
  {
    if (screenW <= 0) screenW = GetSystemMetrics(SM_CXSCREEN);
    if (screenH <= 0) screenH = GetSystemMetrics(SM_CYSCREEN);
    if (x < 0) x = 0; if (x > screenW - 1) x = screenW - 1;
    if (y < 0) y = 0; if (y > screenH - 1) y = screenH - 1;
    int nx = (int)((long)x * 65535 / (screenW - 1));
    int ny = (int)((long)y * 65535 / (screenH - 1));
    return Mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, nx, ny, 0);
  }

  static uint DownFlag(uint btn)
  {
    if (btn == 2) return MOUSEEVENTF_RIGHTDOWN;
    if (btn == 3) return MOUSEEVENTF_MIDDLEDOWN;
    return MOUSEEVENTF_LEFTDOWN;
  }
  static uint UpFlag(uint btn)
  {
    if (btn == 2) return MOUSEEVENTF_RIGHTUP;
    if (btn == 3) return MOUSEEVENTF_MIDDLEUP;
    return MOUSEEVENTF_LEFTUP;
  }

  static ushort VkOf(string name)
  {
    ushort v;
    if (vkMap.TryGetValue(name, out v)) return v;
    if (name.Length == 1)
    {
      char c = char.ToUpper(name[0]);
      if ((c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z')) return (ushort)c;
    }
    throw new Exception("Phím không hỗ trợ: " + name);
  }

  static void DoKey(string name)
  {
    ushort vk = VkOf(name);
    Send(new INPUT[] { Key(vk, 0, 0), Key(vk, 0, KEYEVENTF_KEYUP) });
  }

  static void DoCombo(string[] mods, string key)
  {
    List<INPUT> seq = new List<INPUT>();
    foreach (string m in mods) seq.Add(Key(VkOf(m.Trim()), 0, 0));
    ushort vk = VkOf(key);
    seq.Add(Key(vk, 0, 0));
    seq.Add(Key(vk, 0, KEYEVENTF_KEYUP));
    for (int i = mods.Length - 1; i >= 0; i--) seq.Add(Key(VkOf(mods[i].Trim()), 0, KEYEVENTF_KEYUP));
    Send(seq.ToArray());
  }

  static void DoWheel(int dx, int dy)
  {
    List<INPUT> seq = new List<INPUT>();
    if (dx != 0) seq.Add(Mouse(MOUSEEVENTF_HWHEEL, 0, 0, unchecked((uint)(dx * 120))));
    if (dy != 0) seq.Add(Mouse(MOUSEEVENTF_WHEEL, 0, 0, unchecked((uint)(dy * 120))));
    if (seq.Count > 0) Send(seq.ToArray());
  }

  static void DoText(string s)
  {
    // Unicode events: wVk=0, wScan=codepoint. Gửi theo mẻ 20 events để app kịp xử lý.
    List<INPUT> batch = new List<INPUT>();
    for (int i = 0; i < s.Length; i++)
    {
      char c = s[i];
      if (char.IsSurrogate(c)) throw new Exception("Ký tự emoji ngoài BMP chưa hỗ trợ");
      batch.Add(Key(0, (ushort)c, KEYEVENTF_UNICODE));
      batch.Add(Key(0, (ushort)c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
      if (batch.Count >= 20) { Send(batch.ToArray()); batch.Clear(); System.Threading.Thread.Sleep(5); }
    }
    if (batch.Count > 0) Send(batch.ToArray());
  }

  static void Main()
  {
    try { SetProcessDPIAware(); } catch {}
    screenW = GetSystemMetrics(SM_CXSCREEN);
    screenH = GetSystemMetrics(SM_CYSCREEN);

    vkMap = new Dictionary<string, ushort>();
    vkMap["enter"] = 0x0D; vkMap["esc"] = 0x1B; vkMap["tab"] = 0x09; vkMap["backspace"] = 0x08;
    vkMap["delete"] = 0x2E; vkMap["home"] = 0x24; vkMap["end"] = 0x23; vkMap["pgup"] = 0x21;
    vkMap["pgdn"] = 0x22; vkMap["up"] = 0x26; vkMap["down"] = 0x28; vkMap["left"] = 0x25;
    vkMap["right"] = 0x27; vkMap["space"] = 0x20; vkMap["win"] = 0x5B; vkMap["ctrl"] = 0x11;
    vkMap["alt"] = 0x12; vkMap["shift"] = 0x10;
    for (int i = 1; i <= 12; i++) vkMap["f" + i] = (ushort)(0x6F + i);

    string line;
    while ((line = Console.ReadLine()) != null)
    {
      line = line.Trim();
      if (line.Length == 0) continue;
      string[] f = line.Split('|');
      string id = f[0];
      string op = f.Length > 1 ? f[1].ToUpperInvariant() : "";
      try
      {
        switch (op)
        {
          case "PING":
            Console.WriteLine(id + "|OK|" + screenW + "x" + screenH);
            break;
          case "MOVE":
            Send(new INPUT[] { AbsMove(int.Parse(f[2]), int.Parse(f[3])) });
            Console.WriteLine(id + "|OK");
            break;
          case "CLICK":
          {
            int x = int.Parse(f[2]), y = int.Parse(f[3]);
            uint btn = uint.Parse(f[4]);
            bool dbl = f.Length > 5 && f[5] == "1";
            List<INPUT> seq = new List<INPUT>();
            seq.Add(AbsMove(x, y));
            seq.Add(Mouse(DownFlag(btn), 0, 0, 0));
            seq.Add(Mouse(UpFlag(btn), 0, 0, 0));
            if (dbl)
            {
              seq.Add(Mouse(DownFlag(btn), 0, 0, 0));
              seq.Add(Mouse(UpFlag(btn), 0, 0, 0));
            }
            Send(seq.ToArray());
            Console.WriteLine(id + "|OK");
            break;
          }
          case "DOWN":
            Send(new INPUT[] { AbsMove(int.Parse(f[2]), int.Parse(f[3])), Mouse(DownFlag(uint.Parse(f[4])), 0, 0, 0) });
            Console.WriteLine(id + "|OK");
            break;
          case "UP":
            Send(new INPUT[] { AbsMove(int.Parse(f[2]), int.Parse(f[3])), Mouse(UpFlag(uint.Parse(f[4])), 0, 0, 0) });
            Console.WriteLine(id + "|OK");
            break;
          case "WHEEL":
            DoWheel(int.Parse(f[2]), int.Parse(f[3]));
            Console.WriteLine(id + "|OK");
            break;
          case "KEY":
            DoKey(f[2]);
            Console.WriteLine(id + "|OK");
            break;
          case "COMBO":
            DoCombo(f[2].Split(','), f[3]);
            Console.WriteLine(id + "|OK");
            break;
          case "TEXT":
          {
            string s = Encoding.UTF8.GetString(Convert.FromBase64String(f[2]));
            if (s.Length > 2000) throw new Exception("Chuỗi quá dài (tối đa 2000 ký tự)");
            DoText(s);
            Console.WriteLine(id + "|OK");
            break;
          }
          case "STOP":
            Console.WriteLine(id + "|OK");
            return;
          default:
            Console.WriteLine(id + "|ERR|Lệnh không biết: " + op.Replace('|', '/'));
            break;
        }
      }
      catch (Exception e)
      {
        Console.WriteLine(id + "|ERR|" + e.Message.Replace('|', '/'));
      }
    }
  }
}
