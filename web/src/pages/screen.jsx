// Trang "Màn hình": xem + điều khiển máy tính từ điện thoại (v1.7, học cơ chế
// 9remote — chụp liên tục đẩy frame, điều khiển bằng tap/kéo). Frame JPEG chảy
// qua stream binary của bridge; lệnh điều khiển là POST riêng, tọa độ 0..1.
// v1.9: bố cục nút học Y CHANG 9remote — 1 thanh icon nổi trên khung hình, bật
// từng panel Bàn phím / Chuột / Clipboard, keycap tiếng Anh.
// v2.0: cắt 3 nút vô nghĩa theo phản hồi user — Tạm dừng (rời app đã tự ngắt
// stream), chọn chất lượng (chốt cứng 1 thông số tốt cho màn phone), nút
// "Chỉ xem".
// v2.1: bỏ luôn nút khoá (hình luôn nhận điều khiển như 9remote) và nút chụp
// ảnh; toolbar chỉ còn Bàn phím · Gõ chữ · Toàn màn hình.
// v2.8: dọn phím theo user — bỏ hàng Ctrl/Alt/Shift/Win, Win+D/E,
// Ctrl+Shift+Esc và hàng mũi tên/điều hướng; combo đổi nhãn thành
// Copy · Paste · Undo · Redo (thêm Redo = Ctrl+Y).
// v2.3: bridge đẩy khung nhanh hơn (trần 4→12 hình/s, màn đứng yên bỏ encode) +
// toàn màn hình ăn theo xoay NGANG — hình dồn sát trái, thanh phím đứng dọc
// bên phải; thanh nút nằm trong lớp toàn màn hình nên không còn bị đè mất.
// v2.9: zoom xem cục bộ kiểu app remote desktop — véo 2 ngón phóng/thu
// (1x..3x, điểm giữa 2 ngón là tâm, nội dung bám theo ngón), đang zoom thì
// kéo 1 ngón = dời khung nhìn; vuốt 2 ngón vẫn cuộn máy PC. Zoom CHỈ phóng
// ảnh trên điện thoại (CSS transform): tọa độ bấm tính qua rect ảnh đã phóng
// nên vẫn trúng đích, stream không tốn thêm băng thông. Chip "1.5×" góc
// dưới-trái chỉ hiện khi đang phóng, bấm là về vừa khung.
// v2.9.1: vuốt 1 NGÓN cũng cuộn máy PC (hai ngón giữ nguyên) — kéo chuột
// (drag) dời thành GIỮ ~nửa giây rồi kéo, giữ rồi nhả không di = Right-click
// (rung + vành đỏ báo lúc giữ, lệnh gửi lúc nhả để còn dành ngón cho drag).
// v3.0: ảnh stream NET THEO ZOOM — tay buông khỏi cú véo là tính needed px
// (880×zoom, trần min(native màn PC, 1600)) rồi nối lại stream với w lớn hơn,
// về 1x trả lại 880 rẻ cũ (9remote làm 4 bậc cứng, mình tính đúng từng mức).
// v3.1: WebRTC P2P — frame + lệnh điều khiển đi datachannel NỐI THẲNG
// phone<->PC (bridge chỉ làm mối 1 lượt qua /api/webrtc/signal), không còn qua
// tunnel/worker nên latency bằng mạng thật giữa hai máy (cùng WiFi ~2-10ms).
// STUN công khai giúp xuyên NAT; thất bại thì tự lùi về stream HTTP như cũ.
// Lệnh gõ phím không còn chờ hồi âm (fire-and-forget) — gõ liền tay không
// khóa nút; badge hiện ping thật đo trên datachannel.
import { useEffect, useRef, useState, useCallback } from "preact/hooks";
import { createPortal } from "preact/compat";
import { apiScreenInfo, owScreenInput, owScreenStream, owWebrtcIce, owWebrtcSignal } from "../api.js";
import { Banner } from "../components/ui.jsx";
import {
  ExpandIcon,
  Icon,
  SendIcon,
} from "../components/icons.jsx";

// Icon "thu nhỏ" cho nút góc khi đang toàn màn hình (mũi tên gập vào trong)
function CollapseIcon({ size }) {
  return (
    <Icon size={size ?? 20}>
      <path d="M4 14h6v6" />
      <path d="M20 10h-6V4" />
      <path d="M14 10l7-7" />
      <path d="M3 21l7-7" />
    </Icon>
  );
}

// Chất lượng stream: JPEG 55 đủ đọc chữ, KHÔNG đổi tay (từng có 3 preset chọn
// nhưng không ai đổi — phản hồi user 13/09/2026). Bề rộng 880px là MỐC ĐỘNG:
// zoom sâu thì phone tự nối lại stream với ảnh lớn hơn (capW state) để giữ nét.
const STREAM_PARAMS = { q: 55 };
// Tổ hợp hay dùng bấm 1 phát — nhãn tiếng Anh dễ hiểu, không ra phím tắt thô.
const COMBOS = [
  { label: "Copy", mods: ["ctrl"], key: "c" },
  { label: "Paste", mods: ["ctrl"], key: "v" },
  { label: "Undo", mods: ["ctrl"], key: "z" },
  { label: "Redo", mods: ["ctrl"], key: "y" },
];

