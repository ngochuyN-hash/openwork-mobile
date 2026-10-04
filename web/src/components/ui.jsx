import { useEffect, useRef, useState } from "preact/hooks";
import { FolderIcon } from "./icons.jsx";

/** Component dùng chung (skill pwa-workspace-ui) — gom mẫu loading/error/empty
 *  đang copy ở mỗi page, thay confirm() native, icon SVG thay emoji. */

export function Loading({ text = "Loading…" }) {
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

export function Empty({ title, hint, actionLabel, onAction, icon }) {
  // `icon` nhận cả hai dạng: component (icon={WsIcon}) hoặc cờ trần (icon →
  // FolderIcon). Ba page đang dùng dạng cờ, đừng đổi hết sang dạng component.
  const Icon = typeof icon === "function" ? icon : icon ? FolderIcon : null;
  return (
    <div class="empty">
      {Icon && (
        <span class="empty-ico" aria-hidden="true">
          <Icon size={26} />
        </span>
      )}
      <p class="empty-title">{title}</p>
      {hint && <p class="empty-hint">{hint}</p>}
      {actionLabel && (
        // `type="button"` BẮT BUỘC: component này dùng chung, và `<button>` mặc
        // định là submit — đặt trong `<form>` (sessions.jsx có hai form) thì
        // bấm "Tải file lên" / "Thử lại" sẽ submit form ngoài ý muốn.
        <button type="button" class="btn small primary" onClick={onAction}>
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
        <button type="button" class="btn small ghost" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

export function ConfirmDialog({ title, body, confirmLabel = "Confirm", onConfirm, onClose }) {
  return (
    <div class="sheet-backdrop" onClick={onClose}>
      <div class="card sheet" role="alertdialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {body && <p class="sheet-body">{body}</p>}
        <div class="sheet-actions">
          <button type="button" class="btn ghost" onClick={onClose}>
            Close
          </button>
          <button type="button" class="btn danger-solid" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
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

/**
 * Vuốt trái để lộ nút hành động (kiểu iOS/Zalo) — thường là "Xoá" nền đỏ.
 * - Kéo ngang qua ngưỡng (40% bề rộng nút) thì hụp mở, nhả sớm thì đóng lại.
 * - Kéo dọc vẫn cuộn trang bình thường (touch-action: pan-y).
 * - Mỗi lúc chỉ 1 dòng mở: trang truyền `open` + `requestOpen` (giữ openId).
 * - Bấm vào nội dung khi đang mở = đóng lại; bấm ra ngoài = đóng; bấm nội dung
 *   khi đóng thì chạy `onTap` (mở hội thoại). Kéo không được tính là bấm.
 */
export function SwipeRow({ open, requestOpen, onAction, onTap, actionLabel = "Delete", actionWidth = 84, children }) {
  const rowRef = useRef(null);
  const contentRef = useRef(null);
  const s = useRef({ startX: 0, startY: 0, base: 0, axis: null, suppress: false });

  const show = open ? -actionWidth : 0;

  // Khi open đổi từ nơi khác (mở dòng khác / bấm ngoài / vừa xoá) → về đúng vị trí
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    el.style.transition = "transform 180ms ease";
    el.style.transform = `translateX(${show}px)`;
  }, [show]);

  // Bấm ra ngoài dòng đang mở → đóng lại
  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (rowRef.current && !rowRef.current.contains(e.target)) requestOpen?.(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open, requestOpen]);

  function down(e) {
    const st = s.current;
    st.startX = e.clientX;
    st.startY = e.clientY;
    st.base = open ? -actionWidth : 0;
    st.axis = null;
    st.suppress = false;
  }

  function move(e) {
    const st = s.current;
    if (st.axis === "y") return;
    const dx = e.clientX - st.startX;
    const dy = e.clientY - st.startY;
    if (!st.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      st.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (st.axis === "y") return; // kéo dọc = để trình duyệt cuộn
      st.suppress = true;
      try {
        contentRef.current?.setPointerCapture(e.pointerId);
      } catch {}
    }
    let t = st.base + dx;
    if (t > 0) t = 0; // không kéo quá mép trái
    if (t < -actionWidth - 24) t = -actionWidth - 24; // đề kháng khi quá tay
    const el = contentRef.current;
    if (el) {
      el.style.transition = "none";
      el.style.transform = `translateX(${t}px)`;
    }
  }

  function up() {
    const st = s.current;
    if (st.axis !== "x") return;
    st.axis = null;
    // Ghi mốc để phân biệt "click kèm theo cử chỉ kéo vừa xong" (nuốt)
    // với "tap thật sau đó" (phải xử lý) — kéo trên touch thường KHÔNG kèm click,
    // nên không xoá suppress ngay ở đây, mà tính theo thời gian ở tap().
    st.dragEndAt = performance.now();
    const el = contentRef.current;
    const t = el ? parseFloat(String(el.style.transform).replace(/[^\d.-]/g, "") || "0") : st.base;
    const target = Math.abs(t) >= actionWidth * 0.4;
    requestOpen?.(target);
    if (el) {
      el.style.transition = "transform 180ms ease";
      el.style.transform = `translateX(${target ? -actionWidth : 0}px)`;
    }
  }

  // Bấm (không kéo): đang mở → đóng; đang đóng + không phải kéo → mở hội thoại.
  function tap(e) {
    const st = s.current;
    if (st.suppress) {
      st.suppress = false;
      if (performance.now() - st.dragEndAt < 400) {
        e.preventDefault();
        e.stopPropagation();
        return; // click của chính cử chỉ kéo (chuột kéo xong nhả tại chỗ)
      }
      // kéo đã lâu — đây là tap thật của người dùng, xử lý bình thường
    }
    if (open) {
      e.preventDefault();
      e.stopPropagation();
      requestOpen?.(false);
      return;
    }
    onTap?.();
  }

  return (
    <div ref={rowRef} class="swipe-row" style={{ "--swipe-w": `${actionWidth}px` }}>
      <button
        class="swipe-action"
        type="button"
        aria-label={actionLabel}
        // Nút nằm SƯỜN khi hàng đóng (chỉ lộ khi vuốt trái) — vẫn focusable
        // bằng Tab là bẫy keyboard; hàng đóng thì tabindex="-1", mở mới Tab tới.
        tabindex={open ? undefined : "-1"}
        aria-hidden={open ? undefined : "true"}
        onClick={(e) => {
          e.stopPropagation();
          onAction?.();
        }}
      >
        {actionLabel}
      </button>
      <div
        ref={contentRef}
        class="swipe-content"
        style={`touch-action:pan-y;transform:translateX(${show}px);transition:transform 180ms ease`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onClick={tap}
      >
        {children}
      </div>
    </div>
  );
}
