import { useEffect, useState } from "preact/hooks";
import { setToken, apiPair, pairingCodeFromHash } from "../api.js";
import { Banner } from "../components/ui.jsx";
import { OpenWorkMark } from "../components/logo.jsx";

// Màn vào app kiểu 9remote: DUY NHẤT ô mã ghép 8 ký tự (in trong OpenPocket
// trên máy tính, sống 30 phút). Không tài khoản, không mật khẩu — chìa duy
// nhất là token do chính máy đó cấp lúc ghép mã. Link QR #p= (và master #t=)
// tự ghép trước khi tới màn này; muốn gõ tay thì mở OpenPocket → "Xem mã ghép".
export function PairingScreen({ onPaired }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function pairWithCode(codeValue) {
    setBusy(true);
    setError("");
    setStatus("Đang ghép với máy tính…");
    try {
      const { token } = await apiPair(codeValue, "");
      setToken(token);
      onPaired();
    } catch (e) {
      setStatus("");
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  function submit() {
    const value = code.trim().toUpperCase().replace(/[\s-]/g, "");
    if (value) pairWithCode(value);
  }

  useEffect(() => {
    const fromHash = pairingCodeFromHash();
    if (fromHash) pairWithCode(fromHash);
  }, []);

  return (
    <div class="view no-nav pair-view">
      <div class="pair-hero">
        <OpenWorkMark className="pair-logo" />
        <h2>OpenWork Mobile</h2>
        <div class="pair-sub">OpenWork in your pocket</div>
      </div>

      <div class="card">
        <label class="field" for="pair-code">
          Mã ghép 8 ký tự (hiện trong OpenPocket trên máy tính)
        </label>
        <input
          id="pair-code"
          class="pair-code-input"
          type="text"
          autocomplete="one-time-code"
          autocapitalize="characters"
          spellcheck={false}
          value={code}
          onInput={(e) => setCode(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <div class="sheet-actions">
          <button class="btn pair-btn" disabled={busy || !code.trim()} onClick={submit}>
            {busy ? status || "Đang ghép…" : "Vào"}
          </button>
        </div>
        {busy && status && !error && <p class="pair-hint">{status}</p>}
        {error && <Banner kind="err">{error}</Banner>}
        <p class="pair-hint">
          Không có mã? Bấm "Xem mã ghép (QR)" trong OpenPocket trên máy tính —
          quét QR bằng camera cũng vào được, không cần gõ.
        </p>
      </div>
    </div>
  );
}
