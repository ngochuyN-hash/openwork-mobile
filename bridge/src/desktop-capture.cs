// Daemon chụp màn hình bằng DXGI Desktop Duplication (v4.0) — GPU ĐƯA THẲNG
// khung hình thay vì Windows chụp tay (BitBlt GDI ~85-105ms/khung). DWM đã pha
// màu màn hình trên GPU mỗi nhịp rồi; duplication chỉ mượn khung đã pha sẵn:
//   AcquireNextFrame (chờ tới khi màn ĐỔI — đây chính là bộ dò "đứng yên",
//   không cần hash) -> CopyResource về texture riêng -> ReleaseFrame
//   -> render 3 đỉnh thu nhỏ 2880x1800 -> 880x551 TRÊN GPU (shader compile
//   lúc khởi động bằng D3DCompile) -> staging Map 1.9MB về CPU
//   -> vẽ con trỏ chuột -> JPEG GDI+ -> stdout [4B len][1B type][payload].
// Trần thực đo trên máy nhà: 30-40 hình/s (nén JPEG là chi phí chính).
//
// Thứ tự vtable đã đối chiếu TỪNG SLOT với Windows SDK d3d11.h/dxgi1_2.h +
// chéo với AutoHotkey ScreenBuffer (Map=14, CopyResource=47, DuplicateOutput=22)
// — khai báo sai 1 slot là crash native, KHÔNG sửa thứ tự khi chưa kiểm chứng.
//
// stdin (dòng lệnh): PING | START|<width>|<quality> | STOP | KEY |
//   FOCUS|<x>|<y>|<w>|<h> | FOCUSOFF | QUIT
// Focus-rect zoom (học 9remote set-focus): khi phone đang PHÓNG, chỉ mã hóa +
// gửi vùng đang nhìn (crop = focus ∩ vùng đổi) — băng thông = đúng vùng nhìn
// dù master to = native (1920) để vùng đó nét thật; keyframe 2s trong focus
// cũng chỉ tươi cả vùng nhìn, không phải cả màn native. FOCUSOFF trả về crop
// vùng-đổi như cũ. Tọa độ theo khung chụp HIỆN HÀNH (targetW×targetH) — bridge
// quy đổi từ chuẩn hóa 0..1 rồi gửi lại mỗi khi meta đổi cỡ.
// stdout: nhị phân khung [4B BE len][1B type][payload]
//   0 = đứng yên (rỗng) · 1 = JPEG · 2 = meta JSON · 3 = lỗi JSON
// Máy yếu / máy ảo / thiếu GPU driver: daemon trả lỗi -> node tự rơi về
// đường GDI worker cũ (screen-capture.worker.js) — không gì vỡ.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Runtime.CompilerServices;

