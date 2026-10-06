// Các sheet/dialog của màn chat — tách khỏi pages/chat.jsx để ChatPage chỉ
// còn trạng thái phiên. Không logic mới: cut-paste từ chat.jsx, giữ nguyên
// hành vi (kể cả comment gốc).
import { useEffect, useState } from "preact/hooks";
import {
  messageIdOf, messageRoleOf, messageTextOf, isRealMessageId,
  questionView, questionAnswered,
} from "../lib/session-ops.js";
import { MAX_SESSION_TITLE_LENGTH } from "../lib/session-rename.js";
import { ChevronDownIcon, CheckIcon } from "./icons.jsx";

/**
 * Sheet đổi tên phiên. Ô nhập dùng style input sẵn của dự án (16px chống iOS
 * zoom). Lỗi hiện NGAY TRONG sheet và KHÔNG đóng — người dùng không phải gõ
 * lại từ đầu (đúng nguyên tắc "đừng bắt gõ lại").
 */
export function RenameSheet({ initial, error, busy, inputRef, onSave, onClose }) {
  const [draft, setDraft] = useState(initial);
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 90);
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div class="sheet-backdrop" onClick={onClose}>
      <div
        class="card sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Rename session"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="sheet-grabber" />
        <h3>Rename session</h3>
        <label class="field" for="owm-session-title">New name</label>
        <input
          id="owm-session-title"
          ref={inputRef}
          type="text"
          value={draft}
          maxLength={MAX_SESSION_TITLE_LENGTH}
          placeholder="e.g. fix login bug"
          onInput={(e) => setDraft(e.currentTarget.value)}
        />
        {error && <p class="field-error">{error}</p>}
        <div class="sheet-actions">
          <button type="button" class="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" class="btn primary" onClick={onSave} disabled={busy}>
            {busy ? "Saving…" : "Save name"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Menu thao tác 1 tin nhắn (mở bằng cách chạm vào tin). Chỉ hiện nút nào ĐÚNG
 * với loại tin: sửa/xoá là của tin người dùng, chép có khi tin có chữ.
 */
export function MessageActionSheet({ message, busy, onClose, onCopy, onEdit, onFork, onRevert, onDelete }) {
  const id = messageIdOf(message);
  const role = messageRoleOf(message);
  const text = messageTextOf(message);
  // Tin client tự sinh (đang gửi tối) không có id thật trên server — mọi thao
  // tác ghi xuống máy đều bỏ qua được, nên không cho bấm.
  const real = isRealMessageId(id);
  const items = [
    text && { id: "copy", label: "Copy content", onSelect: () => onCopy(message) },
    role === "user" && text && { id: "edit", label: "Edit & resend", onSelect: () => onEdit(message) },
    real && { id: "fork", label: "Branch from this message", onSelect: () => onFork(id) },
    real && { id: "revert", label: "Revert to this message", onSelect: () => onRevert(id) },
    real && { id: "delete", label: "Delete message", danger: true, onSelect: () => onDelete(id) },
  ].filter(Boolean);

  return (
    <div class="sheet-backdrop" onClick={onClose}>
      <div
        class="card sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Message actions"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="sheet-grabber" />
        <p class="sheet-body menu-preview">{text ? text.slice(0, 160) : "(message has no text)"}</p>
        <div class="sheet-actions menu-actions">
          {items.length === 0 && <p class="sheet-body">This message is not saved on the computer yet.</p>}
          {items.map((item) => (
            <button
              key={item.id}
              class={`btn small${item.danger ? " danger" : ""}`}
              disabled={Boolean(busy)}
              onClick={() => {
                onClose();
                item.onSelect();
              }}
            >
              {busy === item.id ? "Working…" : item.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Chọn agent (opencode `GET /agent`) — engine nhận `agent` trong prompt. */
export function AgentPicker({ agents, value, open, onToggle, onClose, onChange }) {
  const current = agents.find((a) => a.name === value);
  return (
    <>
      <button
        class="model-pill agent-pill"
        type="button"
        aria-haspopup="dialog"
        aria-label={`Current agent: ${current?.name ?? "default"}. Tap to change agent`}
        onClick={onToggle}
      >
        <span class="model-pill-label">{current?.name ?? "Default agent"}</span>
        <ChevronDownIcon size={14} />
      </button>
      {open && (
        <div class="sheet-backdrop" onClick={onClose}>
          <div class="card sheet model-sheet" role="dialog" aria-modal="true" aria-label="Select agent" onClick={(e) => e.stopPropagation()}>
            <div class="sheet-grabber" />
            <div class="model-list" role="listbox" aria-label="Agent list">
              <button
                type="button"
                role="option"
                aria-selected={!value}
                class={`model-option${!value ? " selected" : ""}`}
                onClick={() => {
                  onChange("");
                  onClose();
                }}
              >
                <span class="model-option-text">
                  <span class="model-option-name">Default (not specified)</span>
                  <span class="model-option-sub">The engine picks one based on the computer config</span>
                </span>
                {!value && <CheckIcon size={18} />}
              </button>
              {agents.map((a) => {
                const selected = a.name === value;
                return (
                  <button
                    key={a.name}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    class={`model-option${selected ? " selected" : ""}`}
                    onClick={() => {
                      onChange(a.name);
                      onClose();
                    }}
                  >
                    <span class="model-option-text">
                      <span class="model-option-name">{a.name}</span>
                      <span class="model-option-sub">{a.description || a.mode}</span>
                    </span>
                    {selected && <CheckIcon size={18} />}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Câu hỏi agent đang chờ: chọn nhãn (chọn nhiều nếu câu cho phép) + ô tự nhập. */
export function QuestionCard({ request, onAnswer, onReject, busy }) {
  const view = questionView(request);
  const [selections, setSelections] = useState(() => view.items.map(() => []));
  const [custom, setCustom] = useState(() => view.items.map(() => ""));

  function toggle(i, label) {
    setSelections((prev) => {
      const next = prev.map((s, k) => (k === i ? s : s));
      next[i] = next[i].includes(label) ? next[i].filter((l) => l !== label) : [...next[i], label];
      return next;
    });
  }

  const answered = questionAnswered(view, selections, custom);
  const empty = view.items.length === 0;

  return (
    <div class="permission-card q-card">
      <b>The agent needs your answer</b>
      {empty && <p class="sheet-body">The agent asked a question but offered no choices.</p>}
      {view.items.map((item, i) => (
        <div key={i} class="q-item">
          <div class="q-text">{item.question}</div>
          <div class="q-options">
            {item.options.map((o) => {
              const on = selections[i]?.includes(o.label);
              return (
                <button
                  key={o.label}
                  class={`q-option${on ? " on" : ""}`}
                  aria-pressed={Boolean(on)}
                  onClick={() => toggle(i, o.label)}
                >
                  <span class="q-label">{o.label}</span>
                  {o.description && <span class="q-desc">{o.description}</span>}
                </button>
              );
            })}
          </div>
          {item.custom && (
            <input
              type="text"
              class="q-custom"
              aria-label="Or type your own answer"
              placeholder="Or type your own…"
              value={custom[i] ?? ""}
              onInput={(e) => {
                const v = e.currentTarget.value;
                setCustom((prev) => prev.map((c, k) => (k === i ? v : c)));
              }}
            />
          )}
        </div>
      ))}
      <div class="actions">
        <button
          class="btn small"
          disabled={busy || empty || !answered}
          onClick={() =>
            onAnswer(request, view.items.map((item, i) =>
              selections[i]?.length ? selections[i] : custom[i]?.trim() ? [custom[i].trim()] : []
            ))
          }
        >
          {busy ? "Sending…" : "Answer"}
        </button>
        <button
          class="btn small"
          disabled={busy}
          onClick={onReject}
          title="Skip — the agent continues with its own assumption"
        >
          Skip
        </button>
      </div>
    </div>
  );
}
