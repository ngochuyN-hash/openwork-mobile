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
import { useEffect, useRef, useState, useCallback } from "preact/hooks";
import { createPortal } from "preact/compat";
import { apiScreenInfo, owScreenInput, owScreenStream } from "../api.js";
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

// Thông số stream duy nhất: 880px vừa nét trên màn phone, JPEG 55 đủ đọc chữ —
// từng có 3 preset chọn tay nhưng không ai đổi (phản hồi user 13/09/2026).
const STREAM_PARAMS = { w: 880, q: 55 };
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
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [full, setFull] = useState(false); // toàn màn hình kiểu faux (áp dụng mọi trình duyệt)

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
  useEffect(() => {
    const w = info?.screen?.width, h = info?.screen?.height;
    if (w && h) ratioRef.current = w / h;
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
  // Gesture trên hình, kiểu màn cảm ứng: chạm = click · giữ lâu = Right-click ·
  // chạm đôi = Double-click · kéo = di chuyển · hai ngón vuốt = cuộn.
  const pointers = useRef(new Map()); // pointerId -> {x, y} (client px)
  const g = useRef({
    mode: "idle", // idle | press (đã gửi down, đang kéo) | scroll (hai ngón)
    scx: 0, scy: 0, startT: 0, sentDown: false, longFired: false,
    lpTimer: null, lastSendT: 0, accY: 0, lastMidY: 0,
  });
  const urlRef = useRef("");
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

  // ---- vòng stream: nối lại khi đứt, dừng khi app ẩn/unmount
  useEffect(() => {
    if (!info?.available || paused) return;
    const myRun = ++runIdRef.current;
    const { w, q } = STREAM_PARAMS;
    const abort = new AbortController();
    setStatus("connecting");
    let frameCount = 0;
    const fpsTimer = setInterval(() => {
      setFps(frameCount);
      frameCount = 0;
    }, 1000);

    (async () => {
      // Vòng nối lại có backoff — mất mạng/tunnel đổi thì tự chờ rồi thử.
      for (let attempt = 0; ; attempt++) {
        if (runIdRef.current !== myRun) return;
        try {
          setStatus((s) => (s === "live" ? s : "connecting"));
          await owScreenStream({
            w,
            q,
            signal: abort.signal,
            onFrame: (blob) => {
              frameCount += 1;
              setStatus("live");
              const next = URL.createObjectURL(blob);
              if (urlRef.current) URL.revokeObjectURL(urlRef.current);
              urlRef.current = next;
              setUrl(next);
            },
            onUnchanged: () => setStatus((s) => (s === "live" ? "live" : s)),
            onMeta: (meta) => setInfo((i) => (i ? { ...i, screen: { width: meta.screenW, height: meta.screenH } } : i)),
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
        await new Promise((r) => setTimeout(r, Math.min(6000, 1000 + attempt * 500)));
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
  }, [info?.available, paused]);

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

  useEffect(() => () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);

  // ---- gửi lệnh điều khiển
  const sendInput = useCallback(async (payload) => {
    setSending(true);
    try {
      await owScreenInput(payload);
    } catch (e) {
      setErrorMsg(String(e.message || e));
    } finally {
      setSending(false);
    }
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

  const SLOP = 10; // px: quá ngưỡng mới tính là kéo (không thì là chạm/giữ)
  const TAP_MS = 260;
  const LP_MS = 550; // giữ lâu -> Right-click
  const WHEEL_STEP = 24; // hai ngón đi được từng này px thì cuộn một nấc

  const onPointerDown = (e) => {
    const n = normXY(e.clientX, e.clientY);
    if (!n) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const st = g.current;
    if (pointers.current.size === 1) {
      st.mode = "idle";
      st.scx = e.clientX; st.scy = e.clientY;
      st.startT = Date.now(); st.sentDown = false; st.longFired = false; st.accY = 0;
      clearTimeout(st.lpTimer);
      posEcho(e.clientX, e.clientY);
      st.lpTimer = setTimeout(() => {
        // Giữ lâu không rời -> Right-click tại điểm chạm
        if (st.mode === "idle" && !st.sentDown) {
          st.longFired = true;
          buzz(40); // rung ngay: chắc chắn đây là Right-click, không đoán
          posEcho(st.scx, st.scy, "rc");
          const n2 = normXY(st.scx, st.scy);
          if (n2) sendInput({ type: "rclick", ...n2 });
        }
      }, LP_MS);
    } else {
      // Ngón thứ hai đặt xuống: huỷ long-press, nhả nút nếu đang kéo, vào cuộn
      clearTimeout(st.lpTimer);
      if (st.mode === "press") {
        const n2 = normXY(e.clientX, e.clientY);
        if (n2) sendInput({ type: "up", ...n2 });
      }
      st.mode = "scroll";
      st.sentDown = false;
      const pts = [...pointers.current.values()];
      st.lastMidY = (pts[0].y + pts[1].y) / 2;
      st.accY = 0;
    }
  };

  const onPointerMove = (e) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const st = g.current;
    if (st.mode === "scroll") {
      if (pointers.current.size >= 2) {
        const pts = [...pointers.current.values()];
        const mid = (pts[0].y + pts[1].y) / 2;
        st.accY += mid - st.lastMidY;
        st.lastMidY = mid;
        while (Math.abs(st.accY) >= WHEEL_STEP) {
          // ngón vuốt lên (accY âm) = cuộn xem nội dung dưới = wheel âm
          sendInput({ type: "wheel", dy: st.accY > 0 ? 2 : -2 });
          st.accY -= st.accY > 0 ? WHEEL_STEP : -WHEEL_STEP;
        }
      }
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
    // idle: nếu đi quá ngưỡng -> bắt đầu kéo (gửi down tại điểm chạm ban đầu)
    const dist = Math.hypot(e.clientX - st.scx, e.clientY - st.scy);
    if (dist > SLOP) {
      clearTimeout(st.lpTimer);
      const n = normXY(st.scx, st.scy);
      if (n) sendInput({ type: "down", ...n });
      st.sentDown = true;
      st.mode = "press";
      st.lastSendT = Date.now();
    }
  };

  const finishPointer = (e) => {
    pointers.current.delete(e.pointerId);
    const st = g.current;
    if (st.mode === "scroll") {
      if (pointers.current.size === 0) st.mode = "idle";
      return; // ngón còn lại sau cuộn: bỏ qua tới khi nhấc hết
    }
    if (st.longFired) { st.mode = "idle"; return; } // Right-click đã xử lý
    clearTimeout(st.lpTimer);
    const n = normXY(e.clientX, e.clientY);
    if (st.sentDown) {
      if (n) sendInput({ type: "up", ...n });
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
    if (g.current.mode !== "scroll") g.current.mode = "idle";
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

  // Ép nối lại stream ngay: tắt pause 1 nhịp để effect stream chạy vòng mới.
  const reconnect = useCallback(() => {
    setPaused(true);
    setTimeout(() => setPaused(false), 50);
  }, []);

  // Layer toàn màn hình render qua PORTAL ra document.body: vài trình duyệt
  // (iOS Safari…) biến position:fixed thành "absolute" khi tổ tiên có
  // filter/backdrop-filter — portal thì layer luôn bám viewport, phủ kín máy nào
  // cũng đúng. Mode thường viewNode nằm nguyên trong trang như cũ.
  const viewNode = (
    <div ref={viewRef} class={`screen-view ${full ? "view-full " : ""}${vland ? "vland" : ""}`}>
        {/* stage tự ôm cao đúng ảnh (hết band đen); placeholder tự giữ tỉ lệ */}
        <div ref={stageRef} class="screen-stage">
          {url ? (
            <img
              ref={imgRef}
              class="screen-img control"
              src={url}
              alt="Màn hình máy tính"
              draggable={false}
              style={vland && vbox ? {
                // khung ảnh TRƯỚC xoay: ngang pw'×ph' (sw/sh) — xoay 90° xong
                // thành cột đứng rộng sh, cao sw, tâm neo tại (sh/2+m, giữa)
                width: `${vbox.sw}px`,
                height: `${vbox.sh}px`,
                left: `${Math.round(vbox.sh / 2) + 4}px`,
                top: "50%",
                transform: "translate(-50%, -50%) rotate(90deg)",
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
        </div>

        {/* Gõ chữ + bàn phím GỘP MỘT KHUNG luôn hiển thị: mode thường nằm dưới
            ảnh, toàn màn hình thì CSS dựng thành cột phải xoay 90°. */}
        <div class="screen-panel screen-panel-main">
          <form
            class="screen-textrow"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!text.trim()) return;
              await sendInput({ type: "text", text });
              setText("");
            }}
          >
            <input
              ref={textInputRef}
              type="text"
              value={text}
              onInput={(e) => setText(e.currentTarget.value)}
            />
            <button class="btn small" type="submit" disabled={sending || !text.trim()}>
              <SendIcon size={16} /> Send
            </button>
          </form>
            <div class="screen-row">
              {COMBOS.map((c) => (
                <button key={c.label} class="screen-key combo" disabled={sending} onClick={() => tapCombo(c)}>
                  {c.label}
                </button>
              ))}
            </div>
            <div class="screen-row">
              <button class="screen-key wide" disabled={sending} onClick={() => tapKey("enter")}>Enter</button>
              <button class="screen-key wide" disabled={sending} onClick={() => tapKey("esc")}>Esc</button>
              <button class="screen-key wide" disabled={sending} onClick={() => tapKey("backspace")}>Bksp</button>
              <button class="screen-key wide" disabled={sending} onClick={() => tapKey("tab")}>Tab</button>
            </div>
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
            ? `Đang xem${fps ? ` · ${fps} hình/s` : ""}`
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
