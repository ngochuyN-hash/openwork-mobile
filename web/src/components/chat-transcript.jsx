// Phần thân màn chat: thẻ "Agent xin phép" và danh sách tin nhắn (tóm tắt nén,
// thanh tin bị ẩn, bubble, dòng trạng thái). Thuần hiển thị — trạng thái và
// thao tác nằm ở pages/chat.jsx.
import { Empty, Loading } from "./ui.jsx";
import { MessageBubble } from "./chat-message-parts.jsx";
import { ChevronDownIcon, ThoughtIcon } from "./icons.jsx";
import { messageIdOf } from "../lib/session-ops.js";

export function PermissionCard({ permission, busy, onReply }) {
  const p = permission;
  return (
    <div class="permission-card">
      <b>Agent needs permission</b>
      <div style="margin-top:6px" class="mono">
        {p.title ?? p.pattern ?? JSON.stringify(p).slice(0, 160)}
      </div>
      <div class="actions">
        {/* Ba nút khớp đúng ba giá trị engine nhận (`reply`). Trước đây
            gộp còn hai nút và gửi field sai nên thẻ không bao giờ biến mất
            — xem permissionReplyBody trong lib/session-steer. */}
        <button class="btn small" disabled={busy} onClick={() => onReply(p, "once")}>
          Allow
        </button>
        <button class="btn small ghost" disabled={busy} onClick={() => onReply(p, "always")}>
          Always allow
        </button>
        <button class="btn small danger" disabled={busy} onClick={() => onReply(p, "reject")}>
          Deny
        </button>
      </div>
    </div>
  );
}

export function ChatTranscript({
  wsId, messages, visible, hiddenCount, summary, busyAction, onUnrevert, onMenu,
  statusLine, statusBusy, queueCount, onDiscardQueue,
}) {
  return (
    <div class="chat-list">
      {/* Tóm tắt sinh ra lúc nén — mặc định ĐÓNG giống hàng tool/suy luận,
          mở mới đọc, không đẩy tin nhắn xuống dưới màn hình. */}
      {summary && (
        <details class="fold-row reasoning">
          <summary>
            <ThoughtIcon size={14} />
            <span class="fold-title">Session summary</span>
            {summary.truncated && <span class="fold-status">truncated</span>}
            <ChevronDownIcon size={12} />
          </summary>
          <div class="fold-body reasoning-body">{summary.text}</div>
        </details>
      )}
      {hiddenCount > 0 && (
        <div class="revert-bar">
          <span>{hiddenCount} older messages hidden</span>
          <button class="btn small" onClick={onUnrevert} disabled={Boolean(busyAction)}>
            {busyAction === "unrevert" ? "Showing…" : "Show hidden"}
          </button>
        </div>
      )}
      {messages === null && <Loading />}
      {messages?.length === 0 && (
        <Empty title="Empty session" hint="Send the first prompt to the agent." />
      )}
      {visible.length === 0 && messages?.length > 0 && (
        <Empty title="Nothing left to revert" hint="Tap “Show hidden” above to review the hidden messages." />
      )}
      {visible.map((m, i) => (
        <MessageBubble
          key={messageIdOf(m) || `msg-${i}`}
          message={m}
          wsId={wsId}
          onMenu={onMenu}
        />
      ))}
      {/* Dòng trạng thái DUY NHẤT phát ngôn cho screen reader (aria-live):
          trước đây thuộc tính này bọc TOÀN BỘ list tin nhắn — mỗi delta stream
          là đọc lại cả transcript. Vừa làm chỉ báo hàng đợi offline:
          "Đang gửi lại (n)" — hiện duy nhất khi có tin chờ/tác vụ chạy. */}
      <div class="msg assistant chat-status" role="status" aria-live="polite">
        {statusLine && (
          <>
            <span class="spinner" aria-hidden={statusBusy ? undefined : "true"} /> {statusLine}
            {/* Bỏ hàng đợi: mất mạng rồi người dùng gõ nhầm, hoặc đã gửi
                tay trên máy tính — không có đường thoát thì tin sẽ cứ tự
                bay lên máy lúc có mạng. Một chạm, không hộp thoại. */}
            {queueCount > 0 && (
              <button
                type="button"
                class="btn small ghost"
                style={{ marginLeft: 8 }}
                onClick={onDiscardQueue}
                aria-label={`Discard ${queueCount} queued messages`}
              >
                Discard
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
