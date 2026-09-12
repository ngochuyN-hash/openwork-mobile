import { useState } from "preact/hooks";
import { clearToken, apiRecheck } from "../api.js";
import { useConfirm } from "../components/ui.jsx";

export function SettingsPage({ state, onRecheck, onUnpaired }) {
  const [busy, setBusy] = useState(false);
  const [confirmDialog, askConfirm] = useConfirm();

  async function recheck() {
    setBusy(true);
    try {
      await apiRecheck();
      onRecheck();
    } finally {
      setBusy(false);
    }
  }

  function unpair() {
    askConfirm({
      title: "Gỡ pairing?",
      body: "Điện thoại này sẽ quên token và quay về màn nhập mã pairing.",
      confirmLabel: "Gỡ pairing",
      onConfirm: () => {
        clearToken();
        onUnpaired();
      },
    });
  }

  const rows = [
    ["openwork-server", state?.server ? `${state.server.baseUrl} (v${state.server.version})` : "chưa tìm thấy"],
    ["opencode", state?.server?.opencodeVersion ?? "—"],
    ["Token", state?.tokenActive ? "đang hoạt động" : state?.restartRequired ? "chờ restart OpenWork" : "đang kiểm tra…"],
    ["Engine", state?.engine ? `pid ${state.engine.pid} (port ${state.engine.enginePort})` : "—"],
    ["URL từ xa", state?.publicUrl ?? "—"],
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
          <button class="btn small danger" onClick={unpair}>
            Gỡ pairing
          </button>
        </div>
      </div>

      <div class="card">
        <h3>Truy cập từ xa (Tailscale)</h3>
        <p class="sheet-body">
          Bridge chỉ nghe trên 127.0.0.1 của máy tính. Để dùng từ bên ngoài, trên máy tính chạy:
        </p>
        <pre class="mono" style="background:var(--bg);padding:10px;border-radius:8px;overflow:auto">tailscale serve --bg 8788</pre>
        <p class="sheet-body">
          Rồi mở URL tailscale in ra trên terminal bridge (kèm QR) trên điện thoại.
        </p>
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
