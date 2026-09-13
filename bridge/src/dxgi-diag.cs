// Chẩn đoán: DuplicateOutput fail E_ACCESSDENIED từ daemon chính nhưng init từng PASS
// — exe này làm đúng chuỗi tối thiểu, in hr từng bước để tách lỗi code vs môi trường.
using System;
using System.Runtime.InteropServices;

class DxgiDiag
{
    [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid riid, out IntPtr ppFactory);
    [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr pAdapter, int DriverType, IntPtr Software, int Flags, int[] pFeatureLevels, int FeatureLevels, int SDKVersion, out IntPtr ppDevice, out int pFeatureLevel, out IntPtr ppImmediateContext);

    // vtable thủ công — không cần interface khai báo
    delegate int VtCallUO(IntPtr self, uint idx, out IntPtr obj); // không dùng — viết delegate riêng từng slot

    delegate int EnumAdaptersDel(IntPtr self, uint adapter, out IntPtr ppAdapter);
    delegate int EnumOutputsDel(IntPtr self, uint output, out IntPtr ppOutput);
    delegate int DuplicateOutputDel(IntPtr self, IntPtr device, out IntPtr dup);
    delegate void GetDescDel(IntPtr self, IntPtr pDesc);

    static T Fn<T>(IntPtr obj, int slot) where T : class
    {
        IntPtr vt = Marshal.ReadIntPtr(obj);
        IntPtr fn = Marshal.ReadIntPtr(vt, slot * IntPtr.Size);
        return (T)(object)Marshal.GetDelegateForFunctionPointer(fn, typeof(T));
    }
    static void Release(IntPtr p) { Marshal.Release(p); }

    [STAThread]
    static void Main()
    {
        Guid iid = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
        IntPtr factory;
        int hr = CreateDXGIFactory1(ref iid, out factory);
        Console.WriteLine("CreateDXGIFactory1 hr=0x" + hr.ToString("X"));
        if (hr != 0) return;

        IntPtr adapter;
        hr = Fn<EnumAdaptersDel>(factory, 7)(factory, 0, out adapter);
        Console.WriteLine("EnumAdapters(0) hr=0x" + hr.ToString("X"));
        if (hr != 0) return;

        IntPtr output;
        hr = Fn<EnumOutputsDel>(adapter, 7)(adapter, 0, out output);
        Console.WriteLine("EnumOutputs(0) hr=0x" + hr.ToString("X"));
        if (hr != 0) return;

        // DXGI_OUTPUT_DESC: WCHAR[32] RECT BOOL Rotation HMONITOR = 96 bytes
        IntPtr descBuf = Marshal.AllocHGlobal(96);
        Fn<GetDescDel>(output, 7)(output, descBuf);
        string name = Marshal.PtrToStringUni(descBuf);
        RECT r = (RECT)Marshal.PtrToStructure(descBuf + 64, typeof(RECT));
        int attached = Marshal.ReadInt32(descBuf + 80);
        Console.WriteLine("Output '" + name + "' rect=(" + r.L + "," + r.T + ")-(" + r.R + "," + r.B + ") attached=" + attached);

        IntPtr dev, ctx; int fl;
        hr = D3D11CreateDevice(adapter, 0, IntPtr.Zero, 0x20, null, 0, 7, out dev, out fl, out ctx);
        Console.WriteLine("D3D11CreateDevice hr=0x" + hr.ToString("X") + " fl=0x" + fl.ToString("X"));
        if (hr != 0) return;

        // QI output → IDXGIOutput1 (00cddea8-...)
        Guid iidOut1 = new Guid("00cddea8-939b-4b83-a340-a685226666cc");
        IntPtr output1;
        hr = Marshal.QueryInterface(output, ref iidOut1, out output1);
        Console.WriteLine("QI Output1 hr=0x" + hr.ToString("X"));
        if (hr != 0) return;

        IntPtr dup;
        hr = Fn<DuplicateOutputDel>(output1, 22)(output1, dev, out dup);
        Console.WriteLine("DuplicateOutput hr=0x" + hr.ToString("X"));
        if (hr == 0) { Console.WriteLine("*** DUP OK — môi trường ổn, lỗi nằm trong daemon chính"); Release(dup); }
        else Console.WriteLine("*** DUP FAIL — vấn đề môi trường/session");
        Release(output1);
        Release(output); Release(adapter); Release(dev); Release(ctx); Release(factory);
    }

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int L, T, R, B; }
}
