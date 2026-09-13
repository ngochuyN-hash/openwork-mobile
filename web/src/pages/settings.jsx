import { useEffect, useState } from "preact/hooks";
import {
  getTenant,
  getTenantName,
  getToken,
  removeKey,
  notifyKeysChanged,
  apiRecheck,
  apiDevices,
  apiRevokeDevice,
  apiWakeOpenWork,
} from "../api.js";
import { useConfirm } from "../components/ui.jsx";
import { navigate } from "../app.jsx";

export function SettingsPage({ state, onRecheck, onUnpaired }) {
  const [busy, setBusy] = useState(false);
  const [waking, setWaking] = useState(false);
  const [wakeMsg, setWakeMsg] = useState("");
  const [confirmDialog, askConfirm] = useConfirm();
  const [devices, setDevices] = useState(null);
  const [thisDeviceLabel, setThisDeviceLabel] = useState("");

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

  // "Gỡ pairing" = quên máy đang kết nối trên điện thoại này (khóa vẫn nằm
  // trên máy; vào lại = quét/lấy mã ghép mới trong OpenPocket).
  function unpair() {
    const tenant = getTenant();
    askConfirm({
      title: "Gỡ pairing?",
      body: "Điện thoại này sẽ quên máy đang kết nối. Vào lại bằng cách lấy mã ghép mới trong OpenPocket trên máy tính.",
      confirmLabel: "Gỡ pairing",
      onConfirm: () => {
        removeKey(tenant); // dọn khóa khỏi chùm, hết chùm thì dọn luôn token
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
        <h3>Về dự án</h3>
        <p class="sheet-body">
          OpenWork Mobile — web app quản lý session/workspace/file của OpenWork desktop.
          Gặp lỗi thì mở <span class="mono">CODE_SUMMARY.md</span> trong thư mục dự án để biết sửa chỗ nào.
        </p>
      </div>
    </>
  );
}
