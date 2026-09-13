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
// v2.3: bridge đẩy khung nhanh hơn (trần 4→12 hình/s, màn đứng yên bỏ encode) +
// toàn màn hình ăn theo xoay NGANG — hình dồn sát trái, thanh phím đứng dọc
// bên phải; thanh nút nằm trong lớp toàn màn hình nên không còn bị đè mất.
import { useEffect, useRef, useState, useCallback } from "preact/hooks";
import { apiScreenInfo, owScreenInput, owScreenStream } from "../api.js";
import { Banner } from "../components/ui.jsx";
import {
  ClipboardIcon,
  ExpandIcon,
  KeyboardIcon,
  SendIcon,
} from "../components/icons.jsx";

// Thông số stream duy nhất: 880px vừa nét trên màn phone, JPEG 55 đủ đọc chữ —
// từng có 3 preset chọn tay nhưng không ai đổi (phản hồi user 13/09/2026).
const STREAM_PARAMS = { w: 880, q: 55 };
// Sticky modifiers — bật sáng rồi bấm phím = tổ hợp, xong tự nhả (như 9remote).
const MODS = [
  { id: "ctrl", label: "Ctrl" },
  { id: "alt", label: "Alt" },
  { id: "shift", label: "Shift" },
  { id: "win", label: "Win" },
];
// Combo hay dùng bấm 1 phát — nhãn theo đúng keycap tiếng Anh.
const COMBOS = [
  { label: "Ctrl+C", mods: ["ctrl"], key: "c", hint: "Copy" },
  { label: "Ctrl+V", mods: ["ctrl"], key: "v", hint: "Paste" },
  { label: "Ctrl+Z", mods: ["ctrl"], key: "z", hint: "Undo" },
  { label: "Alt+Tab", mods: ["alt"], key: "tab", hint: "Switch window" },
  { label: "Win+D", mods: ["win"], key: "d", hint: "Show desktop" },
  { label: "Win+E", mods: ["win"], key: "e", hint: "File Explorer" },
  { label: "Ctrl+Shift+Esc", mods: ["ctrl", "shift"], key: "esc", hint: "Task Manager" },
];
const NAV_KEYS = [
  { key: "up", label: "↑" },
  { key: "down", label: "↓" },
  { key: "left", label: "←" },
  { key: "right", label: "→" },
  { key: "delete", label: "Del" },
  { key: "space", label: "Space" },
  { key: "home", label: "Home" },
  { key: "end", label: "End" },
  { key: "pgup", label: "PgUp" },
  { key: "pgdn", label: "PgDn" },
];

