import { useState } from "preact/hooks";

/** Component dùng chung (skill pwa-workspace-ui) — gom mẫu loading/error/empty
 *  đang copy ở mỗi page, thay confirm() native, icon SVG thay emoji. */

export function Loading({ text = "Đang tải…" }) {
  return (
    <div class="empty" role="status" aria-live="polite">
      <span class="spinner" aria-hidden="true" /> {text}
    </div>
  );
}

export function SkeletonList({ rows = 3 }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div class="card" key={i}>
          <div class="sk sk-title" />
          <div class="sk sk-line" />
        </div>
      ))}
    </div>
  );
}

export function Empty({ title, hint, actionLabel, onAction }) {
  return (
    <div class="empty">
      <p style="margin:0 0 4px;font-weight:600;color:var(--text)">{title}</p>
      {hint && <p style="margin:0 0 12px">{hint}</p>}
      {actionLabel && (
        <button class="btn small" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

export function Banner({ kind = "err", children, actionLabel, onAction }) {
  return (
    <div class={`banner ${kind}`} role="alert">
      <span>{children}</span>
      {actionLabel && (
        <button class="btn small ghost" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

export function ConfirmDialog({ title, body, confirmLabel = "Xác nhận", onConfirm, onClose }) {
  return (
    <div class="sheet-backdrop" onClick={onClose}>
      <div class="card sheet" role="alertdialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {body && <p class="sheet-body">{body}</p>}
        <div class="sheet-actions">
          <button class="btn ghost" onClick={onClose}>
            Đóng
          </button>
          <button class="btn danger-solid" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function BackButton({ label, onBack }) {
  return (
    <button class="btn small ghost btn-icon" onClick={onBack} aria-label={`Quay lại ${label}`}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="m15 18-6-6 6-6" />
      </svg>
      <span>{label}</span>
    </button>
  );
}

/** Hook xác nhận phá hủy (thay confirm() native). */
export function useConfirm() {
  const [pending, setPending] = useState(null);
  const dialog = pending ? (
    <ConfirmDialog
      title={pending.title}
      body={pending.body}
      confirmLabel={pending.confirmLabel}
      onClose={() => setPending(null)}
      onConfirm={() => {
        setPending(null);
        pending.onConfirm();
      }}
    />
  ) : null;
  return [dialog, (opts) => setPending(opts)];
}
