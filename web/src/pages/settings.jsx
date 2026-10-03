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
  apiOpenWorkPath,
} from "../api.js";
import { useConfirm, Banner } from "../components/ui.jsx";
import { PcsIcon } from "../components/icons.jsx";
import { navigate } from "../app.jsx";

export function SettingsPage({ state, onRecheck, onUnpaired }) {
  const [busy, setBusy] = useState(false);
  const [waking, setWaking] = useState(false);
  const [wakeMsg, setWakeMsg] = useState("");
  const [checkMsg, setCheckMsg] = useState("");
  const [confirmDialog, askConfirm] = useConfirm();
  const [devices, setDevices] = useState(null);
  const [thisDeviceLabel, setThisDeviceLabel] = useState("");

  // OpenWork desktop trên máy tính: object `openwork` từ /api/state. Sau khi bấm
  // "Chỉ đường dẫn" thành công thì bridge trả về openwork mới — giữ ở state để
  // vẽ ngay, khỏi đợi vòng poll sau.
  const [openworkOverride, setOpenworkOverride] = useState(null);
  const [manualPath, setManualPath] = useState("");
  const [savingPath, setSavingPath] = useState(false);
  const [pathMsg, setPathMsg] = useState("");
  const [pathErr, setPathErr] = useState("");
  // Bật/tắt khối chọn đường dẫn. Mặc định MỞ khi chưa tìm thấy (đó là lúc cần),
  // và người dùng bấm "Đổi đường dẫn" để mở khi đã tìm thấy.
  const [editing, setEditing] = useState(false);
  // Bridge trả `candidates` khi wake không tìm thấy exe — đổ vào chung bộ chọn.
  const [wakeCandidates, setWakeCandidates] = useState([]);

  useEffect(() => {
    apiDevices().then(setDevices).catch(() => setDevices([]));
    if (state?.thisDevice?.label) setThisDeviceLabel(state.thisDevice.label);
  }, [state?.thisDevice?.id]);

  // /api/state vừa về là sự thật mới nhất: bỏ giá trị tạm để tránh màn hình kẹt ở
  // kết quả cũ mãi (ví dụ vừa cài lại OpenWork ở chỗ khác, poll thấy path mới
  // nhưng UI vẫn vẽ path cũ vì override đè lên).
  useEffect(() => {
    setOpenworkOverride(null);
  }, [state?.openwork]);

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
    setCheckMsg("");
    try {
      await apiRecheck();
      onRecheck();
    } catch (e) {
      // Tunnel chết / 401 phải báo rõ, không im lặng trả nút về trạng thái cũ.
      setCheckMsg(
        e.message === "UNPAIRED"
          ? "Chìa hết hiệu lực (401) — máy đã thu hồi khóa này, hãy ghép lại."
          : `Kiểm tra lỗi: ${String(e.message || e)}`
      );
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
      // Không tìm thấy exe: bridge kèm sẵn danh sách đường dẫn nghi vấn — đừng bỏ
      // qua, đưa vào đúng bộ chọn bên dưới để người dùng chỉ được luôn.
      if (e?.candidates?.length) setWakeCandidates(e.candidates);
    } finally {
      setWaking(false);
    }
  }

  /** Gửi 1 đường dẫn exe lên bridge. Thành công thì vẽ lại từ `openwork` bridge
   * trả về; thất bại thì hiện nguyên văn message tiếng Việt của bridge. */
  async function choosePath(path) {
    const target = String(path ?? "").trim();
    if (!target) return;
    setSavingPath(true);
    setPathMsg("");
    setPathErr("");
    try {
      const payload = await apiOpenWorkPath(target);
      const nowFound = Boolean(payload?.openwork?.found);
      setOpenworkOverride(payload?.openwork ?? null);
      setManualPath("");
      setWakeCandidates([]);
      if (nowFound) setEditing(false); // xong thì đóng khối chọn, không chiếm màn hình
      setPathMsg(
        nowFound
          ? `Đã chỉ xong. Giờ bấm “Bật OpenWork trên máy tính” ở mục Trạng thái bridge để mở app.`
          : `Đã lưu nhưng bridge vẫn không thấy file này — kiểm tra lại đường dẫn.`
      );
      onRecheck(); // bảng trạng thái bridge cũng phải thấy giá trị mới
    } catch (e) {
      setPathErr(String(e?.message || e));
    } finally {
      setSavingPath(false);
    }
  }

  /** Chép đường dẫn để dán chỗ khác. Clipboard API cần ngữ cảnh an toàn (https);
   * nếu trình duyệt chặn thì bôi đen giúp người dùng tự copy. */
  async function copyExePath(path) {
    try {
      await navigator?.clipboard?.writeText(path);
      setPathMsg(`Đã chép: ${path}`);
    } catch {
      setPathErr("Trình duyệt chặn chép tự động — bôi đen đường dẫn rồi copy tay.");
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
    ["Tự mở OpenWork", state?.autoLaunchOpenWork ? "bật (bridge khởi động là mở)" : "tắt"],
    ["Bridge", `v${state?.bridgeVersion ?? "?"} · ${state?.dataDir ?? ""}`],
  ];

  // `openwork` mới hơn boolean cũ `openworkExeFound`; thiếu object (bridge cũ) thì
  // lùi về boolean để không mất thông tin cũ.
  const openworkInfo = openworkOverride ?? state?.openwork ?? null;
  const openworkFound = openworkInfo ? Boolean(openworkInfo.found) : Boolean(state?.openworkExeFound);
  // Bridge cũ không gửi `running`; lúc đó đoán qua openwork-server — server sống
// nghĩa là app đang mở, thay vì báo chết oan.
const openworkRunning =
    typeof openworkInfo?.running === "boolean" ? openworkInfo.running : Boolean(state?.server);
  const candidates = [...new Set([...(openworkInfo?.candidates ?? []), ...wakeCandidates])].filter(Boolean);
  // Khối chọn đường dẫn: luôn mở khi chưa tìm thấy (đó là lúc cần nó), ngược lại
  // chỉ mở khi người dùng bấm "Đổi đường dẫn".
  const showChooser = !openworkFound || editing;

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
        {checkMsg && <p class="sheet-body" style="margin:8px 0 0;color:var(--danger)" role="alert">{checkMsg}</p>}
        {wakeMsg && <p class="sheet-body" style="margin:8px 0 0">{wakeMsg}</p>}
      </div>

      <div class="card">
        <h3>OpenWork trên máy tính</h3>
        {!openworkFound && (
          <p class="sheet-body">
            Chưa tìm thấy <span class="mono">OpenWork.exe</span> — bật OpenWork từ xa có thể lỗi. Chỉ cho bridge biết file nằm ở đâu:
          </p>
        )}
        {openworkFound && (
          <table style="width:100%;font-size:13.5px;border-collapse:collapse">
            <tbody>
              {[
                ["Tình trạng", openworkRunning ? "đang chạy" : "đã cài, chưa mở"],
                ["Phiên bản", openworkInfo?.version ? `v${openworkInfo.version}` : "không đọc được"],
                ["Đường dẫn", openworkInfo?.exe || "—"],
                ["Tìm ở đâu", openworkSourceLabel(openworkInfo?.source)],
              ].map(([k, v]) => (
                <tr key={k}>
                  <td style="color:var(--text-dim);padding:6px 8px 6px 0;white-space:nowrap;vertical-align:top">{k}</td>
                  <td style="padding:6px 0;min-width:0;word-break:break-word" class="mono">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {/* Cài xong app mà bridge chưa quét lại thì vẫn hiện "chưa tìm thấy" —
            một nút quét lại rẻ hơn việc bắt người dùng tự hiểu phải chờ 15s. */}
        {openworkFound && !openworkInfo?.version && (
          <p class="sheet-body" style="margin:8px 0 0">
            Bản cài này không có <span class="mono">resources/app.asar</span> (hay gặp ở bản portable) nên không đọc được
            phiên bản — việc bật từ xa vẫn chạy bình thường.
          </p>
        )}
        {openworkFound && !openworkRunning && (
          <p class="sheet-body" style="margin:8px 0 0">
            Muốn mở app? Bấm “Bật OpenWork trên máy tính” ở mục Trạng thái bridge phía trên.
          </p>
        )}
        {showChooser && (
          <>
            {candidates.length > 0 && (
              <div>
                {candidates.map((p) => (
                  <div class="file-row" key={p} style="cursor:default">
                    <span class="name mono">{p}</span>
                    <button class="btn small" disabled={savingPath} onClick={() => choosePath(p)}>
                      Dùng
                    </button>
                  </div>
                ))}
              </div>
            )}
            <label class="field" for="ow-exe-path">
              {candidates.length > 0 ? "Hoặc gõ đường dẫn OpenWork.exe trên máy tính" : "Gõ đường dẫn OpenWork.exe trên máy tính"}
            </label>
            <div style="display:flex;gap:8px">
              <input
                id="ow-exe-path"
                type="text"
                style="flex:1;min-width:0"
                value={manualPath}
                autocomplete="off"
                spellcheck={false}
                onInput={(e) => setManualPath(e.currentTarget.value)}
                onKeyDown={(e) => {
                  // Enter = gửi, không bắt thêm một cú bấm nữa.
                  if (e.key === "Enter") {
                    e.preventDefault();
                    choosePath(manualPath);
                  }
                }}
                placeholder="C:\Users\...\OpenWork.exe"
              />
              <button
                class="btn"
                style="flex:none"
                disabled={savingPath || !manualPath.trim()}
                onClick={() => choosePath(manualPath)}
              >
                {savingPath ? "Đang lưu…" : "Chỉ đường dẫn"}
              </button>
            </div>
            <p class="pair-hint" style="display:block;margin-top:6px">
              Trên máy tính: mở File Explorer → vào thư mục OpenWork → chuột phải OpenWork.exe → Copy as path rồi dán vào đây.
            </p>
          </>
        )}
        <div class="page-actions" style="margin-top:12px">
          <button class="btn small" disabled={busy} onClick={recheck}>
            {busy ? "Đang kiểm tra…" : "Quét lại máy tính"}
          </button>
          {openworkFound && (
            <button class="btn small" onClick={() => setEditing(!editing)}>
              {editing ? "Đóng" : "Đổi đường dẫn"}
            </button>
          )}
          {openworkFound && openworkInfo?.exe && (
            <button class="btn small ghost" onClick={() => copyExePath(openworkInfo.exe)}>
              Chép đường dẫn
            </button>
          )}
        </div>
        {pathErr && <Banner kind="err">{pathErr}</Banner>}
        {/* styles.css chưa có .banner.ok (và không thêm ở đây) — dùng màu --ok
            sẵn có, tránh thêm class mới cho một dòng thông báo. */}
        {pathMsg && (
          <p class="sheet-body" style="margin:0;color:var(--ok)" role="status">
            {pathMsg}
          </p>
        )}
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
                <span class="icon"><PcsIcon size={20} /></span>
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

/** `source` của describeOpenWorkInstall: chỗ bridge tìm ra exe (bridge/src/openwork-version.js). */
function openworkSourceLabel(source) {
  if (source === "config") return "đường dẫn đã lưu trong config.json";
  if (source === "env") return "biến môi trường OPENWORK_EXE";
  if (source === "wellknown") return "vị trí mặc định khi cài OpenWork";
  return "—";
}
