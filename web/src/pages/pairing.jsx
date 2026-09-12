import { useState } from "preact/hooks";
import { setToken, apiState } from "../api.js";
import { Banner } from "../components/ui.jsx";

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
      setError("Token không đúng hoặc bridge chưa chạy. Nhập lại mã in trên terminal của bridge nhé.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="view no-nav pair-view">
      <div class="pair-hero">
        <svg width="56" height="56" viewBox="0 0 64 64" aria-hidden="true" style="margin-bottom:8px">
          <rect width="64" height="64" rx="14" fill="#171d24" />
          <path d="M18 44V26m14 18V18m14 26V32" stroke="#4da3ff" stroke-width="6" stroke-linecap="round" />
        </svg>
        <h2 style="margin:0">OpenWork Mobile</h2>
        <p class="pair-sub">
          Quản lý session, workspace và file của OpenWork từ điện thoại
        </p>
      </div>

      <div class="card">
        <label class="field" for="pair-code">Mã pairing (in trên terminal lúc bridge khởi động, hoặc quét QR)</label>
        <input
          id="pair-code"
          type="text"
          placeholder="owm_…"
          autocomplete="one-time-code"
          spellcheck={false}
          value={code}
          onInput={(e) => setCode(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && connect()}
        />
        <div class="sheet-actions">
          <button class="btn" disabled={busy || !code.trim()} onClick={connect}>
            {busy ? "Đang kết nối…" : "Kết nối"}
          </button>
        </div>
        {error && <Banner kind="err">{error}</Banner>}
      </div>

      <p class="pair-hint">
        Bridge chạy trên máy tính có OpenWork. Mở link/QR từ terminal bridge là tự pair.
      </p>
    </div>
  );
}
