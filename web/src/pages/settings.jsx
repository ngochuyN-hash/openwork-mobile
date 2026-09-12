import { useState } from "preact/hooks";
import { clearToken, apiRecheck } from "../api.js";

export function SettingsPage({ state, onRecheck, onUnpaired }) {
  const [busy, setBusy] = useState(false);

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
    if (confirm("Gỡ pairing trên điện thoại này?")) {
      clearToken();
      onUnpaired();
    }
  }

  return (
    <>
      <div class="card">
        <h3>Trạng thái bridge</h3>
        <table style="width:100%;font-size:13.5px;border-collapse:collapse">
          <tbody>
            {[
              ["openwork-server", state?.server ? `${state.server.baseUrl} (v${state.server.version})` : "chưa tìm thấy"],
              ["opencode", state?.server?.opencodeVersion ?? "—"],
              ["Token owner", state?.tokenActive ? "đang hoạt động" : state?.restartRequired ? "chờ restart OpenWork" : "đang kiểm tra…"],
              ["Engine pid", state?.engine ? `${state.engine.pid} (port ${state.engine.enginePort})` : "—"],
              ["Bridge", `v${state?.bridgeVersion ?? "?"} · ${state?.dataDir ?? ""}`],
            ].map(([k, v]) => (
              <tr>
                <td style="color:var(--text-dim);padding:6px 8px 6px 0;white-space:nowrap;vertical-align:top">{k}</td>
                <td style="padding:6px 0" class="mono">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn small" disabled={busy} onClick={recheck}>
            {busy ? "…" : "Kiểm tra lại"}
          </button>
          <button class="btn small danger" onClick={unpair}>
            Gỡ pairing
          </button>
        </div>
      </div>

      <div class="card">
        <h3>Truy cập từ xa (Tailscale)</h3>
        <p style="color:var(--text-dim);font-size:13px;margin:8px 0">
          Bridge chỉ nghe trên 127.0.0.1 của máy tính. Để dùng từ bên ngoài, trên máy tính chạy:
        </p>
        <pre class="mono" style="background:var(--bg);padding:10px;border-radius:8px;overflow:auto">tailscale serve --bg 8788</pre>
        <p style="color:var(--text-dim);font-size:13px">
          Rồi mở URL tailscale in ra trên terminal bridge (kèm QR) trên điện thoại.
        </p>
      </div>

      <div class="card">
        <h3>Về dự án</h3>
        <p style="color:var(--text-dim);font-size:13px">
          OpenWork Mobile — web app quản lý session/workspace/file của OpenWork desktop.
          Gặp lỗi thì mở <span class="mono">CODE_SUMMARY.md</span> trong thư mục dự án để biết sửa chỗ nào.
        </p>
      </div>
    </>
  );
}
