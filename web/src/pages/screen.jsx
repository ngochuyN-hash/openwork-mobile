// Trang "Màn hình": xem + điều khiển máy tính từ điện thoại (v1.7, học cơ chế
// 9remote — chụp liên tục đẩy frame, điều khiển bằng tap/kéo). Frame JPEG chảy
// qua stream binary của bridge; lệnh điều khiển là POST riêng, tọa độ 0..1.
// v1.8: nút toàn màn hình + chụp ảnh lưu điện thoại + dán clipboard điện thoại.
// v1.9: bố cục nút học Y CHANG 9remote — 1 thanh icon nổi trên khung hình, bật
// từng panel Bàn phím / Chuột / Clipboard (key label tiếng Anh chuẩn keycap),
// phông OpenWork (tokens v4, không glassmorphism).
import { useEffect, useRef, useState, useCallback } from "preact/hooks";
import { apiScreenInfo, owScreenInput, owScreenStream } from "../api.js";
import { Banner } from "../components/ui.jsx";
import {
  CameraIcon,
  ClipboardIcon,
  ExpandIcon,
  KeyboardIcon,
  MouseIcon,
  MousePointerIcon,
} from "../components/icons.jsx";

const QUALITY_PRESETS = {
  fast: { label: "Nhanh", w: 720, q: 45 },
  balanced: { label: "Cân bằng", w: 880, q: 55 },
  sharp: { label: "Nét", w: 1100, q: 68 },
};
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
  const [preset, setPreset] = useState("balanced");
  const [paused, setPaused] = useState(false);
  const [control, setControl] = useState(false); // mặc định CHỈ XEM — khỏi bấm nhầm
  const [status, setStatus] = useState("connecting"); // connecting|live|idle|paused|error|unavailable
  const [errorMsg, setErrorMsg] = useState("");
  const [fps, setFps] = useState(0);
  const [url, setUrl] = useState("");
  const [mods, setMods] = useState([]); // sticky Ctrl/Alt/Shift/Win
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [full, setFull] = useState(false); // toàn màn hình kiểu faux (áp dụng mọi trình duyệt)
  const [panel, setPanel] = useState(null); // null | "keys" | "mouse" | "text" — kiểu 9remote

  const imgRef = useRef(null);
  const lastPoint = useRef({ x: 0.5, y: 0.5 }); // điểm chạm cuối cho chuột phải/double
  const urlRef = useRef("");
  const frameBlobRef = useRef(null); // frame JPEG gần nhất — cho nút Chụp ảnh
  const dragRef = useRef(null); // {lastSent: ms} khi đang kéo
  const runIdRef = useRef(0); // hủy vòng nối lại khi preset/pause/unmount đổi
  const textInputRef = useRef(null);

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

  // ---- vòng stream: nối lại khi đứt, dừng khi pause/unmount/đổi chất lượng
  useEffect(() => {
    if (!info?.available || paused) return;
    const myRun = ++runIdRef.current;
    const { w, q } = QUALITY_PRESETS[preset];
    const abort = new AbortController();
    setStatus("connecting");
    let frameCount = 0;
    const fpsTimer = setInterval(() => {
      setFps(frameCount);
      frameCount = 0;
    }, 2000);

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
              frameBlobRef.current = blob;
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
  }, [info?.available, preset, paused]);

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

  const normFromEvent = (e) => {
    const rect = imgRef.current?.getBoundingClientRect();
    if (!rect || !rect.width) return null;
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  };

  const onPointerDown = (e) => {
    if (!control) return;
    const p = normFromEvent(e);
    if (!p) return;
    lastPoint.current = p;
    dragRef.current = { lastSent: 0 };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    sendInput({ type: "down", ...p });
  };
  const onPointerMove = (e) => {
    if (!control || !dragRef.current) return;
    const p = normFromEvent(e);
    if (!p) return;
    lastPoint.current = p;
    const now = Date.now();
    if (now - dragRef.current.lastSent < 60) return; // throttle ~16 lần/giây là đủ
    dragRef.current.lastSent = now;
    sendInput({ type: "move", ...p });
  };
  const onPointerUp = (e) => {
    if (!control || !dragRef.current) return;
    const p = normFromEvent(e) ?? lastPoint.current;
    dragRef.current = null;
    sendInput({ type: "up", ...p });
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

  // Lưu frame hiện tại về điện thoại — frame vốn là JPEG nên tải thẳng, khỏi vẽ canvas.
  const saveSnapshot = () => {
    const blob = frameBlobRef.current;
    if (!blob) return;
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const name = `man-hinh-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.jpg`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };

  // Nút Clipboard kiểu 9remote: mở panel gõ chữ + nạp clipboard điện thoại vào ô.
  const openClipboard = async () => {
    setControl(true); // ý định gõ chữ = muốn điều khiển
    setPanel("text");
    try {
      const clip = await navigator.clipboard.readText();
      if (clip) setText(clip.slice(0, 500));
    } catch {
      // Không đọc được (chưa cấp quyền/clipboard trống) — người dùng tự gõ vẫn chạy.
    }
    setTimeout(() => textInputRef.current?.focus(), 50);
  };

  // Bật panel điều khiển nào đó = ý định điều khiển luôn (như vào tab Input của 9remote).
  const togglePanel = (name) => {
    setControl(true);
    setPanel((p) => (p === name ? null : name));
  };

  const at = lastPoint.current;
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

      <div class={`screen-stage ${full ? "stage-full" : ""}`}>
        {url ? (
          <img
            ref={imgRef}
            class={`screen-img ${control ? "control" : ""}`}
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
            <p>{unavailable ? "Không khả dụng" : paused ? "Đã tạm dừng" : "Đang nối stream màn hình…"}</p>
          </div>
        )}
        {/* Thanh icon nổi phía dưới khung hình — bố cục học y chang 9remote */}
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
            class={`stage-btn ${panel === "mouse" ? "on" : ""}`}
            disabled={unavailable}
            aria-label="Chuột"
            aria-pressed={panel === "mouse"}
            onClick={() => togglePanel("mouse")}
          >
            <MousePointerIcon size={20} />
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
          <span class="stage-sep" aria-hidden="true" />
          <button class="stage-btn" onClick={saveSnapshot} disabled={!url} aria-label="Lưu ảnh màn hình về điện thoại">
            <CameraIcon size={20} />
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
        {paused && url && (
          <button class="screen-paused" onClick={() => setPaused(false)}>Tạm dừng — bấm để xem tiếp</button>
        )}
      </div>
      {full && (
        <button class="btn danger small stage-exit" onClick={toggleFull}>Thoát toàn màn hình</button>
      )}

      {/* Panel trượt ra dưới khung hình — mỗi lần 1 panel, kiểu tab Input 9remote */}
      {panel === "keys" && control && (
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
            <span class="screen-row-hint">bật sáng rồi bấm phím = tổ hợp</span>
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

      {panel === "mouse" && control && (
        <div class="screen-panel">
          <div class="screen-row">
            <button class="screen-key" disabled={sending} onClick={() => sendInput({ type: "rclick", ...at })}>Right-click</button>
            <button class="screen-key" disabled={sending} onClick={() => sendInput({ type: "dbl", ...at })}>Double-click</button>
            <button class="screen-key" disabled={sending} onClick={() => sendInput({ type: "wheel", dy: 3 })}>Wheel ↑</button>
            <button class="screen-key" disabled={sending} onClick={() => sendInput({ type: "wheel", dy: -3 })}>Wheel ↓</button>
          </div>
          <p class="screen-note">Chạm vào hình = left-click · giữ rồi kéo = drag. Right-click/Double-click bấm tại điểm chạm cuối.</p>
        </div>
      )}

      {panel === "text" && control && (
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
              placeholder="Type text (Vietnamese works) then Send"
              onInput={(e) => setText(e.currentTarget.value)}
            />
            <button class="btn small" type="submit" disabled={sending || !text.trim()}>
              <MouseIcon size={16} /> Send
            </button>
          </form>
          <p class="screen-note">Chữ đi qua clipboard của máy (như 9remote) — dấu tiếng Việt nguyên vẹn, tối đa 500 ký tự.</p>
        </div>
      )}

      <div class="screen-bar">
        <span class={`badge ${status === "live" ? "ok" : status === "error" ? "err" : "busy"}`}>
          {status === "live" ? `Đang xem${fps ? ` · ${fps} hình/2s` : ""}` : status === "connecting" ? "Đang nối…" : status === "paused" ? "Tạm dừng" : "Mất nối"}
        </span>
        <button class="btn ghost small" onClick={() => setPaused((p) => !p)}>
          {paused ? "Xem tiếp" : "Tạm dừng"}
        </button>
        <button
          class={`btn small ${control ? "danger-solid" : "ghost"}`}
          disabled={unavailable}
          onClick={() => {
            setControl((c) => !c);
            setPanel(null);
          }}
          aria-pressed={control}
        >
          {control ? "Đang điều khiển" : "Chỉ xem"}
        </button>
      </div>

      <div class="screen-qual" role="radiogroup" aria-label="Chất lượng hình">
        <span class="screen-qual-label">Chất lượng</span>
        <div class="seg">
          {Object.entries(QUALITY_PRESETS).map(([id, p]) => (
            <button
              key={id}
              class={`seg-btn ${preset === id ? "on" : ""}`}
              onClick={() => setPreset(id)}
              aria-pressed={preset === id}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
