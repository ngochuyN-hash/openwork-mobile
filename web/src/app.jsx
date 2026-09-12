import { useEffect, useState, useCallback } from "preact/hooks";
import { getToken, apiState, apiWakeOpenWork, apiRecheck } from "./api.js";
import { BackIcon, WsIcon, GearIcon, MessageIcon, ScreenIcon } from "./components/icons.jsx";
import { Banner } from "./components/ui.jsx";
import { PairingScreen } from "./pages/pairing.jsx";
import { HomePage } from "./pages/home.jsx";
import { OpenWorkMark } from "./components/logo.jsx";
import { WorkspacesPage } from "./pages/workspaces.jsx";
import { SessionsPage } from "./pages/sessions.jsx";
import { ChatPage } from "./pages/chat.jsx";
import { FilesPage } from "./pages/files.jsx";
import { ScreenPage } from "./pages/screen.jsx";
import { SettingsPage } from "./pages/settings.jsx";

// Hash router:
//   #/                     -> home (session gần đây gộp mọi workspace)
//   #/workspaces           -> danh sách workspace
//   #/ws/:id               -> sessions (workspace)
//   #/ws/:id/chat/:sid     -> chat
//   #/ws/:id/files         -> files
//   #/screen               -> xem + điều khiển màn hình máy tính
//   #/settings             -> settings
function parseHash() {
  const hash = location.hash.replace(/^#/, "");
  const [path, query] = hash.split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(query ?? "");
  if (parts[0] === "settings") return { view: "settings" };
  if (parts[0] === "workspaces") return { view: "workspaces" };
  if (parts[0] === "screen") return { view: "screen" };
  if (parts[0] === "ws" && parts[1]) {
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

  if (!paired) return <PairingScreen onPaired={() => setPaired(true)} />;

  const banners = <StatusBanners state={state} onRecheck={refreshState} />;

  let view;
  let showNav = true;
  let title = "Phiên";
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
    case "workspaces":
      view = <WorkspacesPage />;
      title = "Workspace";
      break;
    case "screen":
      view = <ScreenPage />;
      title = "Màn hình";
      break;
    case "settings":
      view = <SettingsPage state={state} onRecheck={refreshState} onUnpaired={() => setPaired(false)} />;
      title = "Cài đặt";
      break;
    default:
      view = <HomePage />;
      title = "Phiên";
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
      <div class={`view ${showNav ? "" : "no-nav"}`}>
        {banners}
        {view}
      </div>
      {showNav && <BottomNav current={route.view} />}
    </>
  );
}

function StatusBanners({ state, onRecheck }) {
  const [waking, setWaking] = useState(false);
  const [wakeMsg, setWakeMsg] = useState("");
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
  if (!state.server) {
    const wake = async () => {
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
      </div>
    );
  }
  return null;
}

function BottomNav({ current }) {
  // Session-related views (home/sessions/chat) highlight tab Phiên; files -> Workspace.
  const activeOf = {
    home: "home",
    sessions: "home",
    chat: "home",
    files: "workspaces",
    workspaces: "workspaces",
    screen: "screen",
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
        {tab("home", "Phiên", "#/", <MessageIcon />)}
        {tab("workspaces", "Workspace", "#/workspaces", <WsIcon />)}
        {tab("screen", "Màn hình", "#/screen", <ScreenIcon />)}
        {tab("settings", "Cài đặt", "#/settings", <GearIcon />)}
      </nav>
    </div>
  );
}
