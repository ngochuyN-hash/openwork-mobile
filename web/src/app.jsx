import { useEffect, useState, useCallback } from "preact/hooks";
import { getToken, apiState } from "./api.js";
import { WsIcon, GearIcon } from "./components/icons.jsx";
import { Banner } from "./components/ui.jsx";
import { PairingScreen } from "./pages/pairing.jsx";
import { WorkspacesPage } from "./pages/workspaces.jsx";
import { SessionsPage } from "./pages/sessions.jsx";
import { ChatPage } from "./pages/chat.jsx";
import { FilesPage } from "./pages/files.jsx";
import { SettingsPage } from "./pages/settings.jsx";

// Hash router:
//   #/                     -> workspaces
//   #/ws/:id               -> sessions (workspace)
//   #/ws/:id/chat/:sid     -> chat
//   #/ws/:id/files         -> files
//   #/settings             -> settings
function parseHash() {
  const hash = location.hash.replace(/^#/, "");
  const [path, query] = hash.split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(query ?? "");
  if (parts[0] === "settings") return { view: "settings" };
  if (parts[0] === "ws" && parts[1]) {
    if (parts[2] === "chat" && parts[3]) return { view: "chat", wsId: parts[1], sessionId: parts[3] };
    if (parts[2] === "files") return { view: "files", wsId: parts[1], path: params.get("path") ?? "" };
    return { view: "sessions", wsId: parts[1] };
  }
  return { view: "workspaces" };
}

export function navigate(hash) {
  location.hash = hash;
}

export function App() {
  const [paired, setPaired] = useState(Boolean(getToken()));
  const [route, setRoute] = useState(parseHash());
  const [state, setState] = useState(null); // bridge state (poll nhẹ)

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
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
  let title = "OpenWork";
  switch (route.view) {
    case "sessions":
      view = <SessionsPage route={route} />;
      title = "Sessions";
      showNav = false;
      break;
    case "chat":
      view = <ChatPage route={route} />;
      title = "Chat";
      showNav = false;
      break;
    case "files":
      view = <FilesPage route={route} />;
      title = "Files";
      showNav = false;
      break;
    case "settings":
      view = <SettingsPage state={state} onRecheck={refreshState} onUnpaired={() => setPaired(false)} />;
      title = "Cài đặt";
      break;
    default:
      view = <WorkspacesPage />;
      title = "OpenWork Mobile";
  }

  return (
    <>
      <div class="topbar">
        <span class="logo-mark" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 64 64" fill="none">
            <path d="M18 44V26m14 18V18m14 26V32" stroke="#fff" stroke-width="8" stroke-linecap="round" />
          </svg>
        </span>
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
    return (
      <Banner kind="err" actionLabel="Thử lại" onAction={onRecheck}>
        Không tìm thấy openwork-server — OpenWork desktop có đang chạy không?
      </Banner>
    );
  }
  return null;
}

function BottomNav({ current }) {
  const tab = (name, label, path, icon) => (
    <button class={current === name ? "active" : ""} onClick={() => navigate(path)} aria-current={current === name ? "page" : undefined}>
      <span class="nav-pill">{icon}</span>
      <span>{label}</span>
    </button>
  );
  return (
    <div class="bottomnav-wrap">
      <nav class="bottomnav">
        {tab("workspaces", "Workspace", "#/", <WsIcon />)}
        {tab("settings", "Cài đặt", "#/settings", <GearIcon />)}
      </nav>
    </div>
  );
}
