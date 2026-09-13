import { useCallback, useEffect, useState } from "preact/hooks";
import {
  listKeys,
  removeKey,
  notifyKeysChanged,
  ensureActiveKeyEntry,
  apiMachineStatus,
  apiRevokeMachineKey,
  apiPairTenant,
  setToken,
  setTenant,
  getTenant,
} from "../api.js";
import { Banner, Empty, useConfirm } from "../components/ui.jsx";
import { navigate } from "../app.jsx";

// Tab PCs ("mục PC" kiểu 9remote): chùm chìa nhiều máy trong một app. Bấm máy
// = chuyển sang máy đó 1 chạm; mỗi máy 1 chìa owd_ chỉ mở đúng máy của nó.
// Ngắt kết nối là quyền của điện thoại, 2 mức:
//   - Rời máy  = xóa chìa khỏi app, khóa còn nằm trên máy.
//   - Ngắt hẳn = thu hồi khóa TRÊN MÁY (DELETE /api/devices/:id) + xóa chìa —
//     phone này chết hẳn với máy đó, vào lại phải có link mời/mã ghép mới.
// Trạng thái máy kiểm tra ĐÚNG 1 LẦN khi mở tab — không poll liên tục.

const STATUS_TEXT = {
  online: "Trực tuyến",
  offline: "Máy offline",
  revoked: "Chìa hết hiệu lực",
};

export function PcsPage() {
  const [keys, setKeys] = useState(listKeys);
  const [statuses, setStatuses] = useState({});
  const [checking, setChecking] = useState(false);
  // null = không thẻ nào đang bận. KHÔNG dùng "" làm giá trị khởi tạo — máy
  // không phòng có tenant "" sẽ khớp luôn và khóa nút vĩnh viễn.
  const [busyTenant, setBusyTenant] = useState(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [confirmDialog, askConfirm] = useConfirm();

  const checkAll = useCallback(async () => {
    ensureActiveKeyEntry();
    const ks = listKeys();
    setKeys(ks);
    setChecking(true);
    try {
      const results = await Promise.all(ks.map((k) => apiMachineStatus(k.token, k.tenant)));
      setStatuses(Object.fromEntries(ks.map((k, i) => [k.tenant, results[i]])));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    checkAll();
  }, [checkAll]);

  // Bấm thẻ = nối sang máy đó: chìa của máy thành chìa active, app về Sessions
  // và mọi request/SSE tự mang header phòng mới (worker relay đúng bridge).
  function useMachine(k) {
    setToken(k.token);
    setTenant(k.tenant, k.name);
    navigate("#/");
  }

  function detach(k) {
    askConfirm({
      title: "Rời máy này?",
      body: "Chỉ xóa chìa khỏi app — khóa vẫn còn trên máy, vào lại bằng đăng nhập hoặc link mời.",
      confirmLabel: "Rời máy",
      onConfirm: () => {
        removeKey(k.tenant);
        notifyKeysChanged();
        checkAll();
      },
    });
  }

  function hardStop(k) {
    const deviceId = statuses[k.tenant]?.state?.thisDevice?.id;
    const canRevoke = Boolean(deviceId) && deviceId !== "master";
    askConfirm({
      title: "Ngắt hẳn máy này?",
      body: canRevoke
        ? "Khóa của điện thoại này sẽ bị THU HỒI TRÊN MÁY — app mất quyền vĩnh viễn cho tới khi có link mời/mã ghép mới, chìa cũng bị xóa khỏi app."
        : deviceId === "master"
          ? "Đây là token master nằm trong config của máy — không thu hồi được từ xa. Chỉ xóa chìa khỏi app, muốn chết hẳn phải rút token trên máy."
          : "Máy đang không nối được nên không thu hồi khóa trên máy được. Chỉ xóa chìa khỏi app — khóa cũ vẫn nằm trên máy cho tới khi chủ máy dọn.",
      confirmLabel: "Ngắt hẳn",
      onConfirm: async () => {
        setBusyTenant(k.tenant);
        try {
          if (canRevoke) await apiRevokeMachineKey(k.token, k.tenant, deviceId);
          removeKey(k.tenant);
          notifyKeysChanged();
          setError("");
        } catch (e) {
          setError(`Ngắt hẳn lỗi: ${String(e.message || e)} — chìa chưa xóa, thử lại.`);
        } finally {
          setBusyTenant(null);
          checkAll();
        }
      },
    });
  }

  const activeTenant = String(getTenant() ?? "").trim().toLowerCase();

  return (
    <>
      {confirmDialog}
      {adding && (
        <AddMachineSheet
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            notifyKeysChanged();
            checkAll();
          }}
        />
      )}
      {keys.length === 0 ? (
        <Empty
          icon
          title="Chưa có máy nào trong app"
          hint="Đăng nhập phòng hoặc dán link mời để thêm máy đầu tiên."
          actionLabel="Thêm máy"
          onAction={() => setAdding(true)}
        />
      ) : (
        <>
          <div class="page-actions">
            <button class="btn small" disabled={checking} onClick={checkAll}>
              {checking ? "Đang kiểm tra…" : "Kiểm tra máy"}
            </button>
            <button class="btn small primary" onClick={() => setAdding(true)}>
              Thêm máy
            </button>
          </div>
          {error && <Banner kind="err">{error}</Banner>}
          {keys.map((k) => (
            <PcCard
              key={k.tenant || "main"}
              k={k}
              status={statuses[k.tenant]}
              checking={checking}
              active={activeTenant === String(k.tenant).trim().toLowerCase()}
              busy={busyTenant === k.tenant}
              onUse={() => useMachine(k)}
              onDetach={() => detach(k)}
              onStop={() => hardStop(k)}
            />
          ))}
        </>
      )}
    </>
  );
}

