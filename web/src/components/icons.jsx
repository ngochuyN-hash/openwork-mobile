/** Icon set nội bộ (SVG stroke, currentColor) — thay emoji làm icon (skill pwa-workspace-ui). */
export function Icon({ children, size = 20, label }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden={label ? "false" : "true"}
      aria-label={label}
      role={label ? "img" : undefined}
      style="flex:none"
    >
      {children}
    </svg>
  );
}

export function FolderIcon({ size }) {
  return (
    <Icon size={size ?? 20}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </Icon>
  );
}

export function FileIcon({ size }) {
  return (
    <Icon size={size ?? 20}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </Icon>
  );
}

export function ImageIcon({ size }) {
  return (
    <Icon size={size ?? 20}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-4.5-4.5L6 21" />
    </Icon>
  );
}

export function UploadIcon({ size }) {
  return (
    <Icon size={size ?? 20}>
      <path d="M12 16V4m0 0 4 4m-4-4-4 4" />
      <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </Icon>
  );
}

export function DownloadIcon({ size }) {
  return (
    <Icon size={size ?? 20}>
      <path d="M12 4v12m0 0 4-4m-4 4-4-4" />
      <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </Icon>
  );
}

export function RefreshIcon({ size }) {
  return (
    <Icon size={size ?? 20}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </Icon>
  );
}

export function BackIcon({ size }) {
  return (
    <Icon size={size ?? 16}>
      <path d="m15 18-6-6 6-6" />
    </Icon>
  );
}

export function PlusIcon({ size }) {
  return (
    <Icon size={size ?? 16}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function WsIcon({ size }) {
  return (
    <Icon size={size ?? 22}>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </Icon>
  );
}

export function GearIcon({ size }) {
  // Bánh răng kiểu Lucide "settings" — bản cũ vẽ circle + 8 tia nên nhìn như icon light mode.
  return (
    <Icon size={size ?? 22}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  );
}

export function MessageIcon({ size }) {
  return (
    <Icon size={size ?? 22}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </Icon>
  );
}

export function ClipIcon({ size }) {
  return (
    <Icon size={size ?? 22}>
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </Icon>
  );
}

export function StopIcon({ size }) {
  return (
    <Icon size={size ?? 20}>
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function ScreenIcon({ size }) {
  return (
    <Icon size={size ?? 22}>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8m-4-4v4" />
    </Icon>
  );
}

export function MouseIcon({ size }) {
  return (
    <Icon size={size ?? 18}>
      <rect x="6" y="2" width="12" height="20" rx="6" />
      <path d="M12 6v4" />
    </Icon>
  );
}

export function ExpandIcon({ size }) {
  return (
    <Icon size={size ?? 18}>
      <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
    </Icon>
  );
}

export function CameraIcon({ size }) {
  return (
    <Icon size={size ?? 18}>
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </Icon>
  );
}

export function PasteIcon({ size }) {
  return (
    <Icon size={size ?? 18}>
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    </Icon>
  );
}

export function KeyboardIcon({ size }) {
  return (
    <Icon size={size ?? 20}>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M7 13h.01M17 13h.01M9 16.5h6" />
    </Icon>
  );
}

export function MousePointerIcon({ size }) {
  return (
    <Icon size={size ?? 20}>
      <path d="M4 3.5l7.5 17.5 2.3-7.2L21 11.5z" />
    </Icon>
  );
}

export function ClipboardIcon({ size }) {
  return (
    <Icon size={size ?? 20}>
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    </Icon>
  );
}

export function LockIcon({ size }) {
  return (
    <Icon size={size ?? 18}>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </Icon>
  );
}

export function UnlockIcon({ size }) {
  return (
    <Icon size={size ?? 18}>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 9.9-1" />
    </Icon>
  );
}

export function SendIcon({ size }) {
  return (
    <Icon size={size ?? 16}>
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4z" />
    </Icon>
  );
}
