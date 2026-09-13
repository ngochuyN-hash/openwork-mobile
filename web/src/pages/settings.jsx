import { useEffect, useState } from "preact/hooks";
import {
  getTenant,
  getTenantName,
  getToken,
  setToken,
  addKey,
  removeKey,
  notifyKeysChanged,
  apiRecheck,
  apiDevices,
  apiRevokeDevice,
  apiWakeOpenWork,
  apiPair,
  apiState,
} from "../api.js";
import { Banner, useConfirm } from "../components/ui.jsx";
import { navigate } from "../app.jsx";
import { PcManager } from "./pcs.jsx";

export function SettingsPage({ state, onRecheck, onUnpaired }) {
  const [busy, setBusy] = useState(false);
  const [waking, setWaking] = useState(false);
  const [wakeMsg, setWakeMsg] = useState("");
  const [confirmDialog, askConfirm] = useConfirm();
  const [devices, setDevices] = useState(null);
  const [thisDeviceLabel, setThisDeviceLabel] = useState("");
  // Dòng "ghép máy / token" — nằm SAU tường đăng nhập (yêu cầu chủ máy),
  // thay kết nối của thiết bị này mà không phải gỡ pairing.
  const [pairCode, setPairCode] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkMsg, setLinkMsg] = useState("");
  const [linkErr, setLinkErr] = useState("");
  // Chùm chìa đổi (đổi tên/rời/ngắt máy) — vẽ lại ngay các hàng tĩnh bên dưới
  // ("Máy đang kết nối" đọc từ localStorage) thay vì đợi poll 15s.
  const [, setTick] = useState(0);

  useEffect(() => {
    const onKeys = () => setTick((t) => t + 1);
    window.addEventListener("owm:keys", onKeys);
    return () => window.removeEventListener("owm:keys", onKeys);
  }, []);

  useEffect(() => {
    apiDevices().then(setDevices).catch(() => setDevices([]));
    if (state?.thisDevice?.label) setThisDeviceLabel(state.thisDevice.label);
  }, [state?.thisDevice?.id]);

  async function revoke(device) {
    askConfirm({
      title: "Thu hồi thiết bị?",
      body: `"${device.label}" sẽ mất quyền truy cập vĩnh viễn (phải ghép lại bằng mã mới).`,
      confirmLabel: "Thu hồi",
      onConfirm: async () => {
        try {
          const { devices } = await apiRevokeDevice(device.id);
          setDevices(devices);
        } catch {
          /* bỏ qua - tải lại danh sách */
        }
      },
    });
  }

  async function recheck() {
    setBusy(true);
    try {
      await apiRecheck();
      onRecheck();
    } finally {
      setBusy(false);
    }
  }

  async function wake() {
    setWaking(true);
    setWakeMsg("");
    try {
      const result = await apiWakeOpenWork();
      if (result?.alreadyRunning) {
        await apiRecheck();
        onRecheck();
      } else {
        setWakeMsg("Đã gửi lệnh mở OpenWork — đợi ~20s rồi bấm Kiểm tra lại.");
      }
    } catch (e) {
      setWakeMsg(String(e.message || e));
    } finally {
      setWaking(false);
    }
  }

  // "Gỡ pairing" = RỜI máy đang kết nối: xóa chìa khỏi chùm (khóa vẫn nằm
  // trên máy, vào lại cần đăng nhập/link mời). Còn máy khác trong app thì tự
  // chuyển sang máy đó — muốn chết hẳn với máy, dùng "Ngắt hẳn" ở tab PCs.
  function unpair() {
    const tenant = getTenant();
    askConfirm({
      title: "Gỡ pairing?",
      body: "Điện thoại này sẽ quên máy đang kết nối (xóa chìa khỏi app). Nếu app còn máy khác sẽ tự chuyển sang máy đó, hết máy thì quay về màn đăng nhập.",
      confirmLabel: "Gỡ pairing",
      onConfirm: () => {
        removeKey(tenant); // tự thăng máy khác làm active nếu còn, hết thì dọn token
        notifyKeysChanged();
        if (getToken()) {
          onRecheck();
          navigate("#/");
        } else {
          onUnpaired();
        }
      },
    });
  }

  // Ghép thiết bị này với máy đang kết nối bằng mã 1 lần — khóa mới thay khóa
  // cũ, tên thiết bị giữ nguyên. Xong là về thẳng app.
  async function submitPairCode() {
    const value = pairCode.trim().toUpperCase().replace(/[\s-]/g, "");
    if (!value || linkBusy) return;
    setLinkBusy(true);
    setLinkMsg("Đang ghép…");
    setLinkErr("");
    try {
      const { token } = await apiPair(value, state?.thisDevice?.label || "");
      setToken(token);
      onRecheck();
      navigate("#/");
    } catch (e) {
      setLinkMsg("");
      setLinkErr(String(e.message || e));
    } finally {
      setLinkBusy(false);
    }
  }

  // Dán token owm_/owd_ — thử nối TRƯỚC khi thay: hỏng thì khôi phục token
  // cũ, không bao giờ tự bắn mình ra ngoài màn đăng nhập. Token của phòng
  // khác bị chặn luôn (tenant hiện tại không khớp → 401) — muốn sang máy
  // phòng khác thì Gỡ pairing rồi đăng nhập lại.
  async function submitToken() {
    const value = tokenInput.trim();
    if (!value || linkBusy) return;
    const previous = getToken();
    setLinkBusy(true);
    setLinkMsg("Đang kiểm tra token…");
    setLinkErr("");
    setToken(value);
    try {
      await apiState();
      // Token hợp lệ cho phòng hiện tại → chìa mới ghi vào chùm (tab PCs).
      addKey({ tenant: getTenant(), token: value, name: getTenantName() });
      notifyKeysChanged();
      setTokenInput("");
      setLinkMsg("");
      onRecheck();
      navigate("#/");
    } catch {
      if (previous) setToken(previous);
      else localStorage.removeItem("owm_token");
      setLinkMsg("");
      setLinkErr("Token không đúng hoặc bridge chưa chạy — giữ nguyên kết nối cũ.");
    } finally {
      setLinkBusy(false);
    }
  }

  const rows = [
    ["Máy đang kết nối", getTenantName() || "máy chính (không phòng)"],
    ["openwork-server", state?.server ? `${state.server.baseUrl} (v${state.server.version})` : "chưa tìm thấy"],
    ["opencode", state?.server?.opencodeVersion ?? "—"],
    ["Token", state?.tokenActive ? "đang hoạt động" : state?.restartRequired ? "chờ restart OpenWork" : "đang kiểm tra…"],
    ["Engine", state?.engine ? `pid ${state.engine.pid} (port ${state.engine.enginePort})` : "—"],
    ["URL từ xa", state?.publicUrl ?? "—"],
    ["OpenWork .exe", state?.openworkExeFound ? "tìm thấy trên máy" : state?.openworkExeFound === false ? "chưa tìm thấy (bật từ xa có thể lỗi)" : "—"],
    ["Tự mở OpenWork", state?.autoLaunchOpenWork ? "bật (bridge khởi động là mở)" : "tắt"],
    ["Bridge", `v${state?.bridgeVersion ?? "?"} · ${state?.dataDir ?? ""}`],
  ];

  return (
    <>
      {confirmDialog}
      <PcManager onChanged={() => setTick((t) => t + 1)} />
      <div class="card">
        <h3>Trạng thái bridge</h3>
        <table style="width:100%;font-size:13.5px;border-collapse:collapse">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td style="color:var(--text-dim);padding:6px 8px 6px 0;white-space:nowrap;vertical-align:top">{k}</td>
                <td style="padding:6px 0;min-width:0;word-break:break-word" class="mono">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div class="page-actions" style="margin-top:12px">
          <button class="btn small" disabled={busy} onClick={recheck}>
            {busy ? "Đang kiểm tra…" : "Kiểm tra lại"}
          </button>
          <button class="btn small" disabled={waking} onClick={wake}>
            {waking ? "Đang bật…" : "Bật OpenWork trên máy tính"}
          </button>
          <button class="btn small danger" onClick={unpair}>
            Gỡ pairing
          </button>
        </div>
        {wakeMsg && <p class="sheet-body" style="margin:8px 0 0">{wakeMsg}</p>}
      </div>

      <div class="card">
        <h3>Thiết bị đã ghép</h3>
        <p class="sheet-body">Thiết bị này: <b>{thisDeviceLabel || "—"}</b></p>
        {devices === null ? (
          <p class="sheet-body">Đang tải…</p>
        ) : devices.length === 0 ? (
          <p class="sheet-body">Chưa có thiết bị nào dùng mã ghép (bạn đang dùng token dự phòng owm_).</p>
        ) : (
          <div>
            {devices.map((d) => (
              <div class="file-row" key={d.id} style="cursor:default">
                <span class="icon">📱</span>
                <span class="name">
                  {d.label}
                  <span class="pair-hint" style="display:block">
                    ghép {new Date(d.createdAt).toLocaleString("vi-VN")} · hoạt động {d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString("vi-VN") : "—"}
                  </span>
                </span>
                <button class="btn small danger" onClick={() => revoke(d)}>
                  Thu hồi
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div class="card">
        <h3>Ghép thiết bị / nhập token</h3>
        <label class="field" for="settings-pair-code">
          Mã ghép 8 ký tự (in trên terminal bridge, sống 30 phút — hoặc quét QR trên đó)
        </label>
        <input
          id="settings-pair-code"
          type="text"
          autocomplete="one-time-code"
          spellcheck={false}
          value={pairCode}
          onInput={(e) => setPairCode(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && submitPairCode()}
        />
        <div class="sheet-actions">
          <button class="btn small" disabled={linkBusy || !pairCode.trim()} onClick={submitPairCode}>
            Ghép với máy đang kết nối
          </button>
        </div>
        <label class="field" for="settings-token">
          Token dài hạn owm_ / owd_ (master từ QR master trên máy, hoặc khóa thiết bị khác)
        </label>
        <input
          id="settings-token"
          type="text"
          spellcheck={false}
          value={tokenInput}
          onInput={(e) => setTokenInput(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && submitToken()}
        />
        <div class="sheet-actions">
          <button class="btn small" disabled={linkBusy || !tokenInput.trim()} onClick={submitToken}>
            Kết nối bằng token
          </button>
        </div>
        {linkBusy && linkMsg && <p class="pair-hint">{linkMsg}</p>}
        {linkErr && <Banner kind="err">{linkErr}</Banner>}
      </div>

      <div class="card">
        <h3>Về dự án</h3>
        <p class="sheet-body">
          OpenWork Mobile — web app quản lý session/workspace/file của OpenWork desktop.
          Gặp lỗi thì mở <span class="mono">CODE_SUMMARY.md</span> trong thư mục dự án để biết sửa chỗ nào.
        </p>
      </div>
    </>
  );
}
