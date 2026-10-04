import { useEffect, useState, useCallback } from "preact/hooks";
import { getToken, apiState, apiWakeOpenWork, apiRecheck, apiOpenWorkPath } from "./api.js";
import { BackIcon, WsIcon, GearIcon, MessageIcon } from "./components/icons.jsx";
import { Banner } from "./components/ui.jsx";
import { OpenWorkFix } from "./components/openwork-fix.jsx";
import { mergeCandidates, openworkFoundOf } from "./lib/openwork-fix.js";
import { PairingScreen } from "./pages/pairing.jsx";
import { HomePage } from "./pages/home.jsx";
import { OpenWorkMark } from "./components/logo.jsx";
import { WorkspacesPage } from "./pages/workspaces.jsx";
import { SessionsPage } from "./pages/sessions.jsx";
import { ChatPage } from "./pages/chat.jsx";
import { FilesPage } from "./pages/files.jsx";
import { SearchPage } from "./pages/search.jsx";
import { SettingsPage } from "./pages/settings.jsx";

// Hash router:
//   #/                     -> home (session gần đây gộp mọi workspace)
//   #/workspaces           -> danh sách workspace
//   #/search               -> tìm phiên trên MỌI workspace
//   #/ws/:id               -> sessions (workspace)
//   #/ws/:id/search        -> tìm phiên trong workspace này
//   #/ws/:id/chat/:sid     -> chat
//   #/ws/:id/files         -> files
//   #/settings             -> settings (gồm mục "Máy của tôi" — chùm chìa nhiều máy)
function parseHash() {
  const hash = location.hash.replace(/^#/, "");
  const [path, query] = hash.split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(query ?? "");
  if (parts[0] === "settings") return { view: "settings" };
  if (parts[0] === "workspaces") return { view: "workspaces" };
  if (parts[0] === "search") return { view: "search", wsId: "" };
  if (parts[0] === "ws" && parts[1]) {
    if (parts[2] === "search") return { view: "search", wsId: parts[1] };
    if (parts[2] === "chat" && parts[3]) return { view: "chat", wsId: parts[1], sessionId: parts[3] };
    if (parts[2] === "files") return { view: "files", wsId: parts[1], path: params.get("path") ?? "" };
    return { view: "sessions", wsId: parts[1] };
  }
  return { view: "home" };
}

export function navigate(hash) {
  location.hash = hash;
}

export function App() {
  const [paired, setPaired] = useState(Boolean(getToken()));
  const [route, setRoute] = useState(parseHash());
  const [state, setState] = useState(null); // bridge state (poll nhẹ)
  // Trang con mượn topbar cho nút Trở lại/Đóng của nó (vd FileViewer).
  const [topBackOverride, setTopBackOverride] = useState(null);

  useEffect(() => {
    const onHash = () => {
      setRoute(parseHash());
      setTopBackOverride(null);
    };
    const onTopBack = (e) => setTopBackOverride(e.detail);
    window.addEventListener("hashchange", onHash);
    window.addEventListener("owm:topback", onTopBack);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("owm:topback", onTopBack);
    };
  }, []);

  // Poll bridge state mỗi 15s: phát hiện OpenWork restart / mất server.
  const refreshState = useCallback(async () => {
    if (!getToken()) return;
    try {
      setState(await apiState());
    } catch (error) {
      if (error.message === "UNPAIRED") setPaired(false);
      else setState({ ok: false, error: String(error.message || error) });
    }
  }, []);

  useEffect(() => {
    refreshState();
    const timer = setInterval(refreshState, 15_000);
    return () => clearInterval(timer);
  }, [refreshState, route.view]);

  // Chùm chìa đổi (rời máy / ngắt hẳn máy active) — App tự cập nhật paired
  // (xóa sạch chìa thì về màn đăng nhập) và poll lại máy mới.
  useEffect(() => {
    const onKeys = () => {
      setPaired(Boolean(getToken()));
      refreshState();
    };
    window.addEventListener("owm:keys", onKeys);
    return () => window.removeEventListener("owm:keys", onKeys);
  }, [refreshState]);

  if (!paired) return <PairingScreen onPaired={() => setPaired(true)} />;

  // `view` đưa xuống để banner biết mình đang vẽ ở route nào: bản sửa đường
  // dẫn trong banner phải IM LẶNG ở #/settings vì trang đó đã có bản riêng
  // (xem `showFix` trong StatusBanners).
  const banners = <StatusBanners state={state} onRecheck={refreshState} view={route.view} />;

  let view;
  let showNav = true;
  let title = "Sessions";
  // Nút Trở lại ghim trên topbar (vốn đã sticky) để cuộn đâu vẫn bấm được.
  let back = null;
  switch (route.view) {
    case "sessions":
      view = <SessionsPage route={route} />;
      title = "Sessions";
      showNav = false;
      back = { label: "Workspace", href: "#/workspaces" };
      break;
    case "chat":
      view = <ChatPage route={route} />;
      title = "Chat";
      showNav = false;
      back = { label: "Sessions", href: `#/ws/${encodeURIComponent(route.wsId)}` };
      break;
    case "files":
      view = <FilesPage route={route} />;
      title = "Files";
      showNav = false;
      back = { label: "Sessions", href: `#/ws/${encodeURIComponent(route.wsId)}` };
      break;
    case "search":
      // wsId rỗng = tìm trên mọi workspace -> quay lại Home; có wsId = tìm
      // trong workspace đó -> quay lại danh sách phiên của workspace.
      view = <SearchPage route={route} />;
      title = "Tìm phiên";
      showNav = false;
      back = route.wsId
        ? { label: "Sessions", href: `#/ws/${encodeURIComponent(route.wsId)}` }
        : { label: "Sessions", href: "#/" };
      break;
    case "workspaces":
      view = <WorkspacesPage />;
      title = "Workspace";
      break;
    case "settings":
      view = <SettingsPage state={state} onRecheck={refreshState} onUnpaired={() => setPaired(false)} />;
      title = "Settings";
      break;
    default:
      view = <HomePage />;
      title = "Sessions";
  }

  return (
    <>
      <div class="topbar">
        {(topBackOverride ?? back) && (
          <button
            class="topbar-back"
            onClick={() => {
              const target = topBackOverride ?? back;
              if (target.onBack) target.onBack();
              else navigate(target.href);
            }}
            aria-label={`Quay lại ${(topBackOverride ?? back).label}`}
          >
            <BackIcon size={18} />
            <span>{(topBackOverride ?? back).label}</span>
          </button>
        )}
        <OpenWorkMark className="logo-mark" />
        <span class="title">{title}</span>
        {state?.server ? <span class="sub">v{state.server.version}</span> : null}
      </div>
      <div class={`view ${showNav ? "" : "no-nav"}${route.view === "search" ? " search-view" : ""}${route.view === "chat" ? " chat-view" : ""}`}>
        {banners}
        {view}
      </div>
      {showNav && <BottomNav current={route.view} />}
    </>
  );
}

