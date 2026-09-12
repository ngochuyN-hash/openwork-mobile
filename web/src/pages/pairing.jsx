import { useEffect, useState } from "preact/hooks";
import { setToken, apiState, apiPair, pairingCodeFromHash } from "../api.js";
import { Banner } from "../components/ui.jsx";
import { OpenWorkMark } from "../components/logo.jsx";

// Ghép thiết bị kiểu 9Remote:
//  - Mở link/QR từ terminal bridge (#p=MÃ) → tự ghép, nhận khóa vĩnh viễn owd_
//  - Hoặc tự gõ mã 8 ký tự (XXXX-XXXX) in trên terminal
//  - Hoặc dán token dự phòng owm_/owd_ (đường cứu hộ)
export function PairingScreen({ onPaired }) {
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function pairWithCode(codeValue, labelValue) {
    setBusy(true);
    setError("");
    setStatus("Đang ghép với bridge…");
    try {
      const { token } = await apiPair(codeValue, labelValue);
      setToken(token);
      onPaired();
    } catch (e) {
      setStatus("");
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  // Dự phòng: dán trực tiếp token dài (owm_/owd_)
  async function connectWithToken() {
    const token = code.trim();
    if (!token) return;
    setBusy(true);
    setError("");
    setStatus("Đang kiểm tra token…");
    setToken(token);
    try {
      await apiState();
      onPaired();
    } catch {
      localStorage.removeItem("owm_token");
      setStatus("");
      setError("Token không đúng hoặc bridge chưa chạy.");
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    const value = code.trim().toUpperCase();
    if (!value) return;
    if (value.startsWith("OWM_") || value.startsWith("OWD_")) return connectWithToken();
    return pairWithCode(value, label);
  }

  // Tự ghép khi mở từ QR/link .../#p=MÃ
  useEffect(() => {
    const fromHash = pairingCodeFromHash();
    if (fromHash) pairWithCode(fromHash, "");
  }, []);

  return (
    <div class="view no-nav pair-view">
      <div class="pair-hero">
        <OpenWorkMark className="pair-logo" />
        <h2 style="margin:0;letter-spacing:-0.01em">OpenWork Mobile</h2>
        <p class="pair-sub">Quản lý session, workspace và file của OpenWork từ điện thoại</p>
      </div>

      <div class="card">
        <label class="field" for="pair-code">
          Mã ghép (in trên terminal bridge, sống 30 phút — hoặc quét QR trên đó)
        </label>
        <input
          id="pair-code"
          type="text"
          placeholder="XXXX-XXXX"
          autocomplete="one-time-code"
          spellcheck={false}
          value={code}
          onInput={(e) => setCode(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <label class="field" for="pair-label">Tên thiết bị này (tùy chọn)</label>
        <input
          id="pair-label"
          type="text"
          placeholder="vd: iPhone của bạn"
          value={label}
          onInput={(e) => setLabel(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <div class="sheet-actions">
          <button class="btn" disabled={busy || !code.trim()} onClick={submit}>
            {busy ? status || "Đang ghép…" : "Ghép thiết bị"}
          </button>
        </div>
        {status && !error && <p class="pair-hint">{status}</p>}
        {error && <Banner kind="err">{error}</Banner>}
      </div>

      <p class="pair-hint">
        Ghép xong thiết bị này được cấp khóa vĩnh viễn — lần sau mở app là vào thẳng, không cần mã nữa.
        Mất điện thoại / muốn bỏ quyền truy cập: vào Cài đặt → Thiết bị đã ghép → thu hồi.
      </p>
    </div>
  );
}
