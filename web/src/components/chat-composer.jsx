// Khung soạn tin của màn chat: pill model/mức/agent, dòng todo, thanh sửa tin,
// popup slash command, ô gõ + đính kèm, nút Dừng/Gửi và nút "về tin mới nhất".
// Thuần hiển thị — mọi trạng thái nằm ở pages/chat.jsx, đi vào qua props.
import { useRef, useState } from "preact/hooks";
import { formatBytes } from "../api.js";
import { filterCommands } from "../lib/session-ops.js";
import { jumpLabel } from "../lib/chat-scroll.js";
import { EffortPicker, ModelPicker } from "./model-picker.jsx";
import { AgentPicker } from "./chat-sheets.jsx";
import { ChevronDownIcon, ClipIcon, StopIcon } from "./icons.jsx";

export function ChatComposer({
  // model / mức suy luận / agent
  models, model, modelsLoading, onModelChange,
  effort, onEffortChange,
  agents, agent, onAgentChange,
  // dòng todo + thanh sửa tin + slash command
  todo, editing, onCancelEdit, commands, onCommand,
  // ô gõ + đính kèm
  draft, onDraft, attached, onPickFiles, onRemoveAttached,
  // gửi / dừng
  sending, busy, aborting, onSend, onAbort,
  // nút "về tin mới nhất"
  showJump, unseen, onJump,
}) {
  const [agentOpen, setAgentOpen] = useState(false);
  const attachRef = useRef(null);

  // Nút "về tin mới nhất" neo ngay TRÊN composer. `.composer` đã là
  // `position: sticky` nên nó là containing block của phần tử absolute
  // bên trong — không phải đoán chiều cao composer (cao không cố định:
  // có thêm hàng pill, file đính kèm, dòng todo).
  return (
    <div class="composer">
      <div style="flex:1;min-width:0">
        <div class="composer-pills">
          <ModelPicker
            models={models}
            value={model}
            loading={modelsLoading}
            onChange={onModelChange}
          />
          {/* Mức suy luận: tự ẩn khi model không khai mức nào (chọn xong mới
              biết) — có nút mà bấm không đổi gì thì hỏng trải nghiệm. */}
          <EffortPicker
            modelValue={model}
            variants={models.find((m) => m.value === model)?.variants}
            effort={effort}
            onChange={onEffortChange}
          />
          {agents.length > 1 && (
            <AgentPicker
              agents={agents}
              value={agent}
              open={agentOpen}
              onToggle={() => setAgentOpen((v) => !v)}
              onClose={() => setAgentOpen(false)}
              onChange={onAgentChange}
            />
          )}
        </div>
        {todo.total > 0 && (
          <div class="todo-row" title={todo.next}>
            <span class="todo-count">{todo.done}/{todo.total}</span>
            <span class="todo-next">{todo.next}</span>
          </div>
        )}
        {editing && (
          <div class="editing-bar">
            <span>Edit sent message — resending replaces everything after it</span>
            <button class="btn small" onClick={onCancelEdit}>
              Cancel
            </button>
          </div>
        )}
        {draft.startsWith("/") && commands.length > 0 && (
          <div class="cmd-pop" role="listbox" aria-label="Quick actions">
            {filterCommands(commands, draft).map((c) => (
              <button
                key={c.name}
                role="option"
                aria-selected="false"
                class="cmd-item"
                onClick={() => onCommand(c)}
              >
                <span class="cmd-name">/{c.name}</span>
                <span class="cmd-desc">{c.description ?? c.source}</span>
              </button>
            ))}
          </div>
        )}
        <div style="display:flex;gap:8px">
          <button
            class="btn btn-send"
            style="background:var(--bg-raised);color:var(--text)"
            aria-label="Attach files from the phone"
            disabled={sending}
            onClick={() => attachRef.current?.click()}
          >
            <ClipIcon size={20} />
          </button>
          <input
            ref={attachRef}
            type="file"
            multiple
            hidden
            aria-hidden="true"
            tabindex="-1"
            onChange={(e) => {
              onPickFiles([...e.currentTarget.files]);
              e.currentTarget.value = "";
            }}
          />
          <textarea
            aria-label="Enter prompt for the agent"
            rows="1"
            value={draft}
            onInput={(e) => onDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                onSend();
              }
            }}
          />
          {/* Dừng và Gửi cùng hiện lúc agent chạy: ■ dừng lượt, ➤ chèn tin
              mới vào chính lượt đang dở. Trước đây nút gửi biến mất hẳn
              lúc busy nên không gõ xen được gì. */}
          {busy && (
            <button
              class="btn btn-send stop"
              aria-label="Stop the agent"
              title="Stop the agent"
              disabled={aborting}
              onClick={onAbort}
            >
              <StopIcon size={20} />
            </button>
          )}
          <button
            class="btn btn-send"
            aria-label={busy ? "Send now, insert into the running turn" : "Send prompt"}
            title={busy ? "Insert this message into the running turn" : "Send prompt"}
            disabled={(!draft.trim() && !attached.length) || sending}
            onClick={onSend}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m22 2-7 20-4-9-9-4z" />
              <path d="M22 2 11 13" />
            </svg>
          </button>
        </div>
        {attached.length > 0 && (
          <div class="attach-list">
            {attached.map((a, i) => (
              <span class="attach-chip" key={i}>
                <span class="name">{a.file.name}</span>
                <span class="size">
                  {a.status === "uploading" ? "uploading…" : a.status === "error" ? "error" : formatBytes(a.file.size)}
                </span>
                <button aria-label={`Remove ${a.file.name}`} onClick={() => onRemoveAttached(a)}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
      {/* Nút "về tin mới nhất" đặt CUỐI composer (dù hình thức nó nằm bên
          phải, cạnh hàng pill) để thứ tự Tab khớp thứ tự nhìn: người dùng đi
          hết ô gõ mới tới nút, không bị dừng ở một nút vô hình giữa
          chừng. Nó là absolute so với `.composer` nên không đẩy layout. */}
      {showJump && (
        <button
          type="button"
          class="jump-latest"
          onClick={onJump}
          aria-label={unseen > 0 ? `Jump to the latest message — ${unseen} new` : "Jump to the latest message"}
        >
          <ChevronDownIcon size={14} />
          {/* aria-live: số "N tin mới" tăng lên là thông tin duy nhất báo
              cho người đọc bằng screen reader rằng có tin mới — không có nó
              thì nút đổi accessible name mà không ai được báo. */}
          <span aria-live="polite">{jumpLabel(unseen)}</span>
        </button>
      )}
    </div>
  );
}