class DesktopCapture
{
    // ------------------------------------------------------------ interop
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO pci);
    [DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr hdc, int xLeft, int yTop, IntPtr hIcon, int cxWidth, int cyWidth, uint istepIfAniCur, IntPtr hbrFlickerFreeDraw, uint diFlags);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int nIndex);
    [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid riid, out IDXGIFactory1 ppFactory);
    [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr pAdapter, int DriverType, IntPtr Software, int Flags, int[] pFeatureLevels, int FeatureLevels, int SDKVersion, out IntPtr ppDevice, out int pFeatureLevel, out IntPtr ppImmediateContext);
    [DllImport("d3dcompiler_47.dll")] static extern int D3DCompile(IntPtr pSrcData, int SrcDataSize, string pSourceName, IntPtr pDefines, IntPtr pInclude, string pEntryPoint, string pTarget, int Flags1, int Flags2, out IntPtr ppCode, out IntPtr ppErrorMsgs);

    const int SM_CXCURSOR = 13, SM_CYCURSOR = 14;
    const uint DI_NORMAL = 3;
    const int S_OK = 0;
    const int DXGI_ERROR_WAIT_TIMEOUT = unchecked((int)0x87A00027);
    const int DXGI_ERROR_ACCESS_LOST = unchecked((int)0x887A0026);
    const int E_ACCESSDENIED = unchecked((int)0x80070005);

    // ---- COM interfaces: method PHẢI khai đúng thứ tự vtable (slot 3 trở đi
    // sau QueryInterface/AddRef/Release). Slot đã ghi chú bên cạnh từng hàm.
    [ComImport, Guid("770aae78-f26f-4dba-a829-253c83d1b387"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDXGIFactory1
    {
        void StubObj1(); void StubObj2(); void StubObj3(); void StubObj4(); // 3-6 IDXGIObject
        [PreserveSig] int EnumAdapters(uint Adapter, out IDXGIAdapter1 ppAdapter);        // 7
        void StubF1(); void StubF2(); void StubF3(); void StubF4();         // 8-11
        void StubF5(); void StubF6();                                        // 12-13 IDXGIFactory1
    }

    [ComImport, Guid("29038f61-3839-4626-91fd-086879011a05"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDXGIAdapter1
    {
        void StubObj1(); void StubObj2(); void StubObj3(); void StubObj4(); // 3-6
        [PreserveSig] int EnumOutputs(uint Output, out IDXGIOutput ppOutput);             // 7
        void StubA1(); void StubA2(); void StubA3();                        // 8-10
    }

    [ComImport, Guid("ae02eedb-c735-4690-8d52-5a8dc20213aa"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDXGIOutput
    {
        void StubObj1(); void StubObj2(); void StubObj3(); void StubObj4(); // 3-6
        void GetDesc(out DXGI_OUTPUT_DESC pDesc);                           // 7
        void StubO1(); void StubO2(); void StubO3(); void StubO4();         // 8-11
        void StubO5(); void StubO6(); void StubO7(); void StubO8();         // 12-15
        void StubO9(); void StubO10(); void StubO11(); void StubO12();      // 16-18
    }

    [ComImport, Guid("00cddea8-939b-4b83-a340-a685226666cc"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDXGIOutput1
    {
        void StubObj1(); void StubObj2(); void StubObj3(); void StubObj4(); // 3-6
        void StubOut1(); void StubOut2(); void StubOut3(); void StubOut4(); // 7-10 (IDXGIOutput)
        void StubOut5(); void StubOut6(); void StubOut7(); void StubOut8(); // 11-14
        void StubOut9(); void StubOut10(); void StubOut11(); void StubOut12();// 15-18
        void StubOut13(); void StubOut14(); void StubOut15();               // 19-21 (Output1)
        [PreserveSig] int DuplicateOutput(IntPtr pDevice, out IDXGIOutputDuplication ppOutputDuplication); // 22
    }

    [ComImport, Guid("191cfac3-a341-470d-b26e-a864f428319c"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDXGIOutputDuplication
    {
        void StubObj1(); void StubObj2(); void StubObj3(); void StubObj4(); // 3-6
        void StubD1();                                                       // 7 GetDesc
        [PreserveSig] int AcquireNextFrame(int TimeoutInMilliseconds, ref DXGI_OUTDUPL_FRAME_INFO pFrameInfo, out IntPtr ppDesktopResource); // 8 — raw pointer, khỏi QI
        void StubD2(); void StubD3(); void StubD4();                        // 9-11
        void StubD5();                                                       // 12 MapDesktopSurface
        void StubD6();                                                       // 13 UnMapDesktopSurface
        [PreserveSig] int ReleaseFrame();                                                  // 14
    }

    [ComImport, Guid("db6f6ddb-ac77-4e88-8253-819df9bbf140"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ID3D11Device
    {
        [PreserveSig] int CreateBuffer(IntPtr desc, IntPtr initData, out IntPtr ppBuffer);            // 3
        void StubDev1();                                                                 // 4 CreateTexture1D
        [PreserveSig] int CreateTexture2D(ref D3D11_TEXTURE2D_DESC pDesc, IntPtr pInitialData, out IntPtr ppTexture2D); // 5
        void StubDev2();                                                                 // 6 CreateTexture3D
        [PreserveSig] int CreateShaderResourceView(IntPtr pResource, IntPtr pDesc, out IntPtr ppSRView); // 7 (desc NULL = mặc định)
        void StubDev3();                                                                 // 8 UAV
        [PreserveSig] int CreateRenderTargetView(IntPtr pResource, IntPtr pDesc, out IntPtr ppRTView); // 9 (desc NULL)
        void StubDev4();                                                                 // 10 DSV
        void StubDev5();                                                                 // 11 InputLayout
        [PreserveSig] int CreateVertexShader(IntPtr pShaderBytecode, int BytecodeLength, IntPtr pClassLinkage, out IntPtr ppVertexShader); // 12
        void StubDev6(); void StubDev7();                                                // 13-14 GS
        [PreserveSig] int CreatePixelShader(IntPtr pShaderBytecode, int BytecodeLength, IntPtr pClassLinkage, out IntPtr ppPixelShader);   // 15
        void StubDev8(); void StubDev9(); void StubDev10(); void StubDev11();            // 16-19
        void StubDev12();                                                                // 20 BlendState
        void StubDev13();                                                                // 21 DepthStencilState
        void StubDev14();                                                                // 22 RasterizerState (không cần — default ok)
        [PreserveSig] int CreateSamplerState(ref D3D11_SAMPLER_DESC pDesc, out IntPtr ppSamplerState); // 23
        void StubDev15(); void StubDev16(); void StubDev17(); void StubDev18();          // 24-27
        void StubDev19(); void StubDev20(); void StubDev21(); void StubDev22();          // 28-31
        void StubDev23(); void StubDev24(); void StubDev25(); void StubDev26(); void StubDev27(); // 32-36
        void StubDev28(); void StubDev29(); void StubDev30();                            // 37-39
        [PreserveSig] int GetImmediateContext(out IntPtr ppImmediateContext);                // 40
    }

    [ComImport, Guid("c0bfa96c-e089-44fb-8eaf-26f8796190da"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ID3D11DeviceContext
    {
        void StubChild1(); void StubChild2(); void StubChild3(); void StubChild4();      // 3-6 ID3D11DeviceChild
        void VSSetConstantBuffersStub();                                                  // 7
        [PreserveSig] int PSSetShaderResources(uint StartSlot, uint NumViews, ref IntPtr ppSRViews);  // 8
        [PreserveSig] int PSSetShader(IntPtr pPixelShader, IntPtr ppClassInstances, uint NumClassInstances); // 9
        [PreserveSig] int PSSetSamplers(uint StartSlot, uint NumSamplers, ref IntPtr ppSamplers);     // 10
        [PreserveSig] int VSSetShader(IntPtr pVertexShader, IntPtr ppClassInstances, uint NumClassInstances); // 11
        void DrawIndexedStub();                                                           // 12
        [PreserveSig] int Draw(uint VertexCount, uint StartVertexLocation);                            // 13
        [PreserveSig] int Map(IntPtr pResource, uint Subresource, uint MapType, uint MapFlags, out D3D11_MAPPED_SUBRESOURCE pMappedSubresource); // 14
        [PreserveSig] int Unmap(IntPtr pResource, uint Subresource);                                   // 15
        void StubCtx1(); void StubCtx2(); void StubCtx3(); void StubCtx4();               // 16-19
        void StubCtx5(); void StubCtx6();                                                 // 20-21
        void StubCtx7(); void StubCtx7b();                                                // 22-23
        [PreserveSig] int IASetPrimitiveTopology(uint Topology);                                       // 24
        void StubCtx8(); void StubCtx9();                                                 // 25-26
        void StubCtx10(); void StubCtx11(); void StubCtx12(); void StubCtx13();           // 27-30
        void StubCtx14(); void StubCtx15();                                               // 31-32
        [PreserveSig] int OMSetRenderTargets(uint NumViews, ref IntPtr ppRenderTargetViews, IntPtr pDepthStencilView); // 33
        void StubCtx16(); void StubCtx17(); void StubCtx18(); void StubCtx19();           // 34-37
        void StubCtx20(); void StubCtx21(); void StubCtx22(); void StubCtx23();           // 38-41
        void StubCtx24();                                                                 // 42
        void RSSetStateStub();                                                            // 43
        [PreserveSig] int RSSetViewports(uint NumViewports, ref D3D11_VIEWPORT pViewports);            // 44
        void StubCtx25(); void StubCtx26();                                               // 45-46
        [PreserveSig] int CopyResource(IntPtr pDstResource, IntPtr pSrcResource);                      // 47
    }

    [ComImport, Guid("8ba5fb08-5195-40e2-ac58-0d989c3a0102"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ID3DBlob
    {
        IntPtr GetBufferPointer(); // 3
        UIntPtr GetBufferSize();   // 4
    }

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int L, T, R, B; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct DXGI_OUTPUT_DESC
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
        public RECT DesktopCoordinates;
        public int AttachedToDesktop;
        public int Rotation;
        public IntPtr Monitor;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct DXGI_OUTDUPL_FRAME_INFO
    {
        public long LastPresentTime;
        public long LastUpdateTime;
        public long SyncQPCTime;
        public long SyncRefreshTime;
        public uint AccumulatedFrames;
        public int RectsCoalesced;
        public int ProtectedContentMaskedOut;
        public int PointerX; public int PointerY; public int PointerVisible;
        public uint TotalMetadataBufferSize;
        public uint PointerShapeBufferSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct D3D11_TEXTURE2D_DESC
    {
        public uint Width, Height, MipLevels, ArraySize;
        public int Format;
        public uint SampleCount, SampleQuality;
        public int Usage, BindFlags, CPUAccessFlags, MiscFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct D3D11_VIEWPORT { public float TopLeftX, TopLeftY, Width, Height, MinDepth, MaxDepth; }

    [StructLayout(LayoutKind.Sequential)]
    struct D3D11_MAPPED_SUBRESOURCE { public IntPtr pData; public uint RowPitch, DepthPitch; }

    [StructLayout(LayoutKind.Sequential)]
    struct D3D11_SAMPLER_DESC
    {
        public int Filter, AddressU, AddressV, AddressW;
        public float MipLODBias;
        public uint MaxAnisotropy;
        public int ComparisonFunc;
        public float BorderColor0, BorderColor1, BorderColor2, BorderColor3;
        public float MinLOD, MaxLOD;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct CURSORINFO
    {
        public int cbSize; public int flags; public IntPtr hCursor; public Point ptScreenPos;
    }

    // ------------------------------------------------------------ state
    static IDXGIFactory1 factory;
    static IDXGIAdapter1 adapter;
    static IDXGIOutput output;
    static IDXGIOutput1 output1;
    static IntPtr output1Ptr; // con trỏ COM thô của output1 (duplication gọi vtable tay)
    static IntPtr duplication; // raw pointer — RCW typed từng fail QI 13/09
    delegate int DuplicateOutputDel(IntPtr self, IntPtr device, out IntPtr dup);
    delegate int AcquireNextFrameDel(IntPtr self, int timeoutMs, ref DXGI_OUTDUPL_FRAME_INFO info, out IntPtr desktopResource);
    delegate int ReleaseFrameDel(IntPtr self);
    static T Fn<T>(IntPtr obj, int slot) where T : class
    {
        IntPtr vt = Marshal.ReadIntPtr(obj);
        IntPtr fn = Marshal.ReadIntPtr(vt, slot * IntPtr.Size);
        return (T)(object)Marshal.GetDelegateForFunctionPointer(fn, typeof(T));
    }
    static ID3D11Device device;
    static ID3D11DeviceContext ctx;
    static IntPtr devTexture;   // bản copy full-size của desktop (GPU)
    static IntPtr devSRV;       // SRV của devTexture (tạo 1 lần)
    static IntPtr vsBlob, psBlob; // raw ID3DBlob pointer — gọi vtable thủ công
    static IntPtr vertexShader, pixelShader, sampler;
    static int screenW, screenH;
    static int targetW = 880, targetH = 551, quality = 55;
    static IntPtr smallRT, smallRTV, staging;
    // Hàng đợi pixel giữa capture-thread và encode-thread (pipeline song song:
    // acquire+GPU+map ~10ms || encode JPEG ~15ms — từng nối chuỗi giữ fps ở 21).
    class EncodeJob { public byte[] Pixels; public RECT? Crop; } // Crop=null → full frame
    static System.Collections.Concurrent.ConcurrentQueue<EncodeJob> encodeQueue = new System.Collections.Concurrent.ConcurrentQueue<EncodeJob>();
    static volatile bool encodeAlive = false;
    static byte[] lastPixels;   // bản cache (row-pitch layout) để vẽ con trỏ khi màn đứng yên
    static int lastPitch;
    static long lastCursorX = long.MinValue, lastCursorY = long.MinValue;
    static long lastKeyframeMs; // đầy 2s là ép nén nguyên khung (người vào trễ tự lành)
    static volatile bool nextFull = true; // khung đầu + lệnh KEY (viewer mới) = full
    static volatile bool keyWanted = false; // KEY tới lúc màn đang im → đánh thức duplication
    static volatile bool forceNextCapture = false; // one-shot: chụp khung kế bất kể màn có đổi (sau START / sau re-dup)
    static long lastSentMs;     // gate 40fps
    static long lastHeartbeatMs;
    static volatile bool streaming = false;
    static volatile bool quitting = false;
    static volatile bool pendingReconfigure = false;
    // Focus-rect zoom: vùng đang nhìn (targetW×targetH, chuẩn bị intersect với
    // vùng đổi mỗi nhịp). null = tắt — crop vùng-đổi như cũ.
    static RECT? focusRect = null;
    static Stream stdout;
    static object stdoutLock = new object();

    const int FRAME_JPEG = 1, FRAME_META = 2, FRAME_ERROR = 3, FRAME_UNCHANGED = 0;
    const int MIN_SEND_INTERVAL_MS = 25;   // trần 40 hình/s
    const int ACQUIRE_TIMEOUT_MS = 50;

    const string HLSL_VS = @"
struct VSOut { float4 pos : SV_Position; float2 uv : TEXCOORD; };
VSOut VSMain(uint id : SV_VertexID) {
  VSOut o;
  o.uv = float2((id << 1) & 2, id & 2);
  o.pos = float4(o.uv.x * 2.0 - 1.0, 1.0 - o.uv.y * 2.0, 0.0, 1.0);
  return o;
}";
    const string HLSL_PS = @"
Texture2D tex : register(t0);
SamplerState samp : register(s0);
float4 PSMain(float4 pos : SV_Position, float2 uv : TEXCOORD) : SV_Target {
  return tex.Sample(samp, uv);
}";

    static void Main()
    {
        SetProcessDPIAware();
        stdout = Console.OpenStandardOutput();
        try
        {
            InitDx();
        }
        catch (Exception ex)
        {
            Send(FRAME_ERROR, Encoding.UTF8.GetBytes(JsonErr("init: " + ex.Message)));
            Environment.Exit(1);
        }
        Thread cap = new Thread(CaptureLoop);
        cap.IsBackground = true;
        cap.Start();
        Thread enc = new Thread(EncodeLoop);
        enc.IsBackground = true;
        enc.Start();
        // Main thread đọc lệnh từ stdin
        string line;
        while ((line = Console.ReadLine()) != null)
        {
            line = line.Trim();
            if (line == "QUIT") break;
            if (line == "PING")
            {
                Send(FRAME_META, Encoding.UTF8.GetBytes("{\"screenW\":" + screenW + ",\"screenH\":" + screenH + ",\"ping\":true}"));
                continue;
            }
            if (line == "STOP")
            {
                streaming = false;
                continue;
            }
            if (line == "KEY") { nextFull = true; keyWanted = true; continue; } // viewer mới vào — khung kế nén full
            if (line.StartsWith("FOCUS|"))
            {
                // Focus-rect zoom: vùng nhìn do phone báo (px, khung chụp hiện hành).
                // nextFull + keyWanted = khung kế tươi cả vùng nhìn dù màn đang im
                // (re-dup như KEY); biên được intersect với khung thật mỗi nhịp chụp.
                string[] p = line.Split('|');
                try
                {
                    int fx = int.Parse(p[1]), fy = int.Parse(p[2]), fw = int.Parse(p[3]), fh = int.Parse(p[4]);
                    if (fw > 0 && fh > 0)
                    {
                        focusRect = new RECT { L = fx, T = fy, R = fx + fw, B = fy + fh };
                        nextFull = true;
                        keyWanted = true;
                    }
                }
                catch { }
                continue;
            }
            if (line == "FOCUSOFF") { focusRect = null; nextFull = true; continue; }
            if (line.StartsWith("START|"))
            {
                string[] p = line.Split('|');
                int w = targetW, q = quality;
                if (p.Length >= 2) w = Math.Max(320, Math.Min(1920, int.Parse(p[1])));
                if (p.Length >= 3) q = Math.Max(30, Math.Min(85, int.Parse(p[2])));
                // Tạo texture là việc của capture thread (đụng D3D chung) —
                // main thread chỉ ghi ý định, vòng chụp áp đầu nhịp kế.
                targetW = w; quality = q;
                targetH = Math.Max(1, (int)Math.Round(screenH * (double)w / screenW));
                pendingReconfigure = true;
                streaming = true;
                Send(FRAME_META, Encoding.UTF8.GetBytes("{\"screenW\":" + screenW + ",\"screenH\":" + screenH + ",\"shotW\":" + targetW + ",\"shotH\":" + targetH + ",\"quality\":" + quality + "}"));
            }
        }
        quitting = true;
        streaming = false;
        Thread.Sleep(150);
        Environment.Exit(0);
    }

    static string JsonErr(string m) { return "{\"message\":\"" + m.Replace("\"", "'").Replace("\r", " ").Replace("\n", " ") + "\"}"; }

    static void Send(int type, byte[] payload)
    {
        lock (stdoutLock)
        {
            byte[] head = new byte[5];
            uint len = payload == null ? 0u : (uint)payload.Length;
            head[0] = (byte)(len >> 24); head[1] = (byte)(len >> 16); head[2] = (byte)(len >> 8); head[3] = (byte)len;
            head[4] = (byte)type;
            stdout.Write(head, 0, 5);
            if (payload != null && payload.Length > 0) stdout.Write(payload, 0, payload.Length);
            stdout.Flush();
        }
    }

    // ------------------------------------------------------------ D3D init
    static void InitDx()
    {
        Guid factoryIid = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
        int hr = CreateDXGIFactory1(ref factoryIid, out factory);
        if (hr != S_OK) throw new Exception("CreateDXGIFactory1 hr=0x" + hr.ToString("X"));

        // Tìm adapter/output CHÍNH (đính desktop, gốc (0,0))
        StringBuilder trace = new StringBuilder();
        uint ai = 0;
        while (true)
        {
            IDXGIAdapter1 ad;
            int hrA = factory.EnumAdapters(ai, out ad);
            trace.Append("A").Append(ai).Append("=0x").Append(hrA.ToString("X")).Append(" ");
            if (hrA != S_OK) break;
            uint oi = 0;
            while (true)
            {
                IDXGIOutput op;
                int hrO = ad.EnumOutputs(oi, out op);
                trace.Append("O").Append(ai).Append(".").Append(oi).Append("=0x").Append(hrO.ToString("X")).Append(" ");
                if (hrO != S_OK) break;
                DXGI_OUTPUT_DESC d;
                op.GetDesc(out d);
                trace.Append("[(").Append(d.DesktopCoordinates.L).Append(",").Append(d.DesktopCoordinates.T)
                     .Append(" ").Append(d.DesktopCoordinates.R - d.DesktopCoordinates.L).Append("x")
                     .Append(d.DesktopCoordinates.B - d.DesktopCoordinates.T)
                     .Append(") att=").Append(d.AttachedToDesktop).Append("] ");
                if (d.AttachedToDesktop != 0)
                {
                    adapter = ad; output = op;
                    if (d.DesktopCoordinates.L == 0 && d.DesktopCoordinates.T == 0) goto found;
                }
                oi++;
            }
            ai++;
        }
        if (output == null) throw new Exception("không tìm thấy output nào đính desktop: " + trace.ToString());
    found:
        DXGI_OUTPUT_DESC od;
        output.GetDesc(out od);
        screenW = od.DesktopCoordinates.R - od.DesktopCoordinates.L;
        screenH = od.DesktopCoordinates.B - od.DesktopCoordinates.T;

        IntPtr dev, ictx;
        // D3D11_DRIVER_TYPE_UNKNOWN=0 vì có adapter; BGRA_SUPPORT=0x20; SDK 7
        IntPtr adapterUnk = Marshal.GetIUnknownForObject(adapter);
        hr = D3D11CreateDevice(adapterUnk, 0, IntPtr.Zero, 0x20, null, 0, 7, out dev, out featLevel_, out ictx);
        Marshal.Release(adapterUnk);
        if (hr != S_OK) throw new Exception("D3D11CreateDevice hr=0x" + hr.ToString("X"));
        device = (ID3D11Device)Marshal.GetObjectForIUnknown(dev);
        ctx = (ID3D11DeviceContext)Marshal.GetObjectForIUnknown(ictx);
        Marshal.Release(dev); Marshal.Release(ictx);

        // Texture full-size hứng desktop (SHADER_RESOURCE=8)
        D3D11_TEXTURE2D_DESC dd = Desc2D(screenW, screenH, 8 /*BIND_SHADER_RESOURCE*/, 0 /*DEFAULT*/, 0);
        hr = device.CreateTexture2D(ref dd, IntPtr.Zero, out devTexture);
        if (hr != S_OK) throw new Exception("CreateTexture2D dev hr=0x" + hr.ToString("X"));
        hr = device.CreateShaderResourceView(devTexture, IntPtr.Zero, out devSRV);
        if (hr != S_OK) throw new Exception("CreateSRV hr=0x" + hr.ToString("X"));

        // Shader thu nhỏ — compile runtime
        vsBlob = Compile(HLSL_VS, "VSMain", "vs_4_0");
        psBlob = Compile(HLSL_PS, "PSMain", "ps_4_0");
        int vsLen = BlobSize(vsBlob);
        hr = device.CreateVertexShader(BlobPointer(vsBlob), vsLen, IntPtr.Zero, out vertexShader);
        if (hr != S_OK) throw new Exception("CreateVertexShader hr=0x" + hr.ToString("X") + " len=" + vsLen);
        int psLen = BlobSize(psBlob);
        hr = device.CreatePixelShader(BlobPointer(psBlob), psLen, IntPtr.Zero, out pixelShader);
        if (hr != S_OK) throw new Exception("CreatePixelShader hr=0x" + hr.ToString("X"));

        D3D11_SAMPLER_DESC sd;
        sd.Filter = 21 /*D3D11_FILTER_MIN_MAG_LINEAR_MIP_POINT*/; // linear thu nhỏ
        sd.AddressU = sd.AddressV = sd.AddressW = 1 /*WRAP*/;
        sd.MipLODBias = 0; sd.MaxAnisotropy = 1; sd.ComparisonFunc = 0;
        sd.BorderColor0 = sd.BorderColor1 = sd.BorderColor2 = sd.BorderColor3 = 0;
        sd.MinLOD = 0; sd.MaxLOD = 0;
        hr = device.CreateSamplerState(ref sd, out sampler);
        if (hr != S_OK) throw new Exception("CreateSamplerState hr=0x" + hr.ToString("X"));

        output1Ptr = Marshal.GetIUnknownForObject(output);
        // QI sang IDXGIOutput1 bằng tay để có con trỏ đúng interface (slot 22 DuplicateOutput)
        Guid iidOut1 = new Guid("00cddea8-939b-4b83-a340-a685226666cc");
        IntPtr o1;
        Marshal.QueryInterface(output1Ptr, ref iidOut1, out o1);
        Marshal.Release(output1Ptr);
        output1Ptr = o1;
        output1 = (IDXGIOutput1)output;
        ReinitDuplication();
        EnsureSmallTextures();
    }
    static int featLevel_;

    static D3D11_TEXTURE2D_DESC Desc2D(int w, int h, int bind, int usage, int cpu)
    {
        D3D11_TEXTURE2D_DESC d;
        d.Width = (uint)w; d.Height = (uint)h; d.MipLevels = 1; d.ArraySize = 1;
        d.Format = 87 /*B8G8R8A8_UNORM*/;
        d.SampleCount = 1; d.SampleQuality = 0;
        d.Usage = usage; d.BindFlags = bind; d.CPUAccessFlags = cpu; d.MiscFlags = 0;
        return d;
    }

    // ID3DBlob gọi vtable THỦ CÔNG (slot 3 GetBufferPointer, 4 GetBufferSize) —
    // RCW qua GUID từng crash native ("protected memory") 13/09; raw pointer +
    // delegate là đường chắc chắn tuyệt đối, không phụ thuộc khai báo interface.
    delegate IntPtr BlobPtrDel(IntPtr self);
    delegate UIntPtr BlobSizeDel(IntPtr self);
    static IntPtr BlobPointer(IntPtr blob)
    {
        IntPtr vt = Marshal.ReadIntPtr(blob);
        IntPtr fn = Marshal.ReadIntPtr(vt, 3 * IntPtr.Size);
        return ((BlobPtrDel)Marshal.GetDelegateForFunctionPointer(fn, typeof(BlobPtrDel)))(blob);
    }
    static int BlobSize(IntPtr blob)
    {
        IntPtr vt = Marshal.ReadIntPtr(blob);
        IntPtr fn = Marshal.ReadIntPtr(vt, 4 * IntPtr.Size);
        return (int)((BlobSizeDel)Marshal.GetDelegateForFunctionPointer(fn, typeof(BlobSizeDel)))(blob).ToUInt64();
    }

    static IntPtr Compile(string src, string entry, string target)
    {
        byte[] bytes = Encoding.ASCII.GetBytes(src);
        IntPtr buf = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, buf, bytes.Length);
        IntPtr code, errs;
        int hr = D3DCompile(buf, bytes.Length, null, IntPtr.Zero, IntPtr.Zero, entry, target, 0, 0, out code, out errs);
        Marshal.FreeHGlobal(buf);
        if (hr != S_OK)
        {
            string m = "D3DCompile hr=0x" + hr.ToString("X");
            if (errs != IntPtr.Zero)
            {
                IntPtr p = BlobPointer(errs); int n = BlobSize(errs);
                if (p != IntPtr.Zero && n > 0) m += " " + Marshal.PtrToStringAnsi(p, Math.Min(n, 500));
            }
            throw new Exception(m);
        }
        return code;
    }

    static void ReinitDuplication()
    {
        if (duplication != IntPtr.Zero) { Marshal.Release(duplication); duplication = IntPtr.Zero; }
        IntPtr dup;
        IntPtr devUnk = Marshal.GetIUnknownForObject(device);
        int hr = Fn<DuplicateOutputDel>(output1Ptr, 22)(output1Ptr, devUnk, out dup);
        Marshal.Release(devUnk);
        if (hr != S_OK) throw new Exception("DuplicateOutput hr=0x" + hr.ToString("X"));
        duplication = dup;
    }

    static void EnsureSmallTextures()
    {
        targetH = Math.Max(1, (int)Math.Round(screenH * (double)targetW / screenW));
        // Render target nhỏ (BIND_RENDER_TARGET=0x20) + staging đọc CPU (USAGE_STAGING=3, CPU_READ=0x20000)
        D3D11_TEXTURE2D_DESC rt = Desc2D(targetW, targetH, 0x20 /*RENDER_TARGET*/, 0, 0);
        IntPtr old = smallRT;
        int hr = device.CreateTexture2D(ref rt, IntPtr.Zero, out smallRT);
        if (hr != S_OK) throw new Exception("CreateTexture2D rt hr=0x" + hr.ToString("X"));
        if (old != IntPtr.Zero) Marshal.Release(old);
        hr = device.CreateRenderTargetView(smallRT, IntPtr.Zero, out smallRTV);
        if (hr != S_OK) throw new Exception("CreateRTV hr=0x" + hr.ToString("X"));
        D3D11_TEXTURE2D_DESC st = Desc2D(targetW, targetH, 0, 3 /*STAGING*/, 0x20000 /*CPU_READ*/);
        old = staging;
        hr = device.CreateTexture2D(ref st, IntPtr.Zero, out staging);
        if (hr != S_OK) throw new Exception("CreateTexture2D staging hr=0x" + hr.ToString("X"));
        if (old != IntPtr.Zero) Marshal.Release(old);
        lastPixels = new byte[lastPitch0(targetW, targetH)];
        lastPitch = lastPitch0(targetW, targetH);
        // viewport
        D3D11_VIEWPORT vp; vp.TopLeftX = 0; vp.TopLeftY = 0;
        vp.Width = targetW; vp.Height = targetH; vp.MinDepth = 0; vp.MaxDepth = 1;
        ctx.RSSetViewports(1, ref vp);
    }
    static int lastPitch0(int w, int h) { return w * 4; } // RowPitch thật đọc từ Map — cache theo pitch đó

    // ------------------------------------------------------------ capture loop
    static void CaptureLoop()
    {
        Stopwatch clock = Stopwatch.StartNew();
        int accessLostStreak = 0;
        while (!quitting)
        {
            try
            {
                if (!streaming || duplication == IntPtr.Zero) { Thread.Sleep(50); continue; }
                if (pendingReconfigure)
                {
                    pendingReconfigure = false;
                    try { EnsureSmallTextures(); } catch (Exception ex) { throw new Exception("reconfig-step: " + ex.Message); }
                    lastPixels = null;
                    lastCursorX = long.MinValue;
                    // Khung ĐẦU sau START phải đi ngay kể cả màn đang im — viewer mới
                    // chờ khung full để có nền (nextFull chỉ ăn khi có frame được acquire).
                    forceNextCapture = true;
                }
                DXGI_OUTDUPL_FRAME_INFO info = new DXGI_OUTDUPL_FRAME_INFO();
                IntPtr desktopRes;
                long tA = Environment.TickCount;
                int hr = Fn<AcquireNextFrameDel>(duplication, 8)(duplication, ACQUIRE_TIMEOUT_MS, ref info, out desktopRes);
                statAcquireMs += Environment.TickCount - tA;
                if (hr == DXGI_ERROR_WAIT_TIMEOUT)
                {
                    if (keyWanted)
                    {
                        // Viewer mới vào lúc màn đang im: AcquireNextFrame không bao giờ
                        // trả frame → khung full cho viewer không bao giờ tới (màn hình
                        // đen trên phone). Re-duplication để acquire kế trả khung HIỆN
                        // TẠI (frame đầu sau DuplicateOutput luôn có), ép chụp + full.
                        keyWanted = false;
                        try { ReinitDuplication(); forceNextCapture = true; } catch { }
                    }
                    Heartbeat(clock);
                    continue;
                }
                if (hr == DXGI_ERROR_ACCESS_LOST || hr == E_ACCESSDENIED)
                {
                    Fn<ReleaseFrameDel>(duplication, 14)(duplication);
                    accessLostStreak++;
                    if (accessLostStreak > 20) { Send(FRAME_ERROR, Encoding.UTF8.GetBytes(JsonErr("duplication mất quyền truy cập lặp lại"))); streaming = false; accessLostStreak = 0; continue; }
                    Thread.Sleep(200);
                    try { ReinitDuplication(); } catch { }
                    continue;
                }
                if (hr != S_OK) { Thread.Sleep(100); continue; }
                accessLostStreak = 0;

                bool contentChanged = info.LastPresentTime != 0;
                bool cursorMoved = (info.PointerX != lastCursorX || info.PointerY != lastCursorY) && info.PointerVisible != 0;
                lastCursorX = info.PointerX; lastCursorY = info.PointerY;

                // Copy desktop về texture riêng rồi ReleaseFrame NGAY để khung kế không kẹt.
                // CopyResource cần ID3D11Texture2D* — QI thủ công từ resource raw pointer
                // (GUID 6f15aaf2... đã verify đa nguồn; truyền thẳng IDXGIResource* từng làm
                // khung đen thui vì runtime đọc sai vtable).
                long now = clock.ElapsedMilliseconds;
                bool sendDue = now - lastSentMs >= MIN_SEND_INTERVAL_MS;
                bool captureNow = contentChanged || forceNextCapture;
                if (captureNow && sendDue && desktopRes != IntPtr.Zero)
                {
                    forceNextCapture = false;
                    long tC = Environment.TickCount;
                    bool ok = CapturePixels(desktopRes);
                    statCaptureMs += Environment.TickCount - tC;
                    if (ok) { lastSentMs = now; statFrames++; }
                }
                else if (!contentChanged && cursorMoved && sendDue && lastPixels != null && encodeQueue.Count == 0)
                {
                    Send(FRAME_UNCHANGED, null); // cursor-only không nén lại — heartbeat đủ
                    lastSentMs = now;
                }
                else
                {
                    Heartbeat(clock);
                }
                DumpStats();
                try { Fn<ReleaseFrameDel>(duplication, 14)(duplication); } catch { }
                Marshal.Release(desktopRes);
            }
            catch (Exception ex)
            {
                Send(FRAME_ERROR, Encoding.UTF8.GetBytes(JsonErr("loop: " + ex.Message)));
                Thread.Sleep(500);
            }
        }
    }

    /** Giao của 2 hình chữ nhật — trả về 0,0,0,0 khi rời nhau (gọi nhiều lần/nhịp). */
    static RECT Intersect(RECT a, RECT b)
    {
        int l = Math.Max(a.L, b.L), t = Math.Max(a.T, b.T);
        int r = Math.Min(a.R, b.R), btm = Math.Min(a.B, b.B);
        if (r <= l || btm <= t) return new RECT { L = 0, T = 0, R = 0, B = 0 };
        return new RECT { L = l, T = t, R = r, B = btm };
    }

    /**
     * Vùng ĐỔI giữa 2 frame nhỏ (driver này KHÔNG trả metadata dirty rects —
     * AMD trả TotalMetadataBufferSize=0, dính thật 13/09 — nên tự so như 9remote,
     * nhưng trên frame đã thu nhỏ 1.9MB nên rẻ hơn nhiều lần). Trả null = giống hệt.
     * Con trỏ cũ/mới cộng vào bbox vì cursor vẽ ở encode thread (CPU).
     */
    static unsafe RECT DiffBbox(byte[] prev, byte[] cur, int pitch, int w, int h)
    {
        RECT box = new RECT();
        fixed (byte* a = prev, b = cur)
        {
            int firstRow = -1, lastRow = -1;
            int words = (w * 4) / 8;
            for (int y = 0; y < h; y++)
            {
                byte* ra = a + (long)y * pitch, rb = b + (long)y * pitch;
                bool diff = false;
                for (int i = 0; i < words; i++) if (((long*)ra)[i] != ((long*)rb)[i]) { diff = true; break; }
                if (diff) { if (firstRow < 0) firstRow = y; lastRow = y; }
            }
            if (firstRow < 0) return new RECT { L = 0, T = 0, R = 0, B = 0 }; // giống hệt
            int L = w, R = 0;
            for (int x = 0; x < w; x += 4)
            {
                bool diff = false;
                for (int y = firstRow; y <= lastRow; y++)
                {
                    byte* ra = a + (long)y * pitch + x * 4, rb = b + (long)y * pitch + x * 4;
                    if (ra[0] != rb[0] || ra[1] != rb[1] || ra[2] != rb[2]) { diff = true; break; }
                }
                if (diff) { if (x < L) L = x; R = x + 4; }
            }
            if (R <= L) { L = 0; R = w; }
            box = new RECT { L = L, T = firstRow, R = R, B = lastRow + 1 };
        }
        // cursor cũ/mới (tọa độ frame nhỏ)
        double sx = (double)w / screenW, sy = (double)h / screenH;
        int cw = Math.Max(20, (int)(GetSystemMetrics(SM_CXCURSOR) * sx)) + 6;
        int ch = Math.Max(20, (int)(GetSystemMetrics(SM_CYCURSOR) * sy)) + 6;
        long cx = lastCursorX, cy = lastCursorY;
        if (cx > long.MinValue)
        {
            box.L = Math.Max(0, Math.Min(box.L, (int)(cx * sx) - cw));
            box.T = Math.Max(0, Math.Min(box.T, (int)(cy * sy) - ch));
            box.R = Math.Min(w, Math.Max(box.R, (int)(cx * sx) + cw));
            box.B = Math.Min(h, Math.Max(box.B, (int)(cy * sy) + ch));
        }
        // đệm 10px mỗi chiều cho ấm áp JPEG block
        box.L = Math.Max(0, box.L - 10); box.T = Math.Max(0, box.T - 10);
        box.R = Math.Min(w, box.R + 10); box.B = Math.Min(h, box.B + 10);
        return box;
    }

    /** Capture thread: chụp + render + map, đẩy pixel (hoặc null=cursor-only) vào queue. */
    static bool CapturePixels(IntPtr desktopRes)
    {
        Guid iidTex = new Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c");
        IntPtr tex;
        Marshal.QueryInterface(desktopRes, ref iidTex, out tex);
        if (tex == IntPtr.Zero) return false;
        try
        {
            ctx.CopyResource(devTexture, tex);
            try { Fn<ReleaseFrameDel>(duplication, 14)(duplication); } catch { }
            ctx.PSSetShaderResources(0, 1, ref devSRV);
            IntPtr ps = pixelShader; ctx.PSSetShader(ps, IntPtr.Zero, 0);
            IntPtr vs = vertexShader; ctx.VSSetShader(vs, IntPtr.Zero, 0);
            IntPtr smp = sampler; ctx.PSSetSamplers(0, 1, ref smp);
            ctx.IASetPrimitiveTopology(4 /*TRIANGLELIST*/);
            IntPtr rtv = smallRTV; ctx.OMSetRenderTargets(1, ref rtv, IntPtr.Zero);
            ctx.Draw(3, 0);
            IntPtr nullSrv = IntPtr.Zero; ctx.PSSetShaderResources(0, 1, ref nullSrv);
            ctx.CopyResource(staging, smallRT);
            D3D11_MAPPED_SUBRESOURCE mapped;
            int hr = ctx.Map(staging, 0, 1 /*READ*/, 0, out mapped);
            if (hr != S_OK) { Send(FRAME_ERROR, Encoding.UTF8.GetBytes(JsonErr("Map hr=0x" + hr.ToString("X")))); return false; }
            byte[] pixels;
            try
            {
                int pitch = (int)mapped.RowPitch;
                int bytes = pitch * targetH;
                pixels = new byte[bytes];
                Marshal.Copy(mapped.pData, pixels, 0, bytes);
                lastPitch = pitch;
            }
            finally { ctx.Unmap(staging, 0); }
            while (encodeQueue.Count >= 3) { EncodeJob drop; encodeQueue.TryDequeue(out drop); }
            RECT? crop = null;
            bool skip = false; // biến đổi nhưng NGOÀI vùng nhìn — không cần nén/gửi gì
            long nowMs = Environment.TickCount;
            // Focus-rect: vùng nhìn giới hạn trong khung thật (bridge có thể gửi
            // rect tính theo cỡ cũ khi daemon đang đổi cỡ — chống tràn biên).
            RECT? fv = null;
            if (focusRect != null)
            {
                RECT f = Intersect(focusRect.Value, new RECT { L = 0, T = 0, R = targetW, B = targetH });
                if (f.R > f.L && f.B > f.T) fv = f;
            }
            bool focusMode = fv != null;
            if (nextFull || nowMs - lastKeyframeMs >= 2000)
            {
                nextFull = false;
                lastKeyframeMs = nowMs;
                if (focusMode) crop = fv; // keyframe trong focus = tươi cả vùng nhìn, không phải cả màn native
            }
            else if (prevPixels != null && prevPixels.Length == pixels.Length)
            {
                RECT c = DiffBbox(prevPixels, pixels, lastPitch, targetW, targetH);
                if (c.R > c.L && c.B > c.T)
                {
                    if (focusMode)
                    {
                        RECT f = Intersect(fv.Value, c);
                        if (f.R > f.L && f.B > f.T) crop = f;
                        else skip = true; // mọi thay đổi đều ngoài vùng đang nhìn (video ở màn bên)
                    }
                    else if ((long)(c.R - c.L) * (c.B - c.T) * 10 < 6L * targetW * targetH) crop = c;
                }
                // R==L == 0: hai frame giống hệt (chỉ cursor vẽ CPU) — coi như crop cursor
                else if (lastCursorX > long.MinValue)
                {
                    double sx = (double)targetW / screenW, sy = (double)targetH / screenH;
                    int cw = Math.Max(20, (int)(GetSystemMetrics(SM_CXCURSOR) * sx)) + 6;
                    int ch = Math.Max(20, (int)(GetSystemMetrics(SM_CYCURSOR) * sy)) + 6;
                    RECT cur = new RECT
                    {
                        L = Math.Max(0, (int)(lastCursorX * sx) - cw), T = Math.Max(0, (int)(lastCursorY * sy) - ch),
                        R = Math.Min(targetW, (int)(lastCursorX * sx) + cw), B = Math.Min(targetH, (int)(lastCursorY * sy) + ch),
                    };
                    if (focusMode)
                    {
                        RECT f = Intersect(fv.Value, cur);
                        if (f.R > f.L && f.B > f.T) crop = f;
                        else skip = true; // con trỏ nằm ngoài vùng nhìn — không gửi (đỡ băng thông)
                    }
                    else crop = cur;
                }
            }
            prevPixels = pixels;
            if (!skip) encodeQueue.Enqueue(new EncodeJob { Pixels = pixels, Crop = crop });
            return true;
        }
        finally { Marshal.Release(tex); }
    }

    /** Encode thread: pixel -> vẽ con trỏ -> JPEG -> stdout (song song với capture kế). */
    static void EncodeLoop()
    {
        encodeAlive = true;
        Stopwatch clock = Stopwatch.StartNew();
        while (!quitting)
        {
            EncodeJob job;
            if (!encodeQueue.TryDequeue(out job))
            {
                Thread.Sleep(2);
                continue;
            }
            try
            {
                byte[] pixels = job.Pixels;
                if (pixels == null) continue;
                if (lastPixels == null || lastPixels.Length != pixels.Length) lastPixels = new byte[pixels.Length];
                Buffer.BlockCopy(pixels, 0, lastPixels, 0, pixels.Length);
                GCHandle pin = GCHandle.Alloc(lastPixels, GCHandleType.Pinned);
                try
                {
                    using (Bitmap full = new Bitmap(targetW, targetH, lastPitch, PixelFormat.Format32bppArgb, pin.AddrOfPinnedObject()))
                    {
                        int cx0 = 0, cy0 = 0, cw = targetW, ch = targetH;
                        RECT? crop = job.Crop;
                        Bitmap outBmp;
                        if (crop != null)
                        {
                            RECT c = crop.Value;
                            cx0 = c.L; cy0 = c.T; cw = c.R - c.L; ch = c.B - c.T;
                            Bitmap small = new Bitmap(cw, ch);
                            using (Graphics g = Graphics.FromImage(small))
                            {
                                // DrawPixelOffset nửa pixel cho nét khi copy nguyên-size
                                g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.Half;
                                g.DrawImage(full, new Rectangle(0, 0, cw, ch), new Rectangle(cx0, cy0, cw, ch), GraphicsUnit.Pixel);
                            }
                            outBmp = small;
                        }
                        else outBmp = full;
                        try
                        {
                            DrawCursorOffset(outBmp, cx0, cy0);
                            using (MemoryStream ms = new MemoryStream(1 << 16))
                            {
                                EncoderParameters ep = new EncoderParameters(1);
                                ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
                                outBmp.Save(ms, JpegCodec(), ep);
                                byte[] head = new byte[8];
                                head[0] = (byte)cx0; head[1] = (byte)(cx0 >> 8);
                                head[2] = (byte)cy0; head[3] = (byte)(cy0 >> 8);
                                head[4] = (byte)cw; head[5] = (byte)(cw >> 8);
                                head[6] = (byte)ch; head[7] = (byte)(ch >> 8);
                                byte[] payload = new byte[8 + (int)ms.Length];
                                System.Buffer.BlockCopy(head, 0, payload, 0, 8);
                                System.Buffer.BlockCopy(ms.GetBuffer(), 0, payload, 8, (int)ms.Length);
                                Send(FRAME_JPEG, payload);
                            }
                        }
                        finally { if (outBmp != full) outBmp.Dispose(); }
                    }
                }
                finally { pin.Free(); }
                lastHeartbeatMs = clock.ElapsedMilliseconds;
            }
            catch (Exception ex)
            {
                Send(FRAME_ERROR, Encoding.UTF8.GetBytes(JsonErr("encode: " + ex.Message)));
            }
        }
        encodeAlive = false;
    }

    static long statAcquireMs, statCaptureMs, statFrames;
    static byte[] prevPixels; // frame nhỏ trước đó (capture thread) — so vùng đổi
    static long statMark = Environment.TickCount;
    static void DumpStats()
    {
        if (Environment.TickCount - statMark >= 1000)
        {
            Console.Error.WriteLine("[stat] frames=" + statFrames + " acquire=" + statAcquireMs + "ms capture=" + statCaptureMs + "ms");
            statFrames = statAcquireMs = statCaptureMs = 0;
            statMark = Environment.TickCount;
        }
    }

    static void Heartbeat(Stopwatch clock)
    {
        long now = clock.ElapsedMilliseconds;
        if (now - lastHeartbeatMs >= 250)
        {
            lastHeartbeatMs = now;
            Send(FRAME_UNCHANGED, null);
        }
    }

    static void DrawCursor(Bitmap bmp) { DrawCursorOffset(bmp, 0, 0); }
    static void DrawCursorOffset(Bitmap bmp, int offX, int offY)
    {
        CURSORINFO ci; ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO)); ci.flags = 0; ci.hCursor = IntPtr.Zero; ci.ptScreenPos = new Point();
        if (!GetCursorInfo(ref ci) || ci.flags == 0 || ci.hCursor == IntPtr.Zero) return;
        float scale = (float)targetW / screenW;
        int cx = (int)(ci.ptScreenPos.X * scale) - offX;
        int cy = (int)(ci.ptScreenPos.Y * scale) - offY;
        int w = Math.Max(8, (int)Math.Round(GetSystemMetrics(SM_CXCURSOR) * scale));
        int h = Math.Max(8, (int)Math.Round(GetSystemMetrics(SM_CYCURSOR) * scale));
        using (Graphics g = Graphics.FromImage(bmp))
        {
            IntPtr hdc = g.GetHdc();
            DrawIconEx(hdc, cx, cy, ci.hCursor, w, h, 0, IntPtr.Zero, DI_NORMAL);
            g.ReleaseHdc(hdc);
        }
    }

    static ImageCodecInfo JpegCodec()
    {
        ImageCodecInfo[] codecs = ImageCodecInfo.GetImageEncoders();
        foreach (ImageCodecInfo c in codecs) if (c.MimeType == "image/jpeg") return c;
        return codecs[0];
    }
}
