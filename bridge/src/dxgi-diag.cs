// Chẩn đoán v2: duplication có trả NỘI DUNG thật không — acquire khung,
// MapDesktopSurface, đếm byte khác 0, ghi BMP. Tách lỗi driver/máy vs code daemon.
using System;
using System.Runtime.InteropServices;

class DxgiDiag
{
    [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid riid, out IntPtr ppFactory);
    [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr pAdapter, int DriverType, IntPtr Software, int Flags, int[] pFeatureLevels, int FeatureLevels, int SDKVersion, out IntPtr ppDevice, out int pFeatureLevel, out IntPtr ppImmediateContext);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    delegate int EnumAdaptersDel(IntPtr self, uint a, out IntPtr o);
    delegate int EnumOutputsDel(IntPtr self, uint a, out IntPtr o);
    delegate int DuplicateOutputDel(IntPtr self, IntPtr device, out IntPtr dup);
    delegate int AcquireDel(IntPtr self, int ms, ref FrameInfo info, out IntPtr res);
    delegate int MapDesktopDel(IntPtr self, IntPtr rect);
    delegate int UnMapDel(IntPtr self);
    delegate int ReleaseFrameDel(IntPtr self);
    delegate void ReleaseDel(IntPtr self);

    static T Fn<T>(IntPtr obj, int slot) where T : class
    {
        IntPtr vt = Marshal.ReadIntPtr(obj);
        IntPtr fn = Marshal.ReadIntPtr(vt, slot * IntPtr.Size);
        return (T)(object)Marshal.GetDelegateForFunctionPointer(fn, typeof(T));
    }

    [StructLayout(LayoutKind.Sequential)]
    struct FrameInfo { public long t1, t2, t3, t4; public uint acc; public int c1, c2, px, py, pv; public uint m1, m2; }

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int L, T, R, B; }

    static void Main()
    {
        SetProcessDPIAware();
        Guid iid = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
        IntPtr factory, adapter, output, dev, ctx, output1, dup;
        int fl;
        CreateDXGIFactory1(ref iid, out factory);
        Fn<EnumAdaptersDel>(factory, 7)(factory, 0, out adapter);
        Fn<EnumOutputsDel>(adapter, 7)(adapter, 0, out output);

        // desc raw: WCHAR[32] + RECT + BOOL + int + HMONITOR
        IntPtr descBuf = Marshal.AllocHGlobal(96);
        IntPtr vtOut = Marshal.ReadIntPtr(output);
        IntPtr fnGetDesc = Marshal.ReadIntPtr(vtOut, 7 * IntPtr.Size);
        ((GetDescDel)Marshal.GetDelegateForFunctionPointer(fnGetDesc, typeof(GetDescDel)))(output, descBuf);
        RECT r = (RECT)Marshal.PtrToStructure(descBuf + 64, typeof(RECT));
        int W = r.R - r.L, H = r.B - r.T;
        Console.WriteLine("output " + W + "x" + H);

        D3D11CreateDevice(adapter, 0, IntPtr.Zero, 0x20, null, 0, 7, out dev, out fl, out ctx);
        Guid iidOut1 = new Guid("00cddea8-939b-4b83-a340-a685226666cc");
        Marshal.QueryInterface(output, ref iidOut1, out output1);
        int hr = Fn<DuplicateOutputDel>(output1, 22)(output1, dev, out dup);
        Console.WriteLine("DuplicateOutput hr=0x" + hr.ToString("X"));
        if (hr != 0) return;

        // chờ DWM present vài khung rồi acquire
        for (int i = 0; i < 5; i++)
        {
            System.Threading.Thread.Sleep(600);
            FrameInfo info = new FrameInfo();
            IntPtr res;
            hr = Fn<AcquireDel>(dup, 8)(dup, 2000, ref info, out res);
            Console.WriteLine("acquire#" + i + " hr=0x" + hr.ToString("X") + " LastPresent=" + info.t1 + " acc=" + info.acc);
            if (hr != 0) continue;
            IntPtr rect = Marshal.AllocHGlobal(16);
            int hrm = Fn<MapDesktopDel>(dup, 12)(dup, rect);
            if (hrm != 0) { Console.WriteLine("  mapdesktop hr=0x" + hrm.ToString("X")); }
            else
            {
                IntPtr bits = Marshal.ReadIntPtr(rect);
                int pitch = Marshal.ReadInt32(rect, IntPtr.Size);
                long total = (long)pitch * H;
                long nz = 0;
                unsafe
                {
                    byte* p = (byte*)bits;
                    for (long k = 0; k < total; k += 997) if (p[k] != 0) nz++;
                }
                Console.WriteLine("  map OK pitch=" + pitch + " mẫu " + (total / 997) + " byte → khác 0: " + nz + " (" + (100 * nz / (total / 997)) + "%)");
                if (i == 4) DumpBmp(bits, pitch, W, H);
            }
            Fn<UnMapDel>(dup, 13)(dup);
            Marshal.FreeHGlobal(rect);
            Fn<ReleaseFrameDel>(dup, 14)(dup);
            Marshal.Release(res);
        }
    }
    delegate void GetDescDel(IntPtr self, IntPtr pDesc);

    // Ghi BMP 32bpp bottom-up từ buffer pitch — xem bằng mắt.
    static unsafe void DumpBmp(IntPtr bits, int pitch, int W, int H)
    {
        int pad = ((W * 3 + 3) / 4) * 4;
        byte[] bmp = new byte[54 + (long)pad * H];
        bmp[0] = 0x42; bmp[1] = 0x4D;
        WriteInt(bmp, 2, bmp.Length); WriteInt(bmp, 10, 54);
        WriteInt(bmp, 14, 40); WriteInt(bmp, 18, W); WriteInt(bmp, 22, H);
        WriteShort(bmp, 26, 1); WriteShort(bmp, 28, 24);
        WriteInt(bmp, 34, bmp.Length - 54);
        byte* src = (byte*)bits;
        fixed (byte* dst = bmp)
        {
            for (int y = 0; y < H; y++)
            {
                byte* s = src + (long)(H - 1 - y) * pitch;
                byte* d = dst + 54 + (long)y * pad;
                for (int x = 0; x < W; x++)
                {
                    d[x * 3] = s[x * 4]; d[x * 3 + 1] = s[x * 4 + 1]; d[x * 3 + 2] = s[x * 4 + 2];
                }
            }
        }
        System.IO.File.WriteAllBytes(Environment.GetEnvironmentVariable("LOCALAPPDATA") + "\\Temp\\owb-test\\diag.bmp", bmp);
        Console.WriteLine("  đã ghi diag.bmp");
    }
    static void WriteInt(byte[] b, int o, long v) { b[o] = (byte)v; b[o + 1] = (byte)(v >> 8); b[o + 2] = (byte)(v >> 16); b[o + 3] = (byte)(v >> 24); }
    static void WriteShort(byte[] b, int o, int v) { b[o] = (byte)v; b[o + 1] = (byte)(v >> 8); }
}
