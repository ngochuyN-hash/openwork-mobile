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
  return (
    <Icon size={size ?? 22}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9l2.1 2.1m10 10 2.1 2.1m0-14.2-2.1 2.1m-10 10-2.1 2.1" />
    </Icon>
  );
}
