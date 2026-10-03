// Reducer stream chat — logic THUẦN, tách khỏi chat.jsx để test được
// (học desktop: session-sync là module thuần với hook __applyEventForTest).
//
// Protocol engine opencode (đọc từ source desktop apps/app session-sync.ts):
//  - message.part.updated: properties.part = snapshot CỘNG DỒN của một part
//    (chìa part.id) — upsert thay thế.
//  - message.part.delta:   properties.{partID,delta} = miếng chữ tăng dần của
//    part đó — gom vào buffer, caller flush theo frame (không render từng ký tự).
//  - message.updated:      properties.message = snapshot cả message.
//  - message.removed:      properties.messageID = message bị xoá/revert.
//
// Quy tắc chống nhân đôi bytes: buffer delta và snapshot là hai góc nhìn cộng
// dồn của cùng một stream — khi part.updated khai báo part, lấy cái DÀI HƠN
// chứ không nối.

/** Tìm chỉ số message theo id (shape engine: {info:{id},...} hoặc phẳng). */
function findMsgIndex(list, messageId) {
  return list.findIndex((m) => (m.info?.id ?? m.id) === messageId);
}

/** Reducer stream cho 1 trang chat. `prev` là mảng messages hiện tại. */
export function createChatStream() {
  const pendingDelta = new Map();

  /** Delta tới trước snapshot (part chưa khai báo) — giữ chờ seed. */
  function queueDelta(partId, delta) {
    pendingDelta.set(partId, (pendingDelta.get(partId) ?? "") + delta);
  }

  /** part.updated: nhét snapshot cộng dồn theo part.id. Trả list mới. */
  function applyPartSnapshot(list, messageId, part) {
    if (!messageId || !part?.id) return { list, applied: false };
    const next = [...list];
    let idx = findMsgIndex(next, messageId);
    if (idx < 0) {
      // Part mới của message mới — stub assistant; role thật sẽ tới theo
      // message.updated (desktop: inferStubRole).
      next.push({ info: { id: messageId, role: "assistant" }, parts: [] });
      idx = next.length - 1;
    }
    const msg = next[idx];
    const parts = [...(msg.parts ?? [])];
    const pi = parts.findIndex((p) => p?.id === part.id);
    const buffered = pendingDelta.get(part.id) ?? "";
    const base = typeof part.text === "string" ? part.text : "";
    const text = base.length >= buffered.length ? base : buffered;
    pendingDelta.delete(part.id);
    const merged = { ...(pi >= 0 ? parts[pi] : {}), ...part, text };
    if (pi >= 0) parts[pi] = merged;
    else parts.push(merged);
    next[idx] = { ...msg, parts };
    return { list: next, applied: true };
  }

  /** Heuristic nối chữ — fallback part không có id (engine cũ/bản lạ). */
  function applyTextPatch(list, messageId, chunk) {
    if (!chunk) return list;
    const next = [...list];
    let idx = messageId ? findMsgIndex(next, messageId) : -1;
    if (idx < 0) {
      for (let i = next.length - 1; i >= 0; i--) {
        if ((next[i].info?.role ?? next[i].role) === "assistant") {
          idx = i;
          break;
        }
      }
    }
    if (idx < 0) {
      next.push({
        info: { id: messageId || "stream", role: "assistant" },
        parts: [{ type: "text", text: chunk }],
      });
      return next;
    }
    const msg = { ...next[idx], parts: [...(next[idx].parts ?? [])] };
    let pIdx = -1;
    for (let i = msg.parts.length - 1; i >= 0; i--) {
      if (msg.parts[i]?.type === "text") {
        pIdx = i;
        break;
      }
    }
    if (pIdx < 0) {
      msg.parts = [...msg.parts, { type: "text", text: chunk }];
    } else {
      const cur = msg.parts[pIdx]?.text ?? "";
      let text;
      if (!cur) text = chunk;
      else if (chunk.startsWith(cur)) text = chunk; // snapshot full
      else if (cur.endsWith(chunk)) text = cur; // event phát lại đuôi cũ
      else text = cur + chunk; // delta
      msg.parts[pIdx] = { ...msg.parts[pIdx], text };
    }
    next[idx] = msg;
    return next;
  }

  /** message.updated: upsert nguyên message (info + parts). */
  function applyMessageSnapshot(list, messageId, info, parts) {
    if (!messageId) return list;
    const next = [...list];
    const idx = findMsgIndex(next, messageId);
    const clean = Array.isArray(parts) ? parts.filter(Boolean) : [];
    if (idx < 0) {
      next.push({ info: info ?? { id: messageId, role: "assistant" }, parts: clean });
      return next;
    }
    // Parts rỗng không đè phần đang stream — info thì cứ cập nhật.
    next[idx] = {
      ...next[idx],
      info: info ?? next[idx].info,
      parts: clean.length ? clean : next[idx].parts,
    };
    return next;
  }

  /** Áp 1 event (đã lọc session ở caller). Trả chính `prev` nếu không đổi —
   * caller dùng điều đó để bỏ qua render. */
  function apply(prev, data) {
    if (!data || typeof data !== "object") return prev;
    const type = data.type;
    const props = data.properties && typeof data.properties === "object" ? data.properties : data;
    if (type === "message.part.updated") {
      const part = props.part && typeof props.part === "object" ? props.part : props;
      const messageId =
        props.messageID ?? props.messageId ?? data.messageID ?? part?.messageID ?? "";
      const { list, applied } = applyPartSnapshot(prev, messageId, part);
      if (!applied) {
        // Part không có id — heuristic nối chữ.
        const chunk =
          (typeof part?.text === "string" && part.text) ||
          (typeof props?.delta === "string" && props.delta) ||
          "";
        return applyTextPatch(prev, messageId, chunk);
      }
      return list;
    }
    if (type === "message.part.delta") {
      const partId = props.partID ?? props.partId ?? props.id;
      const delta = typeof props.delta === "string" ? props.delta : "";
      if (partId && delta) queueDelta(partId, delta);
      return prev; // buffer — render khi flush
    }
    if (type === "message.updated") {
      const message = data.message ?? props.message ?? null;
      if (!message) return prev;
      const id = message.id ?? message.info?.id ?? "";
      return applyMessageSnapshot(prev, id, message.info, message.parts);
    }
    if (type === "message.removed") {
      const messageId = props.messageID ?? props.messageId ?? props.id;
      if (!messageId) return prev;
      return prev.filter((m) => (m.info?.id ?? m.id) !== messageId);
    }
    return prev;
  }

  /** Đổ buffer vào các part ĐÃ khai báo (gọi theo frame). Part chưa khai báo
   * giữ trong buffer đợi seed từ part.updated. */
  function flush(prev) {
    if (!pendingDelta.size || !prev) return prev;
    const list = prev.map((msg) => {
      let parts = null;
      (msg.parts ?? []).forEach((p, i) => {
        if (!p?.id) return;
        const add = pendingDelta.get(p.id);
        if (!add) return;
        if (!parts) parts = [...msg.parts];
        parts[i] = { ...p, text: (p.text ?? "") + add };
      });
      return parts ? { ...msg, parts } : msg;
    });
    const declared = new Set();
    for (const msg of prev) for (const p of msg.parts ?? []) if (p?.id) declared.add(p.id);
    for (const [partId] of [...pendingDelta]) {
      if (declared.has(partId)) pendingDelta.delete(partId);
    }
    return list;
  }

  return {
    apply,
    flush,
    hasPending: () => pendingDelta.size > 0,
    reset: () => pendingDelta.clear(),
  };
}

/** Refetch full transcript giữa chừng run: API chỉ ghi nhận message ĐÃ xong
 * nên `fetched` thiếu message đang stream — thay nguyên list là trang co cụm,
 * scroll bị trình duyệt kẹp ngược lên (bug "cuộn xuống tự cuộn lên"). Giữ lại
 * message cục bộ mà fetched chưa có, đè lên vị trí cuối (message mới nhất). */
export function mergeRefetchKeepInflight(fetched, prev) {
  const list = Array.isArray(fetched) ? fetched : [];
  if (!Array.isArray(prev) || !prev.length) return list;
  const ids = new Set(list.map((m) => m.info?.id ?? m.id));
  const inflight = prev.filter((m) => !ids.has(m.info?.id ?? m.id));
  return inflight.length ? [...list, ...inflight] : list;
}