export function ScreenPage() {
  const [info, setInfo] = useState(null); // {available, screen}
  const [paused, setPaused] = useState(false); // CHỈ nội bộ: ẩn app thì ngắt stream, đỡ pin/3G
  const [status, setStatus] = useState("connecting"); // connecting|live|paused|error|unavailable
  const [errorMsg, setErrorMsg] = useState("");
  const [fps, setFps] = useState(0);
  const [url, setUrl] = useState("");
  const [mods, setMods] = useState([]); // sticky Ctrl/Alt/Shift/Win
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [full, setFull] = useState(false); // toàn màn hình kiểu faux (áp dụng mọi trình duyệt)
  const [panel, setPanel] = useState(null); // null | "keys" | "mouse" | "text" — kiểu 9remote

  const imgRef = useRef(null);
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

  // Ẩn app thì ngắt stream cho đỡ pin/3G, quay lại thì nối tiếp; thoát faux-full khi ẩn.
  useEffect(() => {
    const onVis = () => {
      setPaused(document.hidden);
      if (document.hidden) setFull(false);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

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
    return {
      x: Math.min(1, Math.max(0, (cx - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (cy - rect.top) / rect.height)),
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

  const tapKey = (key) => {
    // Có sticky mod -> gửi combo (Ctrl+C...), xong tự nhả mod như sticky keys
    if (mods.length) {
      sendInput({ type: "combo", mods, key });
      setMods([]);
    } else {
      sendInput({ type: "key", key });
    }
  };
  const toggleMod = (id) =>
    setMods((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));
  // Combo nút bấm có mods riêng: trừ phần trùng sticky (kẻo Ctrl,Ctrl double).
  const tapCombo = (combo) => {
    const rest = mods.filter((m) => !combo.mods.includes(m));
    sendInput({ type: "combo", mods: [...combo.mods, ...rest], key: combo.key });
    if (rest.length) setMods([]);
  };

  // Toàn màn hình kiểu faux: cố định khung hình đè lên mọi thứ (Fullscreen API
  // trên iOS Safari chỉ dành cho <video>, nên dùng CSS cho đồng bộ mọi máy).
  const toggleFull = () => setFull((f) => !f);

  // Nút Clipboard kiểu 9remote: mở panel gõ chữ + nạp clipboard điện thoại vào ô.
  const openClipboard = async () => {
    setPanel("text");
    try {
      const clip = await navigator.clipboard.readText();
      if (clip) setText(clip.slice(0, 500));
    } catch {
      // Không đọc được (chưa cấp quyền/clipboard trống) — người dùng tự gõ vẫn chạy.
    }
    setTimeout(() => textInputRef.current?.focus(), 50);
  };

  // Bật panel điều khiển nào đó = ý định điều khiển → tự mở khoá.
  const togglePanel = (name) => {
    setPanel((p) => (p === name ? null : name));
  };

  const unavailable = info && info.available === false;
  const screenRatio = info?.screen?.width && info?.screen?.height
    ? `${info.screen.width} / ${info.screen.height}`
    : "16 / 9";

  // Ép nối lại stream ngay: tắt pause 1 nhịp để effect stream chạy vòng mới.
  const reconnect = useCallback(() => {
    setPaused(true);
    setTimeout(() => setPaused(false), 50);
  }, []);

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

      {/* .screen-view gói cả hình + thanh nút + panel: khi toàn màn hình thì cả
          cụm vào một lớp cố định — xoay ngang thì hình sát trái, phím đứng phải. */}
      <div class={`screen-view ${full ? "view-full" : ""}`}>
        <div class="screen-stage">
          {url ? (
            <img
              ref={imgRef}
              class="screen-img control"
              src={url}
              alt="Màn hình máy tính"
              draggable={false}
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
        </div>
        {/* Thanh nút nằm DƯỚI khung hình (không đè lên màn hình PC) */}
        <div class="stage-toolbar">
          <button
            class={`stage-btn ${panel === "keys" ? "on" : ""}`}
            disabled={unavailable}
            aria-label="Bàn phím"
            aria-pressed={panel === "keys"}
            onClick={() => togglePanel("keys")}
          >
            <KeyboardIcon size={20} />
          </button>
          <button
            class={`stage-btn ${panel === "text" ? "on" : ""}`}
            disabled={unavailable}
            aria-label="Gõ hoặc dán chữ"
            aria-pressed={panel === "text"}
            onClick={openClipboard}
          >
            <ClipboardIcon size={20} />
          </button>
          <button
            class={`stage-btn ${full ? "on" : ""}`}
            onClick={toggleFull}
            aria-label={full ? "Thoát toàn màn hình" : "Toàn màn hình"}
            aria-pressed={full}
          >
            <ExpandIcon size={20} />
          </button>
        </div>

        {/* Panel trượt ra dưới khung hình — mỗi lần 1 panel, kiểu tab Input 9remote */}
        {panel === "keys" && (
          <div class="screen-panel">
            <div class="screen-row">
              {MODS.map((m) => (
                <button
                  key={m.id}
                  class={`screen-key ${mods.includes(m.id) ? "on" : ""}`}
                  onClick={() => toggleMod(m.id)}
                  aria-pressed={mods.includes(m.id)}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <div class="screen-row">
              {COMBOS.map((c) => (
                <button key={c.label} class="screen-key combo" disabled={sending} title={c.hint} onClick={() => tapCombo(c)}>
                  {c.label}
                </button>
              ))}
            </div>
            <div class="screen-row">
              {NAV_KEYS.map((k) => (
                <button key={k.key} class={`screen-key ${k.label.length === 1 ? "sym" : ""}`} disabled={sending} onClick={() => tapKey(k.key)}>
                  {k.label}
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
        )}

        {panel === "text" && (
          <div class="screen-panel">
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
          </div>
        )}
      </div>
      {full && (
        <button class="btn danger small stage-exit" onClick={toggleFull}>Thoát toàn màn hình</button>
      )}

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