function PcCard({ k, status, checking, active, busy, onUse, onDetach, onStop }) {
  const st = status?.status ?? (checking ? "checking" : "offline");
  return (
    <div class="card pc-card">
      <button class="pc-main" onClick={onUse} aria-label={`Dùng máy ${k.name}`}>
        <span class="pc-name">
          <span class={`pc-dot ${st}`} aria-hidden="true" />
          <span class="pc-name-text">{k.name}</span>
          {active && <span class="pc-badge">Đang dùng</span>}
        </span>
        <span class="pc-meta">
          <span class="mono">{k.tenant || "máy chính"}</span>
          <span class={`pc-state ${st === "revoked" ? "err" : ""}`}>{STATUS_TEXT[st] ?? "Đang kiểm tra…"}</span>
        </span>
      </button>
      <div class="pc-actions">
        <button class="btn small ghost" disabled={busy} onClick={onDetach}>
          Rời máy
        </button>
        <button class="btn small danger" disabled={busy} onClick={onStop}>
          Ngắt hẳn
        </button>
      </div>
    </div>
  );
}

function AddMachineSheet({ onClose, onAdded }) {
  const [invite, setInvite] = useState("");
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function login(u, s) {
    setBusy(true);
    setError("");
    try {
      await apiPairTenant(u, s, "", { activate: true });
      onAdded();
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  function submitInvite() {
    const m = /#i=([A-Za-z0-9][A-Za-z0-9-]{0,31}):([^&\s]+)/.exec(invite.trim());
    if (!m) {
      setError("Link mời không đúng — copy nguyên link có đuôi #i=tên:khóa rồi dán lại.");
      return;
    }
    login(m[1], m[2]);
  }

  return (
    <div class="sheet-backdrop" onClick={onClose}>
      <div class="card sheet" role="dialog" aria-modal="true" aria-label="Thêm máy" onClick={(e) => e.stopPropagation()}>
        <h3>Thêm máy</h3>
        <label class="field" for="pc-invite">
          Link mời (thẻ mời chủ máy gửi — tự bóc user + khóa)
        </label>
        <input
          id="pc-invite"
          type="url"
          inputmode="url"
          spellcheck={false}
          placeholder="https://…/#i=ten:khóa…"
          value={invite}
          onInput={(e) => setInvite(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && submitInvite()}
        />
        <div class="sheet-actions">
          <button class="btn" disabled={busy || !invite.trim()} onClick={submitInvite}>
            Dùng link mời
          </button>
        </div>
        <label class="field" for="pc-user">Hoặc gõ tài khoản phòng</label>
        <input
          id="pc-user"
          type="text"
          autocomplete="username"
          autocapitalize="none"
          spellcheck={false}
          value={user}
          onInput={(e) => setUser(e.currentTarget.value)}
        />
        <label class="field" for="pc-pass">Mật khẩu</label>
        <input
          id="pc-pass"
          type="password"
          autocomplete="current-password"
          value={pass}
          onInput={(e) => setPass(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && login(user, pass)}
        />
        <div class="sheet-actions">
          <button class="btn" disabled={busy || !user.trim() || !pass} onClick={() => login(user, pass)}>
            Đăng nhập phòng
          </button>
          <button class="btn ghost" onClick={onClose}>
            Đóng
          </button>
        </div>
        {busy && <p class="pair-hint">Đang đăng nhập…</p>}
        {error && <Banner kind="err">{error}</Banner>}
      </div>
    </div>
  );
}
