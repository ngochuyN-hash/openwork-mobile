// Trang "Màn hình": xem + điều khiển máy tính từ điện thoại (v1.7, học cơ chế
// 9remote — chụp liên tục đẩy frame, điều khiển bằng tap/kéo). Frame JPEG chảy
// qua stream binary của bridge; lệnh điều khiển là POST riêng, tọa độ 0..1.
import { useEffect, useRef, useState, useCallback } from "preact/hooks";
import { apiScreenInfo, owScreenInput, owScreenStream } from "../api.js";
import { Banner } from "../components/ui.jsx";
import { MouseIcon } from "../components/icons.jsx";

const QUALITY_PRESETS = {
  fast: { label: "Nhanh", w: 720, q: 45 },
  balanced: { label: "Cân bằng", w: 880, q: 55 },
  sharp: { label: "Nét", w: 1100, q: 68 },
};
const MODS = [
  { id: "ctrl", label: "Ctrl" },
  { id: "alt", label: "Alt" },
  { id: "shift", label: "Shift" },
  { id: "win", label: "Win" },
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

  const imgRef = useRef(null);
  const lastPoint = useRef({ x: 0.5, y: 0.5 }); // điểm chạm cuối cho chuột phải/double
  const urlRef = useRef("");
  const dragRef = useRef(null); // {lastSent: ms} khi đang kéo
  const runIdRef = useRef(0); // hủy vòng nối lại khi preset/pause/unmount đổi

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

  // Ẩn app thì ngắt stream cho đỡ pin/3G, quay lại thì nối tiếp
  useEffect(() => {
    const onVis = () => setPaused(document.hidden);
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

  const at = lastPoint.current;
  const unavailable = info && info.available === false;

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

      <div class="screen-stage">
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
          <div class="screen-placeholder">
            {status === "connecting" && !unavailable ? <span class="spinner" /> : null}
            <p>{unavailable ? "Không khả dụng" : paused ? "Đã tạm dừng" : "Đang nối stream màn hình…"}</p>
          </div>
        )}
        {paused && url && (
          <button class="screen-paused" onClick={() => setPaused(false)}>Tạm dừng — bấm để xem tiếp</button>
        )}
      </div>

      <div class="screen-bar">
        <span class={`badge ${status === "live" ? "ok" : status === "error" ? "err" : "busy"}`}>
          {status === "live" ? `Đang xem${fps ? ` · ${fps} hình/2s` : ""}` : status === "connecting" ? "Đang nối…" : status === "paused" ? "Tạm dừng" : "Mất nối"}
        </span>
        <select
          class="screen-quality"
          value={preset}
          onChange={(e) => setPreset(e.currentTarget.value)}
          aria-label="Chất lượng hình"
        >
          {Object.entries(QUALITY_PRESETS).map(([id, p]) => (
            <option key={id} value={id}>{p.label}</option>
          ))}
        </select>
        <button class="btn ghost small" onClick={() => setPaused((p) => !p)}>
          {paused ? "Xem tiếp" : "Tạm dừng"}
        </button>
        <button
          class={`btn small ${control ? "danger-solid" : "ghost"}`}
          disabled={unavailable}
          onClick={() => setControl((c) => !c)}
          aria-pressed={control}
        >
          {control ? "Đang điều khiển" : "Chỉ xem"}
        </button>
      </div>

      {control && (
        <div class="screen-tools">
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
            <button class="screen-key" disabled={sending} onClick={() => sendInput({ type: "rclick", ...at })}>Chuột phải</button>
            <button class="screen-key" disabled={sending} onClick={() => sendInput({ type: "dbl", ...at })}>2 nhát</button>
            <button class="screen-key" disabled={sending} onClick={() => sendInput({ type: "wheel", dy: 3 })}>Cuộn ↑</button>
            <button class="screen-key" disabled={sending} onClick={() => sendInput({ type: "wheel", dy: -3 })}>Cuộn ↓</button>
          </div>
          <div class="screen-row">
            <button class="screen-key wide" disabled={sending} onClick={() => tapKey("enter")}>Enter</button>
            <button class="screen-key wide" disabled={sending} onClick={() => tapKey("esc")}>Esc</button>
            <button class="screen-key wide" disabled={sending} onClick={() => tapKey("backspace")}>⌫</button>
            <button class="screen-key wide" disabled={sending} onClick={() => tapKey("tab")}>Tab</button>
          </div>
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
              type="text"
              value={text}
              placeholder="Gõ chữ (kể cả tiếng Việt) rồi Gửi — chữ dán vào máy"
              onInput={(e) => setText(e.currentTarget.value)}
            />
            <button class="btn small" type="submit" disabled={sending || !text.trim()}>
              <MouseIcon size={16} /> Gửi
            </button>
          </form>
          <p class="screen-note">Chạm vào hình = click · giữ rồi kéo = kéo thả. Nút Chuột phải/2 nhát bấm tại điểm chạm cuối.</p>
        </div>
      )}
    </div>
  );
}
