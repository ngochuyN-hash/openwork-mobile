import { useEffect, useState, useCallback } from "preact/hooks";
import { getToken, apiState } from "./api.js";
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
        <span class="title">{title}</span>
        {state?.server ? <span class="sub">server {state.server.version}</span> : <span class="sub">…</span>}
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
      <div class="banner warn">
        <span>
          Cần <b>restart OpenWork đúng 1 lần</b> để kích hoạt token cho bridge. Xong rồi bấm kiểm tra lại.
        </span>
        <button class="btn small ghost" onClick={onRecheck}>
          Kiểm tra lại
        </button>
      </div>
    );
  }
  if (!state.server) {
    return (
      <div class="banner err">
        <span>Không tìm thấy openwork-server — OpenWork desktop có đang chạy không?</span>
        <button class="btn small ghost" onClick={onRecheck}>
          Thử lại
        </button>
      </div>
    );
  }
  return null;
}

function BottomNav({ current }) {
  const tab = (name, label, path, icon) => (
    <button class={current === name ? "active" : ""} onClick={() => navigate(path)}>
      {icon}
      <span>{label}</span>
    </button>
  );
  return (
    <nav class="bottomnav">
      {tab("workspaces", "Workspaces", "#/", (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="7" width="18" height="13" rx="2" />
          <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      ))}
      {tab("settings", "Cài đặt", "#/settings", (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      ))}
    </nav>
  );
}