/** `view` = route.view của hash router, dùng để tắt bản sửa trùng ở #/settings. */
function StatusBanners({ state, onRecheck, view }) {
  const [waking, setWaking] = useState(false);
  const [wakeMsg, setWakeMsg] = useState("");
  // Đường dẫn .exe do bridge GỢI Ý, tích luỹ suốt phiên:
  //   - `wakeCandidates` — bridge gửi kèm trong lỗi /api/openwork/wake
  //     (api.js đã gắn vào `error.candidates`), tức đúng lúc người dùng bấm
  //     "Bật OpenWork" và bị đẩy vào ngõ cụt;
  //   - `state.openwork.candidates` — bridge đoán sẵn lúc /api/state.
  // Trước đây mảng thứ hai bị VỨT: bấm nút lỗi chỉ còn một dòng text, người
  // dùng phải tự đoán rồi đi tìm trang Cài đặt. Giữ vào state để vẽ ngay tại
  // chỗ — đây là màn mọi người thấy đầu tiên.
  const [wakeCandidates, setWakeCandidates] = useState([]);
  // Trạng thái khối sửa nhanh (gửi đường dẫn lên bridge). Tách khỏi `waking`:
  // đang gửi path thì nút "Bật OpenWork" vẫn phải bấm được để không kẹt người
  // dùng ở một nút chết.
  const [fixing, setFixing] = useState(false);
  const [fixErr, setFixErr] = useState("");
  const [fixMsg, setFixMsg] = useState("");

  /**
   * Gửi một đường dẫn .exe lên bridge (POST /api/openwork/path).
   *
   * CONTRACT của `OpenWorkFix`: promise này PHẢI REJECT khi lưu thất bại —
   * component dựa vào nhánh reject để GIỮ NGUYÊN đường dẫn vừa gõ tay trong
   * ô (openwork-fix.jsx, phần `submit`: resolve → `setManualPath("")`).
   * Nuốt lỗi rồi resolve thì ô bị xoá dù bridge đã từ chối, đúng cái điều
   * người dùng phải gõ lại.
   *
   * "Thất bại" ở đây gồm HAI trường hợp, không chỉ lỗi HTTP:
   *   1. `apiOpenWorkPath` ném (bridge từ chối / mạng hỏng);
   *   2. HTTP 200 nhưng `openwork.found` false — bridge nhận đường dẫn rồi
   *      vẫn không thấy file. Xem nhánh dưới.
   */
  async function chooseExePath(path) {
    setFixing(true);
    setFixErr("");
    setFixMsg("");
    let payload;
    try {
      payload = await apiOpenWorkPath(path);
    } catch (e) {
      setFixErr(String(e?.message || e));
      throw e;
    } finally {
      setFixing(false);
    }
    // Cố ý viết NGOÀI try: nhánh `throw` dưới đây không được `catch` ở trên
    // nuốt mất và thay bằng `String(e.message)` — lỗi "bridge không thấy file"
    // phải hiện nguyên văn tiếng Việt của ta, không phải "openwork_not_found".
    if (!openworkFoundOf(payload?.openwork)) {
      setFixErr("Đã lưu nhưng bridge vẫn không thấy file này — kiểm tra lại đường dẫn.");
      // Throw để `submit` GIỮ NGUYÊN cả ô gõ lẫn danh sách: đường dẫn này
      // người dùng vừa gõ tay hoặc vừa bấm "Dùng", xoá đi thì phải làm lại
      // từ đầu đúng lúc app chưa thấy exe.
      throw new Error("openwork_not_found");
    }
    // Bridge đã thấy exe. KHÔNG xoá `wakeCandidates` ở đây: `openworkStateInfo`
    // gửi kèm `candidates` ở MỌI lần gọi (bridge/src/index.js:231-233 — "Luôn
    // kèm, kể cả khi đã tìm thấy"), nên danh sách hợp nhất vẫn còn dù xoá
    // state. Việc ẩn khối sửa dựa vào cờ `openworkFound` bên dưới, không dựa
    // vào việc dọn mảng.
    setFixMsg("Đã chỉ xong. Bấm “Bật OpenWork trên máy tính” ở trên để mở app.");
    onRecheck();
  }

  if (!state) return null;
  if (state.restartRequired && !state.tokenActive) {
    return (
      <Banner
        kind="warn"
        actionLabel="Kiểm tra lại"
        onAction={onRecheck}
      >
        Cần <b>restart OpenWork đúng 1 lần</b> để kích hoạt token cho bridge. Xong rồi bấm kiểm tra lại.
      </Banner>
    );
  }
  // Lỗi thật từ lần poll gần nhất (mạng hỏng, HTTP 5xx...): hiện ĐÚNG lỗi,
  // không đổi cho "không tìm thấy openwork-server" — sai sự thật đó đẩy người
  // dùng đi restart một máy đang khoẻ.
  if (state.error) {
    return (
      <Banner kind="err" actionLabel="Thử lại" onAction={onRecheck}>
        Mất kết nối tới bridge: <b>{state.error}</b> — kiểm tra mạng/Wi-Fi rồi thử lại.
      </Banner>
    );
  }
  if (!state.server) {
    // Gộp HAI nguồn rồi lọc trùng bằng `mergeCandidates` (lib/openwork-fix.js):
    // danh sách bridge đoán sẵn và danh sách sinh ra lúc bấm nút trùng nhau là
    // chuyện thường, không dedupe thì mỗi lần bấm lại lặp đúng một dòng "Dùng".
    // `mergeCandidates` cũng bỏ rỗng/toàn khoảng trắng và loại phần tử không
    // phải chuỗi, nên payload rác từ bridge không sinh dòng "Dùng" giả.
    const candidates = mergeCandidates(state?.openwork?.candidates, wakeCandidates);
// Bridge đã tìm thấy exe thì KHÔNG còn việc gì để sửa, và tiêu đề "Chưa thấy
    // OpenWork.exe" khi đó thành nói dối. Không kiểm bằng `candidates.length`:
    // `openworkStateInfo` kèm `candidates` ở MỌI lần gọi kể cả khi đã tìm thấy
    // (bridge/src/index.js:231-233 — "Luôn kèm, kể cả khi đã tìm thấy"), nên sau
    // khi chỉ xong thẻ sửa vẫn cứng ở đó với các nút "Dùng" cho đường dẫn người
    // dùng vừa bác. Cờ này mới là điều kiện quyết định ẩn.
    // `openworkFoundOf` chỉ tin `found` khi là boolean thật, còn lại lùi về
    // `openworkExeFound` của bridge đời cũ — payload rác `found: "false"` là chuỗi
    // truthy, ép ra true sẽ GIẤU mất khối sửa đúng lúc người dùng cần. Dùng
    // helper chung thay vì viết tay để không lệch với settings.jsx.
    const openworkFound = openworkFoundOf(state?.openwork, state?.openworkExeFound);
    // Trang Cài đặt ĐÃ có sẵn bộ chọn trong thẻ "Máy của tôi" (settings.jsx
    // gọi cùng <OpenWorkFix> này). Banners render ở mọi route, nên không chặn
    // thì ở #/settings có HAI ô "Chỉ đường dẫn" trùng nhãn, HAI danh sách
    // "Dùng" trùng nội dung, và lỗi chỉ hiện ở bản banner (pathErr/pathMsg của
    // settings không liên quan gì) — dễ bấm nhầm đúng lúc người dùng đang vội.
    // Ở route đó, bản trong trang là bản duy nhất.
    const showFix = view !== "settings";
    const wake = async () => {
      setWaking(true);
      setWakeMsg("");
      // Xoá luôn hai thông báo của khối sửa: bấm lại nút này là một hành động
      // MỚI, để lại `fixErr`/`fixMsg` cũ sẽ ra hai dòng báo đồng thời (dòng
      // wake mới + dòng fix cũ không ai đánh dấu là cũ), tệ hơn là dòng xanh
      // "Đã chỉ xong" còn nằm lại bảo bấm nút vừa vừa hỏng.
      setFixErr("");
      setFixMsg("");
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
        // Bridge không tìm thấy exe nên gửi kèm `candidates`. Trước đây mảng này
        // bị vứt ở đây — chỉ còn lại dòng lỗi chết. Giữ lại để khối sửa ngay
        // dưới banner có ngay dòng để bấm, không phải đi tìm trang Cài đặt.
        if (e?.candidates?.length) setWakeCandidates((prev) => mergeCandidates(prev, e.candidates));
      } finally {
        setWaking(false);
      }
    };
    return (
      <div>
        <Banner kind="err" actionLabel="Thử lại" onAction={onRecheck}>
          Không tìm thấy openwork-server — OpenWork desktop có đang chạy không?
        </Banner>
        <div class="page-actions" style="margin:8px 0 0">
          <button class="btn small" disabled={waking} onClick={wake}>
            {waking ? "Đang bật…" : "Bật OpenWork trên máy tính"}
          </button>
        </div>
        {wakeMsg && <p class="sheet-body" style="margin:6px 0 0">{wakeMsg}</p>}
        {/* Sửa tại chỗ: chỉ hiện khi bridge thật sự gợi ý được đường dẫn VÀ chưa
            tìm thấy exe. Bấm nút mà lỗi thì `candidates` vừa được đẩy vào state,
            và danh sách này là đường ngắn duy nhất tới một cách sửa — không có
            nó thì lỗi chỉ là một dòng chữ người dùng không làm được gì. */}
        {showFix && !openworkFound && candidates.length > 0 && (
          <div class="card" style="margin-top:12px">
            <OpenWorkFix
              title="Chưa thấy OpenWork.exe — chỉ cho bridge biết nó nằm ở đâu"
              candidates={candidates}
              onChoose={chooseExePath}
              saving={fixing}
            />
          </div>
        )}
        {/* Hai dòng báo này nằm NGOÀI thẻ trên: sau khi chỉ xong, `openworkFound`
            thành true và thẻ biến mất — nếu báo cáo nằm trong thẻ thì dòng "Đã
            chỉ xong, bấm nút Bật OpenWork ở trên" cũng biến mất theo, đúng lúc
            người dùng cần biết bước tiếp theo. `wake()` ở trên đã xoá chúng khi
            bấm lại nút, nên không có chuyện dòng cũ sống dai. */}
        {showFix && fixErr && <Banner kind="err">{fixErr}</Banner>}
        {showFix && fixMsg && <Banner kind="ok">{fixMsg}</Banner>}
      </div>
    );
  }
  return null;
}

function BottomNav({ current }) {
  // Session-related views (home/sessions/chat) highlight tab Sessions; files -> Workspace.
  const activeOf = {
    home: "home",
    sessions: "home",
    chat: "home",
    search: "home",
    files: "workspaces",
    workspaces: "workspaces",
    settings: "settings",
  };
  const active = activeOf[current] ?? "home";
  const tab = (name, label, path, icon) => (
    <button class={active === name ? "active" : ""} onClick={() => navigate(path)} aria-current={active === name ? "page" : undefined}>
      <span class="nav-pill">{icon}</span>
      <span>{label}</span>
    </button>
  );
  return (
    <div class="bottomnav-wrap">
      <nav class="bottomnav">
        {tab("home", "Sessions", "#/", <MessageIcon />)}
        {tab("workspaces", "Workspace", "#/workspaces", <WsIcon />)}
        {tab("settings", "Settings", "#/settings", <GearIcon />)}
      </nav>
    </div>
  );
}
