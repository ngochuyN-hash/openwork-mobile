import { useState } from "preact/hooks";
import { setToken, apiState } from "../api.js";

export function PairingScreen({ onPaired }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function connect() {
    const token = code.trim();
    if (!token) return;
    setBusy(true);
    setError("");
    setToken(token);
    try {
      await apiState(); // 401 -> UNPAIRED nếu sai
      onPaired();
    } catch {
      localStorage.removeItem("owm_token");
      setError("Token không đúng hoặc bridge không chạy. Quét lại QR trên terminal của bridge nhé.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="view no-nav" style="padding-top:15vh">
      <div style="text-align:center;margin-bottom:28px">
        <svg width="56" height="56" viewBox="0 0 64 64" style="margin-bottom:8px">
          <rect width="64" height="64" rx="14" fill="#171d24" />
          <path d="M18 44V26m14 18V18m14 26V32" stroke="#4da3ff" stroke-width="6" stroke-linecap="round" />
        </svg>
        <h2 style="margin:0">OpenWork Mobile</h2>
        <p style="color:var(--text-dim);margin:6px 0 0;font-size:13.5px">
          Quản lý session, workspace và file của OpenWork từ điện thoại
        </p>
      </div>

      <div class="card">
        <label class="field">Mã pairing (in trên terminal lúc bridge khởi động, hoặc quét QR)</label>
        <input
          type="text"
          placeholder="owm_..."
          value={code}
          onInput={(e) => setCode(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && connect()}
        />
        <div style="margin-top:14px;display:flex;justify-content:flex-end">
          <button class="btn" disabled={busy || !code.trim()} onClick={connect}>
            {busy ? "Đang kết nối…" : "Kết nối"}
          </button>
        </div>
        {error && (
          <p style="color:var(--danger);font-size:13px;margin:10px 0 0">
            {error}
          </p>
        )}
      </div>

      <p style="color:var(--text-dim);font-size:12.5px;text-align:center;margin-top:18px">
        Bridge chạy trên máy tính có OpenWork. Mở link/QR từ terminal bridge là tự pair.
      </p>
    </div>
  );
}