export function ScreenPage() {
  const [info, setInfo] = useState(null); // {available, screen}
  const [paused, setPaused] = useState(false); // CHỈ nội bộ: ẩn app thì ngắt stream, đỡ pin/3G
  const [status, setStatus] = useState("connecting"); // connecting|live|paused|error|unavailable
  const [errorMsg, setErrorMsg] = useState("");
  const [fps, setFps] = useState(0);
  const [hasFrame, setHasFrame] = useState(false); // canvas đã có khung đầu
  const [text, setText] = useState("");
  const [full, setFull] = useState(false); // toàn màn hình kiểu faux (áp dụng mọi trình duyệt)
  const [capW, setCapW] = useState(880); // bề rộng ảnh stream — tăng theo zoom để giữ nét
  const [wrtc, setWrtc] = useState(null); // null | trying | active | failed — đường truyền hình
  const [ping, setPing] = useState(0); // RTT đo trên datachannel (chỉ khi WebRTC active)
  const [attempt, setAttempt] = useState(0); // tăng = thử lại cả hai đường kết nối

  const imgRef = useRef(null);
  const viewRef = useRef(null); // .screen-view — đối tượng Fullscreen API thật
  const stageRef = useRef(null); // .screen-stage — đo kích thước cho ảnh xoay

  // ---- VIRTUAL LANDSCAPE: CHỈ trong TOÀN MÀN HÌNH trên máy DỌNG — ảnh PC xoay
  // sẵn 90°, user lật máy tay là đọc được, không đợi OS xoay viewport. Ngoài
  // fullscreen vẫn xem dọc như thường (PC vốn không xoay). Máy cảm ứng (coarse)
  // hoặc màn hẹp (<=520px) = "phiên bản web mobile". Khi máy xoay thật sang
  // ngang (Android lock được hướng) thì media query landscape thắng, ảnh thẳng.
  const [portraitMobile, setPortraitMobile] = useState(false);
  const [vbox, setVbox] = useState(null); // {sw, sh} — kích thước ảnh TRƯỚC khi xoay
  const ratioRef = useRef(16 / 9); // pw/ph màn PC — cập nhật theo meta stream
  const nativeWRef = useRef(1920); // bề rộng thật màn PC — trần nét cho ảnh zoom sâu
  useEffect(() => {
    const w = info?.screen?.width, h = info?.screen?.height;
    if (w && h) { ratioRef.current = w / h; nativeWRef.current = w; }
  }, [info?.screen?.width, info?.screen?.height]);
  useEffect(() => {
    const mq = window.matchMedia("(orientation: portrait) and ((pointer: coarse) or (max-width: 520px))");
    // Đừng chỉ trông mq "change" (vài môi trường bắn thiếu) — dò lại cả khi
    // resize và khi bật/tắt fullscreen.
    const sync = () => setPortraitMobile(mq.matches);
    sync();
    if (mq.addEventListener) mq.addEventListener("change", sync);
    else mq.addListener(sync);
    window.addEventListener("resize", sync);
    document.addEventListener("fullscreenchange", sync);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", sync);
      else mq.removeListener(sync);
      window.removeEventListener("resize", sync);
      document.removeEventListener("fullscreenchange", sync);
    };
  }, []);
  const vland = full && portraitMobile; // chỉ fullscreen mới xoay ảnh
  const vlandRef = useRef(false); // mirror cho pointer handler (không stale)
  vlandRef.current = vland;
  useEffect(() => {
    if (!vland) { setVbox(null); return; }
    // rAF bị throttle trên vài môi trường (PWA nền/IAB) — đo bằng ResizeObserver
    // + cụm timer bù lúc chuyển trạng thái cho chắc ăn dù layout đổi trễ.
    let last = "";
    const timers = [];
    const measure = () => {
      const stage = stageRef.current;
      if (!stage) return;
      const R = ratioRef.current || 16 / 9;
      // sw = chiều DÀI ảnh (PC width) chạy dọc trục cao stage; chỉ chừa 8px
      // margin cho khỏi đè mép — ảnh ôm TRÁI hết cỡ trong khung đen toàn màn.
      const sw = Math.min(stage.clientHeight, (stage.clientWidth - 8) * R);
      const sh = sw / R;
      const sig = Math.round(sw) + "x" + Math.round(sh);
      if (sig !== last) {
        last = sig;
        setVbox({ sw: Math.round(sw), sh: Math.round(sh) });
      }
    };
    measure();
    for (const ms of [50, 150, 350, 700]) timers.push(setTimeout(measure, ms));
    let ro;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(measure);
      ro.observe(stageRef.current);
    } else {
      window.addEventListener("resize", measure);
    }
    return () => {
      for (const t of timers) clearTimeout(t);
      if (ro) ro.disconnect();
      else window.removeEventListener("resize", measure);
    };
  }, [vland]);
  // ---- ZOOM XEM CỤC BỘ: s = độ phóng (1..3), x/y = pan px theo khung xem.
  // Biến đổi nằm NGAY TRÊN ảnh: véo/vuốt ghi thẳng style (mượt, không chờ
  // render), còn render do stream cũng tự viết đúng chuỗi này vì đọc cùng
  // zoomRef — hai đường không giẫm chân nhau.
  const zoomRef = useRef({ s: 1, x: 0, y: 0 });
  const chipRef = useRef(null); // chip "1.5×" — cập nhật bằng tay, khỏi re-render
  const zoomStr = () => {
    const z = zoomRef.current;
    const parts = [];
    if (z.x || z.y) parts.push(`translate(${Math.round(z.x)}px, ${Math.round(z.y)}px)`);
    if (vlandRef.current) parts.push("translate(-50%, -50%) rotate(90deg)");
    if (z.s !== 1) parts.push(`scale(${z.s.toFixed(4)})`);
    return parts.join(" ");
  };
  const applyZoom = () => {
    const z = zoomRef.current;
    if (imgRef.current) imgRef.current.style.transform = zoomStr();
    if (chipRef.current) {
      const on = z.s > 1.02;
      chipRef.current.classList.toggle("show", on);
      if (on) chipRef.current.textContent = z.s.toFixed(1) + "×";
    }
  };
  // ---- ẢNH STREAM NET THEO ZOOM (học 9remote nhưng tính mịn hơn): tay vừa buông
  // khỏi cú véo là tính "cần bao nhiêu px để nét ở mức zoom này" (880 × zoom,
  // trần là bề rộng thật màn PC và 1600 cho đỡ tốn đường) rồi nối lại stream với
  // ảnh to hơn; về 1x là trả lại 880 rẻ cũ. Chỉ đổi khi lệch >15% + làm tròn
  // 80px + chờ 350ms sau tay buông — chống nhảy cấp liên tục (9remote dùng 4 bậc
  // cứng + van 5%, mình tính đúng theo zoom từng phút).
  const capTimer = useRef(0);
  const syncCapture = useCallback(() => {
    clearTimeout(capTimer.current);
    capTimer.current = setTimeout(() => {
      const s = zoomRef.current.s;
      if (s <= 1.02) { setCapW((w) => (w === 880 ? w : 880)); return; }
      const need = Math.min(1600, nativeWRef.current, Math.round((880 * s) / 80) * 80);
      setCapW((w) => (need > w * 1.15 || need < w * 0.8 ? Math.max(880, need) : w));
    }, 350);
  }, []);
  const resetZoom = useCallback(() => {
    zoomRef.current = { s: 1, x: 0, y: 0 };
    applyZoom();
    syncCapture();
  }, [syncCapture]);
  // Biên dời pan theo 1 trục: ảnh DÀI hơn khung thì được trượt tới khi mép ảnh
  // chạm mép khung (không lộ nền), ảnh NGẮN hơn thì kẹp giữa không cho trôi.
  const panBounds = (sz, st, bc) =>
    sz >= st ? [st - sz / 2 - bc, sz / 2 - bc] : [sz / 2 - bc, st - sz / 2 - bc];
  // Đổi bố cục (bật/tắt toàn màn hình, xoay ảo, đo lại khung) là pan/zoom tính
  // theo bố cục cũ — trả về vừa khung cho khỏi lệch chết chỗ lạ.
  useEffect(() => { resetZoom(); }, [full, portraitMobile, vbox, resetZoom]);

  // Gesture trên hình, kiểu màn cảm ứng: chạm = click · giữ lâu rồi nhả =
  // Right-click · GIỮ RỒI KÉO = kéo chuột (drag) · vuốt 1 ngón = cuộn PC ·
  // hai ngón vuốt = cuộn · véo 2 ngón = zoom (đang zoom thì vuốt = dời khung).
  const pointers = useRef(new Map()); // pointerId -> {x, y} (client px)
  const g = useRef({
    // idle | press (đang kéo chuột PC) | scroll (vuốt cuộn, 1 hay 2 ngón đều được)
    // | wait2 (2 ngón, chờ phân loại véo/cuộn) | pinch (đang véo)
    // | pinch-end (ngón còn lại sau véo, bỏ qua) | pan (1 ngón dời khung nhìn)
    mode: "idle",
    scx: 0, scy: 0, startT: 0, sentDown: false, held: false,
    lpTimer: null, lastSendT: 0, accY: 0, lastMidY: 0,
    // véo: khoảng cách/điểm giữa 2 ngón lúc đặt xuống, độ phóng lúc đầu (s0),
    // tâm neo nội dung (fa* — tỉ lệ chỗ ngón kẹp trên khung ảnh), khung ảnh
    // gốc s=1 (b* — kích thước + tâm theo khung xem) và khung xem (st*/sl*)
    d0: 1, mx0: 0, my0: 0, s0: 1, fax: 0.5, fay: 0.5,
    bcx: 0, bcy: 0, bw: 1, bh: 1, stw: 1, sth: 1, slx: 0, sly: 0,
    // pan 1 ngón khi đã zoom: điểm bắt đầu, pan lúc đầu, biên dời từng trục
    panSX: 0, panSY: 0, plx0: 0, ply0: 0,
    plminX: 0, plmaxX: 0, plminY: 0, plmaxY: 0,
  });
  const drawChain = useRef(Promise.resolve()); // vẽ tuần tự — crop về sau không nhảy hàng trước crop trước nó
  const gotFullRef = useRef(false); // đã có khung FULL cho kết nối hiện tại? crop lẻ không đủ làm nền
  // Ghép khung lên canvas — dùng CHUNG cho cả hai đường truyền. Payload từ v4.1:
  // [2B x][2B y][2B w][2B h] LE + JPEG — vùng đổi vẽ ĐÈ đúng chỗ, vùng đứng yên
  // giữ nguyên trên canvas (không phải truyền lại như <img> src nguyên khung).
  // JPEG trần 0xFF 0xD8 (bridge cũ, GDI chưa đóng header) vẫn ăn: full-frame.
  const pushFrame = useCallback((data) => {
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    // JPEG trần (mở đầu 0xFF 0xD8) = khung full KHÔNG header từ bridge cũ (trước
    // khi GDI fallback đóng header như DXGI). Frame có header không bao giờ khởi
    // đầu bằng cặp byte này (byte cao của x ≤ 0x06 vì width chặn 1600) nên nhận
    // diện không bao giờ nhầm.
    const raw = u8.length >= 4 && u8[0] === 0xff && u8[1] === 0xd8;
    let x = 0, y = 0, w = 0, h = 0;
    if (!raw) {
      if (u8.length < 9) return;
      x = u8[0] | (u8[1] << 8); y = u8[2] | (u8[3] << 8);
      w = u8[4] | (u8[5] << 8); h = u8[6] | (u8[7] << 8);
      if (!w || !h) return;
    }
    // Chưa có khung full: crop mảnh (replay stale / vùng đổi nhỏ) BỎ QUA hẳn —
    // vẽ mảnh rời lên canvas trống từng biến thành "màn hình đen" (mảnh ở 0,0
    // còn bị tưởng là full nên canvas bị resize theo cỡ mảnh rồi CSS phóng to).
    if (!gotFullRef.current) {
      const c = imgRef.current;
      const cw = c && c.width > 2 ? c.width : 300, ch = c && c.height > 2 ? c.height : 150;
      const isFull = raw || (x === 0 && y === 0 && w * h >= 0.9 * cw * ch);
      if (!isFull) return;
      gotFullRef.current = true;
    }
    drawChain.current = drawChain.current.then(async () => {
      try {
        const bmp = await createImageBitmap(new Blob([raw ? u8 : u8.subarray(8)], { type: "image/jpeg" }));
        const c = imgRef.current;
        if (c) {
          const fw = w || bmp.width, fh = h || bmp.height;
          if (x === 0 && y === 0 && (c.width !== fw || c.height !== fh)) {
            c.width = fw; // resize tự xóa canvas — chỉ khi đúng khung full từ gốc
            c.height = fh;
          }
          c.getContext("2d").drawImage(bmp, x, y, fw, fh);
        }
        bmp.close?.();
        setHasFrame(true);
      } catch {}
    });
  }, []);
  // Meta đổi cỡ ảnh (zoom sâu v3.0 / kết nối mới) — canvas theo cỡ mới.
  const fitCanvas = useCallback((w, h) => {
    const c = imgRef.current;
    if (c && w > 0 && h > 0 && (c.width !== w || c.height !== h)) { c.width = w; c.height = h; }
  }, []);
  const ctlRef = useRef(null); // datachannel "control" khi WebRTC active
  const wrtcRef = useRef(null); // mirror của wrtc cho effect (không stale)
  const runIdRef = useRef(0); // hủy vòng nối lại khi pause/unmount đổi
  const textInputRef = useRef(null);
  const echoRef = useRef(null); // chấm phản hồi cục bộ: cho biết cú chạm đã ăn, khỏi đoán qua mạng

  // ---- kiểm tra máy có hỗ trợ không
  useEffect(() => {
    let alive = true;
    apiScreenInfo()
      .then((i) => alive && setInfo(i))
      .catch((e) => alive && setInfo({ available: false, message: String(e.message || e) }));
    return () => {
      alive = false;
    };
  }, []);

  // ---- vòng stream HTTP (DỰ PHÒNG khi WebRTC thất bại): nối lại khi đứt,
  // dừng khi app ẩn/unmount, đổi độ nét khi zoom sâu (capW đổi là nối vòng mới)
  useEffect(() => {
    if (!info?.available || paused) return;
    if (wrtcRef.current !== "failed") return; // WebRTC đang thử/đã chạy — HTTP chờ
    const myRun = ++runIdRef.current;
    const { q } = STREAM_PARAMS;
    const abort = new AbortController();
    setStatus("connecting");
    let frameCount = 0;
    const fpsTimer = setInterval(() => {
      setFps(frameCount);
      frameCount = 0;
    }, 1000);

    (async () => {
      // Vòng nối lại có backoff — mất mạng/tunnel đổi thì tự chờ rồi thử.
      for (let retry = 0; ; retry++) {
        if (runIdRef.current !== myRun) return;
        try {
          setStatus((s) => (s === "live" ? s : "connecting"));
          gotFullRef.current = false; // kết nối (lại) — chờ khung full đầu tiên
          await owScreenStream({
            w: capW,
            q,
            signal: abort.signal,
            onFrame: (payload) => {
              frameCount += 1;
              setStatus("live");
              pushFrame(payload);
            },
            onUnchanged: () => setStatus((s) => (s === "live" ? "live" : s)),
            onMeta: (meta) => {
              if (meta.shotW > 0 && meta.shotH > 0) fitCanvas(meta.shotW, meta.shotH);
              setInfo((i) => (i ? { ...i, screen: { width: meta.screenW, height: meta.screenH } } : i));
            },
            onError: (m) => setErrorMsg(m),
          });
          if (runIdRef.current !== myRun) return;
          setStatus("error");
          setErrorMsg("Mất kết nối stream");
        } catch (error) {
          if (error.name === "AbortError" || runIdRef.current !== myRun) return;
          if (error.message === "UNPAIRED") {
            setStatus("error");
            setErrorMsg("Thiết bị chưa ghép/mất ghép — mở lại app để pair.");
            return;
          }
          setStatus("error");
          setErrorMsg(String(error.message || error));
        }
        // backoff: 1s, 2s, 3.5s... tối đa 6s
        await new Promise((r) => setTimeout(r, Math.min(6000, 1000 + retry * 500)));
        if (runIdRef.current !== myRun) return;
        setErrorMsg("");
      }
    })();

    return () => {
      runIdRef.current++; // vô hiệu hóa vòng này
      abort.abort();
      clearInterval(fpsTimer);
      setStatus("paused");
    };
  }, [info?.available, paused, capW, wrtc, pushFrame]);

  // ---- WebRTC P2P: frame + lệnh đi datachannel NỐI THẲNG phone<->PC — bridge
  // chỉ làm mối SDP/ICE đúng một lượt, sau đó đường hình không qua tunnel/worker
  // nữa nên latency bằng mạng thật giữa hai máy (cùng WiFi ~2-10ms). STUN công
  // khai để phone tìm thấy PC sau NAT; NAT gắt/chặn UDP → lùi về stream HTTP.
  useEffect(() => {
    if (!info?.available || paused) return;
    if (wrtcRef.current === "active" || wrtcRef.current === "failed") return;
    wrtcRef.current = "trying";
    gotFullRef.current = false; // kết nối mới — chờ khung full đầu tiên
    setWrtc("trying");
    setStatus("connecting");
    let dead = false;
    let pc = null;
    let pingTimer = null;
    let fpsTimer = null;
    let frameTimer = null;
    let frameCount = 0;
    const fail = () => {
      if (dead) return;
      dead = true;
      clearInterval(pingTimer); clearInterval(fpsTimer);
      if (frameTimer) { clearTimeout(frameTimer); frameTimer = null; }
      try { pc?.close(); } catch {}
      ctlRef.current = null;
      wrtcRef.current = "failed";
      setWrtc("failed");
      setPing(0);
    };
    (async () => {
      try {
        // ICE server (kể cả TURN CF khi chủ máy đã gắn key) lấy từ bridge
        // TRƯỚC khi dựng offer — cần ngay lúc gom candidate. Bridge không
        // cấu hình thì STUN công khai như cũ.
        const ice = (await owWebrtcIce()) ?? [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
        pc = new RTCPeerConnection({ iceServers: ice });
        const ctl = pc.createDataChannel("control");
        const scr = pc.createDataChannel("screen");
        const candidates = [];
        pc.onicecandidate = (e) => {
          if (e.candidate) candidates.push({ candidate: e.candidate.candidate, mid: String(e.candidate.sdpMid ?? "0") });
        };
        pc.onconnectionstatechange = () => {
          if (["failed", "closed", "disconnected"].includes(pc.connectionState)) fail();
        };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        // Gom candidate ~2.5s — non-trickle: offer lẫn candidate gửi đúng 1 lượt.
        await new Promise((res) => {
          if (pc.iceGatheringState === "complete") return res();
          const t = setTimeout(res, 2500);
          pc.addEventListener("icegatheringstatechange", () => {
            if (pc.iceGatheringState === "complete") { clearTimeout(t); res(); }
          });
        });
        const ans = await owWebrtcSignal({ sdp: pc.localDescription.sdp, type: "offer", candidates });
        if (dead) return;
        await pc.setRemoteDescription({ type: ans.type, sdp: ans.sdp });
        for (const c of ans.candidates ?? []) {
          try { await pc.addIceCandidate({ candidate: c.candidate, sdpMid: c.mid }); } catch {}
        }
        await Promise.race([
          Promise.all([new Promise((r) => { scr.onopen = r; }), new Promise((r) => { ctl.onopen = r; })]),
          new Promise((_, rej) => setTimeout(() => rej(new Error("datachannel không mở")), 6000)),
        ]);
        if (dead) return;
        ctlRef.current = ctl;
        ctl.onmessage = (e) => {
          let m = null;
          try { m = JSON.parse(e.data); } catch { return; }
          if (m.t === "meta") {
            if (m.shotW > 0 && m.shotH > 0) fitCanvas(m.shotW, m.shotH);
            setInfo((i) => (i ? { ...i, screen: { width: m.screenW, height: m.screenH } } : i));
          }
          else if (m.t === "pong") setPing(Math.max(0, Math.round(performance.now() - m.ts)));
          else if (m.t === "ierr") setErrorMsg(m.m);
        };
        scr.onmessage = (e) => {
          frameCount += 1;
          setStatus("live");
          setErrorMsg("");
          pushFrame(e.data);
        };
        pingTimer = setInterval(() => {
          try { ctl.send(JSON.stringify({ t: "ping", ts: performance.now() })); } catch {}
        }, 2000);
        fpsTimer = setInterval(() => { setFps(frameCount); frameCount = 0; }, 1000);
        wrtcRef.current = "active";
        setWrtc("active");
        // Datachannel mở mà không có khung FULL nào (bridge đang lạnh: daemon
        // chụp phải compile/spawn lại sau idle-stop, hoặc màn im không sinh frame)
        // thì KHÔNG được đứng im — coi như thất bại để tự lùi về stream HTTP.
        // Crop stale/replay không tính là sống (pushFrame chỉ bật gotFull khi full).
        frameTimer = setTimeout(() => {
          if (!gotFullRef.current) fail();
        }, 8000);
      } catch {
        fail();
      }
    })();
    return () => {
      dead = true;
      clearInterval(pingTimer); clearInterval(fpsTimer);
      if (frameTimer) { clearTimeout(frameTimer); frameTimer = null; }
      try { pc?.close(); } catch {}
      ctlRef.current = null;
      if (wrtcRef.current !== "failed") {
        wrtcRef.current = null;
        setWrtc(null);
        setStatus("paused");
      }
    };
  }, [info?.available, paused, attempt, pushFrame]);

  // Zoom sâu đổi độ nét (capW) → báo bridge đổi cỡ ảnh trên datachannel luôn,
  // không phải dựng lại kết nối như đường HTTP.
  useEffect(() => {
    const ctl = ctlRef.current;
    if (wrtc === "active" && ctl?.readyState === "open") {
      try { ctl.send(JSON.stringify({ t: "hello", w: capW, q: STREAM_PARAMS.q })); } catch {}
    }
  }, [wrtc, capW]);

  // Thoát toàn màn hình: nhả khoá xoay + thoát fullscreen gốc + tắt lớp CSS.
  // (Khai báo TRƯỚC effect bên dưới — deps [exitFull] không được chạm TDZ.)
  const exitFull = useCallback(() => {
    try { screen.orientation?.unlock?.(); } catch {}
    try { if (document.fullscreenElement) void document.exitFullscreen(); } catch {}
    setFull(false);
  }, []);

  // Ẩn app thì ngắt stream cho đỡ pin/3G, quay lại thì nối tiếp; thoát faux-full khi ẩn.
  useEffect(() => {
    const onVis = () => {
      setPaused(document.hidden);
      if (document.hidden) exitFull();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [exitFull]);

  // Dọn lúc rời trang. Cleanup unmount TUYỆT ĐỐI không được ném lỗi: Preact
  // chạy cleanup NGAY GIỮA đường tháo DOM, ném là cả nhánh render chết giữa
  // chừng — DOM trang cũ thành "ma" đè trang mới, bấm tab kế vẫn thấy trang cũ
  // (14/09: dòng urlRef — tàn tích đời <img> dùng objectURL, đời canvas đã bỏ —
  // ném ReferenceError đúng chỗ đó mỗi lần rời tab Screen). Nhân thể: nếu user
  // lỡ routes đi khi còn toàn màn hình thì nhả khoá xoay + thoát fullscreen.
  useEffect(() => () => {
    clearTimeout(capTimer.current);
    try { screen.orientation?.unlock?.(); } catch {}
    try { if (document.fullscreenElement) void document.exitFullscreen(); } catch {}
  }, []);

  // Gửi lệnh điều khiển: WebRTC còn sống thì đi datachannel (một chiều, tức
  // thì); chưa có/thất bại thì POST qua worker như cũ. Fire-and-forget — gõ
  // phím không còn bị chờ giữa hai lần gửi, lỗi chỉ hiện banner.
  const sendInput = useCallback((payload) => {
    const ctl = ctlRef.current;
    if (ctl && ctl.readyState === "open") {
      try { ctl.send(JSON.stringify(payload)); } catch {}
      return;
    }
    owScreenInput(payload).catch((e) => {
      if (e.message !== "UNPAIRED") setErrorMsg(String(e.message || e));
    });
  }, []);

  // Local echo: phản hồi tức thời tại ngón tay (không chờ mạng) — chấm trắng
  // theo ngón khi kéo, biến đỏ + rung máy khi Right-click kịch phát.
  const posEcho = (cx, cy, cls) => {
    const stage = imgRef.current?.parentElement;
    const dot = echoRef.current;
    if (!stage || !dot) return;
    const r = stage.getBoundingClientRect();
    dot.style.left = (cx - r.left) + "px";
    dot.style.top = (cy - r.top) + "px";
    dot.className = "touch-echo show " + (cls ?? "");
  };
  const hideEcho = () => { if (echoRef.current) echoRef.current.className = "touch-echo"; };
  const buzz = (ms) => { try { navigator.vibrate?.(ms); } catch {} };

  const normXY = (cx, cy) => {
    const rect = imgRef.current?.getBoundingClientRect();
    if (!rect || !rect.width) return null;
    const clamp01 = (v) => Math.min(1, Math.max(0, v));
    if (vlandRef.current) {
      // Ảnh xoay sẵn 90° CW: đỉnh PC chỉ về PHẢI máy — lật máy ngược kim đồng
      // hồ là thẳng. PC-x chạy từ trên xuống, PC-y chạy từ phải sang trái.
      return {
        x: clamp01((cy - rect.top) / rect.height),
        y: clamp01((rect.right - cx) / rect.width),
      };
    }
    return {
      x: clamp01((cx - rect.left) / rect.width),
      y: clamp01((cy - rect.top) / rect.height),
    };
  };

  const SLOP = 10; // px: quá ngưỡng mới tính là vuốt (không thì là chạm/giữ)
  const TAP_MS = 260;
  const LP_MS = 550; // giữ lâu -> "đã giữ": nhả = Right-click, kéo = drag
  const WHEEL_STEP = 24; // ngón đi được từng này px thì cuộn một nấc
  const PINCH_PX = 12; // hai ngón nở/thu được từng này px thì tính là véo (zoom)
  const SCROLL_GATE = 14; // hai ngón trượt được từng này px thì tính là cuộn
  const ZOOM_MAX = 3; // trần zoom — ảnh gốc 880px, phóng quá là vỡ nét

  const onPointerDown = (e) => {
    const n = normXY(e.clientX, e.clientY);
    if (!n) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const st = g.current;
    if (pointers.current.size === 1) {
      st.mode = "idle";
      st.scx = e.clientX; st.scy = e.clientY;
      st.startT = Date.now(); st.sentDown = false; st.held = false; st.accY = 0;
      clearTimeout(st.lpTimer);
      posEcho(e.clientX, e.clientY);
      st.lpTimer = setTimeout(() => {
        // Giữ đứng yên đúng hạn: rung + vành đỏ báo "đã giữ" — nhả tay không di
        // là Right-click, kéo tiếp là kéo chuột. Gửi Right-click NGAY LÚC NÀY thì
        // không còn đường nào cho drag, nên dời sang lúc nhả tay (finishPointer).
        if (st.mode === "idle" && !st.sentDown) {
          st.held = true;
          buzz(40);
          posEcho(st.scx, st.scy, "rc");
        }
      }, LP_MS);
    } else if (pointers.current.size === 2) {
      // Ngón thứ hai đặt xuống: huỷ "đã giữ", nhả nút nếu đang kéo, rồi CHỜ
      // PHÂN LOẠI — véo (khoảng cách 2 ngón nở/thu) hay cuộn (2 ngón trượt).
      clearTimeout(st.lpTimer);
      if (st.mode === "press") {
        const n2 = normXY(e.clientX, e.clientY);
        if (n2) sendInput({ type: "up", ...n2 });
      }
      st.sentDown = false; st.held = false;
      st.mode = "wait2";
      const pts = [...pointers.current.values()];
      st.d0 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      st.mx0 = (pts[0].x + pts[1].x) / 2;
      st.my0 = (pts[0].y + pts[1].y) / 2;
      st.lastMidY = st.my0;
      st.accY = 0;
      st.s0 = zoomRef.current.s;
    }
    // ngón thứ 3 trở lên: bỏ qua — gesture 2 ngón đang chạy giữ nguyên
  };

  const onPointerMove = (e) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const st = g.current;
    if (st.mode === "wait2") {
      if (pointers.current.size < 2) return;
      const pts = [...pointers.current.values()];
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const mx = (pts[0].x + pts[1].x) / 2, my = (pts[0].y + pts[1].y) / 2;
      if (Math.abs(d - st.d0) >= PINCH_PX) {
        // Véo thắng cuộc: neo đúng nội dung đang nằm dưới điểm giữa 2 ngón —
        // phóng to/thu nhỏ xong nội dung đó vẫn bám theo ngón, không trôi.
        const img = imgRef.current, stage = stageRef.current;
        if (!img || !stage) return;
        const R = img.getBoundingClientRect(), S = stage.getBoundingClientRect();
        const z = zoomRef.current;
        st.bw = R.width / z.s; st.bh = R.height / z.s;
        st.bcx = R.left + R.width / 2 - S.left - z.x;
        st.bcy = R.top + R.height / 2 - S.top - z.y;
        st.fax = (st.mx0 - R.left) / R.width;
        st.fay = (st.my0 - R.top) / R.height;
        st.stw = S.width; st.sth = S.height;
        st.slx = S.left; st.sly = S.top;
        st.mode = "pinch";
        // không return — xử luôn cú move này như một bước véo
      } else {
        st.accY += my - st.lastMidY;
        st.lastMidY = my;
        if (Math.abs(st.accY) >= SCROLL_GATE) st.mode = "scroll";
        return;
      }
    }
    if (st.mode === "pinch") {
      if (pointers.current.size < 2) { st.mode = "pinch-end"; return; }
      const pts = [...pointers.current.values()];
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const mx = (pts[0].x + pts[1].x) / 2, my = (pts[0].y + pts[1].y) / 2;
      const s = Math.min(ZOOM_MAX, Math.max(1, (st.s0 * d) / st.d0));
      const w = st.bw * s, h = st.bh * s;
      // đặt nội dung điểm neo dưới điểm giữa ngón, rồi chặn pan cho khung ảnh
      // không tuột khỏi cửa sổ xem (trục nào chưa đủ rộng thì kẹp giữa)
      let px = (mx - st.slx) - st.bcx - (st.fax - 0.5) * w;
      let py = (my - st.sly) - st.bcy - (st.fay - 0.5) * h;
      const [x0, x1] = panBounds(w, st.stw, st.bcx);
      const [y0, y1] = panBounds(h, st.sth, st.bcy);
      px = Math.min(Math.max(px, x0), x1);
      py = Math.min(Math.max(py, y0), y1);
      zoomRef.current = { s, x: px, y: py };
      applyZoom();
      return;
    }
    if (st.mode === "pinch-end") return; // ngón còn lại sau véo: bỏ tới khi nhấc hết
    if (st.mode === "scroll") {
      // 1 hay 2 ngón đều cuộn cùng nhịp: điểm dò = ngón một (1 ngón) / điểm
      // giữa hai ngón (2 ngón)
      const pts = [...pointers.current.values()];
      const refY = pts.length >= 2 ? (pts[0].y + pts[1].y) / 2 : pts[0]?.y;
      if (refY != null) {
        st.accY += refY - st.lastMidY;
        st.lastMidY = refY;
        while (Math.abs(st.accY) >= WHEEL_STEP) {
          // ngón vuốt lên (accY âm) = cuộn xem nội dung dưới = wheel âm
          sendInput({ type: "wheel", dy: st.accY > 0 ? 2 : -2 });
          st.accY -= st.accY > 0 ? WHEEL_STEP : -WHEEL_STEP;
        }
      }
      return;
    }
    if (st.mode === "pan") {
      const z = zoomRef.current;
      const px = Math.min(Math.max(st.plx0 + (e.clientX - st.panSX), st.plminX), st.plmaxX);
      const py = Math.min(Math.max(st.ply0 + (e.clientY - st.panSY), st.plminY), st.plmaxY);
      zoomRef.current = { s: z.s, x: px, y: py };
      applyZoom();
      return;
    }
    if (st.mode === "press") {
      posEcho(e.clientX, e.clientY); // chấm chạy theo ngón tức thời
      const now = Date.now();
      if (now - st.lastSendT < 60) return; // throttle ~16 lần/giây
      st.lastSendT = now;
      const n = normXY(e.clientX, e.clientY);
      if (n) sendInput({ type: "move", ...n });
      return;
    }
    // idle: đi quá ngưỡng — đang zoom thì vuốt = dời khung nhìn; đã "giữ" thì
    // kéo tiếp = kéo chuột PC (down tại điểm giữ); thường thì vuốt = cuộn PC.
    const dist = Math.hypot(e.clientX - st.scx, e.clientY - st.scy);
    if (dist > SLOP) {
      clearTimeout(st.lpTimer);
      if (zoomRef.current.s > 1.02) {
        st.mode = "pan";
        st.panSX = e.clientX; st.panSY = e.clientY;
        st.plx0 = zoomRef.current.x; st.ply0 = zoomRef.current.y;
        const img = imgRef.current, stage = stageRef.current;
        if (img && stage) {
          const R = img.getBoundingClientRect(), S = stage.getBoundingClientRect();
          const z = zoomRef.current;
          const bcx = R.left + R.width / 2 - S.left - z.x;
          const bcy = R.top + R.height / 2 - S.top - z.y;
          const [x0, x1] = panBounds(R.width, S.width, bcx);
          const [y0, y1] = panBounds(R.height, S.height, bcy);
          st.plminX = x0; st.plmaxX = x1;
          st.plminY = y0; st.plmaxY = y1;
        } else { st.plminX = 0; st.plmaxX = 0; st.plminY = 0; st.plmaxY = 0; }
        return;
      }
      if (st.held) {
        const n = normXY(st.scx, st.scy);
        if (n) sendInput({ type: "down", ...n });
        st.sentDown = true;
        st.mode = "press";
        st.lastSendT = Date.now();
        posEcho(e.clientX, e.clientY);
        return;
      }
      st.mode = "scroll";
      st.lastMidY = e.clientY;
      st.accY = e.clientY - st.scy; // tính cả đoạn vừa vuốt, khỏi bỏ sót nấc đầu
    }
  };

  const finishPointer = (e) => {
    pointers.current.delete(e.pointerId);
    const st = g.current;
    if (st.mode === "wait2" || st.mode === "pinch" || st.mode === "pinch-end") {
      if (pointers.current.size === 0) {
        // véo về ~1x là về nguyên vị trí giữa, khỏi lệch nửa chừng
        if (zoomRef.current.s <= 1.02) { zoomRef.current = { s: 1, x: 0, y: 0 }; applyZoom(); }
        syncCapture(); // tay vừa buông: cân lại độ nét ảnh stream theo zoom
        st.mode = "idle";
      } else st.mode = "pinch-end"; // ngón còn lại: bỏ qua tới khi nhấc hết
      return;
    }
    if (st.mode === "pan") {
      if (pointers.current.size === 0) st.mode = "idle";
      return; // dời khung nhìn không đụng tới máy PC
    }
    if (st.mode === "scroll") {
      if (pointers.current.size === 0) st.mode = "idle";
      return; // ngón còn lại sau cuộn: bỏ qua tới khi nhấc hết
    }
    clearTimeout(st.lpTimer);
    const n = normXY(e.clientX, e.clientY);
    if (st.sentDown) {
      if (n) sendInput({ type: "up", ...n });
      st.mode = "idle";
      return;
    }
    if (st.held) {
      // giữ rồi nhả, chưa kéo = Right-click tại điểm giữ (báo rung từ lúc giữ)
      if (n) sendInput({ type: "rclick", ...n });
      st.mode = "idle";
      return;
    }
    // chạm nhanh nhấc tay ngay = click (chạm 2 lần liên tiếp OS tự hiểu là double)
    if (n && Date.now() - st.startT < TAP_MS + 200) { buzz(12); sendInput({ type: "click", ...n }); }
    st.mode = "idle";
  };

  const onPointerUp = finishPointer;
  const onPointerCancel = (e) => {
    pointers.current.delete(e.pointerId);
    clearTimeout(g.current.lpTimer);
    const st = g.current;
    const multi = st.mode === "wait2" || st.mode === "pinch" || st.mode === "pinch-end";
    if ((multi || st.mode === "scroll") && pointers.current.size) {
      st.mode = multi ? "pinch-end" : "scroll"; // còn ngón: khoá tới khi nhấc hết
    } else st.mode = "idle";
  };

  const tapKey = (key) => sendInput({ type: "key", key });
  const tapCombo = (combo) => sendInput({ type: "combo", mods: combo.mods, key: combo.key });

  // Toàn màn hình: ưu tiên API GỐC + KHOÁ XOAY NGANG — bấm phóng to là màn xoay
  // ngang luôn như YouTube (Android Chrome); iOS Safari không cho fullscreen
  // phần tử thường (chỉ <video>) và không cho lock hướng, nên lùi về faux CSS —
  // người dùng tự xoay máy, bố cục player vẫn ăn theo media query landscape.
  // Gọi trong effect SAU khi portal mount xong (bấm xong element được dời sang
  // body — fullscreen phần tử cũ rồi tháo ra là tự thoát ngay).
  const toggleFull = () => {
    if (full) { exitFull(); return; }
    setFull(true);
  };
  useEffect(() => {
    if (!full) return;
    let alive = true;
    (async () => {
      try { await viewRef.current?.requestFullscreen?.(); } catch {}
      if (!alive) return;
      try { await screen.orientation?.lock?.("landscape"); } catch {}
    })();
    return () => { alive = false; };
  }, [full]);

  // Thoát fullscreen bằng nút hệ thống (nút back Android/swipe) → đồng bộ state.
  useEffect(() => {
    const onFs = () => { if (!document.fullscreenElement) exitFull(); };
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, [exitFull]);

  const unavailable = info && info.available === false;
  const screenRatio = info?.screen?.width && info?.screen?.height
    ? `${info.screen.width} / ${info.screen.height}`
    : "16 / 9";

  // Ép nối lại cả hai đường: tăng attempt là WebRTC thử lại từ đầu; WebRTC
  // thất bại hẳn thì vòng HTTP dự phòng tự chạy.
  const reconnect = useCallback(() => {
    setErrorMsg("");
    setStatus("connecting");
    setWrtc(null);
    wrtcRef.current = null;
    setPing(0);
    setAttempt((a) => a + 1);
  }, []);

  // Layer toàn màn hình render qua PORTAL ra document.body: vài trình duyệt
  // (iOS Safari…) biến position:fixed thành "absolute" khi tổ tiên có
  // filter/backdrop-filter — portal thì layer luôn bám viewport, phủ kín máy nào
  // cũng đúng. Mode thường viewNode nằm nguyên trong trang như cũ.
  const viewNode = (
    <div ref={viewRef} class={`screen-view ${full ? "view-full " : ""}${vland ? "vland" : ""}`}>
        {/* stage tự ôm cao đúng ảnh (hết band đen); placeholder tự giữ tỉ lệ */}
        <div ref={stageRef} class="screen-stage">
          {hasFrame ? (
            <canvas
              ref={imgRef}
              class="screen-img control"
              draggable={false}
              style={vland && vbox ? {
                // khung ảnh TRƯỚC xoay: ngang pw'×ph' (sw/sh) — xoay 90° xong
                // thành cột đứng rộng sh, cao sw, tâm neo tại (sh/2+m, giữa).
                // transform đọc zoomStr() để zoom/pan không bị render đè mất.
                width: `${vbox.sw}px`,
                height: `${vbox.sh}px`,
                left: `${Math.round(vbox.sh / 2) + 4}px`,
                top: "50%",
                transform: zoomStr(),
              } : undefined}
              onContextMenu={(e) => e.preventDefault()}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
          ) : (
            <div class="screen-placeholder" style={`aspect-ratio:${screenRatio}`}>
              {status === "connecting" && !unavailable ? <span class="spinner" /> : null}
              <p>{unavailable ? "Không khả dụng" : "Đang nối stream màn hình…"}</p>
            </div>
          )}
          <span ref={echoRef} class="touch-echo" aria-hidden="true" />
          {/* Nút MỜ góc trên-phải: toàn màn hình ↔ thu nhỏ. Bàn phím + gõ chữ
              KHÔNG cần nút — toàn màn hình thì 2 panel luôn hiển thị ở cột phải. */}
          <div class="stage-corner">
            <button
              class="corner-btn"
              onClick={toggleFull}
              aria-label={full ? "Thu nhỏ" : "Toàn màn hình"}
              aria-pressed={full}
            >
              {full ? <CollapseIcon size={17} /> : <ExpandIcon size={17} />}
            </button>
          </div>
          {/* Chip zoom góc dưới-trái: chỉ hiện khi đang phóng (véo 2 ngón) —
              bấm là về vừa khung, khỏi phải véo nhỏ lại từng chút một. */}
          <button
            ref={chipRef}
            type="button"
            class="zoom-chip"
            onClick={resetZoom}
            aria-label="Về vừa khung"
          >1×</button>
        </div>

        {/* Gõ chữ + bàn phím GỘP MỘT KHUNG luôn hiển thị: mode thường nằm dưới
            ảnh, toàn màn hình thì CSS dựng thành cột phải xoay 90°. */}
        <div class="screen-panel screen-panel-main">
            <div class="screen-row">
              {COMBOS.map((c) => (
                <button key={c.label} class="screen-key combo" onClick={() => tapCombo(c)}>
                  {c.label}
                </button>
              ))}
            </div>
            <div class="screen-row">
              <button class="screen-key wide" onClick={() => tapKey("enter")}>Enter</button>
              <button class="screen-key wide" onClick={() => tapKey("esc")}>Esc</button>
              <button class="screen-key wide" onClick={() => tapKey("backspace")}>Bksp</button>
              <button class="screen-key wide" onClick={() => tapKey("tab")}>Tab</button>
            </div>
          {/* Ô nhập ở ĐÁY khung — sát ngay trên thanh trạng thái/nav */}
          <form
            class="screen-textrow"
            onSubmit={(e) => {
              e.preventDefault();
              if (!text.trim()) return;
              sendInput({ type: "text", text }); // fire-and-forget — xoá ô ngay
              setText("");
            }}
          >
            <input
              ref={textInputRef}
              type="text"
              value={text}
              onInput={(e) => setText(e.currentTarget.value)}
            />
            <button class="btn small" type="submit" disabled={!text.trim()}>
              <SendIcon size={16} /> Send
            </button>
          </form>
        </div>
      </div>
  );

  return (
    <div class="screen-page">
      {unavailable && (
        <Banner kind="warn">
          Máy tính không xem/điều khiển màn hình được: {info.message || "chỉ hỗ trợ Windows"}.
        </Banner>
      )}
      {errorMsg && status === "error" && (
        <Banner kind="err" actionLabel="Thử lại" onAction={reconnect}>
          {errorMsg}
        </Banner>
      )}
      {full ? createPortal(viewNode, document.body) : viewNode}

      <div class="screen-bar">
        <span class={`badge ${status === "live" ? "ok" : status === "error" ? "err" : "busy"}`}>
          {status === "live"
            ? `Đang xem${fps ? ` · ${fps} hình/s` : ""}${wrtc === "active" && ping ? ` · ${ping}ms` : ""}`
            : status === "connecting"
              ? "Đang nối…"
              : status === "paused"
                ? "Tạm nghỉ — đang chờ bạn mở lại"
                : "Mất nối"}
        </span>
      </div>
    </div>
  );
}
