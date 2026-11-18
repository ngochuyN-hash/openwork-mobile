// Adapter engine v2 (OpenCode 2.x): dịch shape API + SSE của v2 về đúng shape
// v1 mà toàn bộ UI đang dùng (`{info, parts}`, `message.part.updated`,
// `permission.updated`, `session.idle`…).
//
// Vì sao có lớp này: màn chat/sessions/home/search đã viết quanh shape v1
// (hàng trăm dòng JSX, 30 file test). Đổi engine thì sửa seam hẹp nhất — file
// transport (api.js) và bộ dịch event — thay vì viết lại từng trang.
//
// Khác biệt v2 phải bù:
//  - list trả `{data:[...], cursor:{previous,next}}` và PHÂN TRANG MẶC ĐỊNH;
//  - message là `{type:"user"|"assistant"|..., content:[...]}`, không phải
//    `{info, parts}`; có thêm row không phải tin (model-switched, idle…);
//  - tool part tên `shell` chứ không phải `bash`, state là
//    streaming/running/completed/error với `content:[{type:"text"}]`;
//  - KHÔNG có `message.*` event, KHÔNG có `session.idle`/`session.status`
//    trong một lượt bình thường — phải tự dựng từ text/reasoning/tool/execution;
//  - câu hỏi của agent là "form" do hệ thống đăng ký, không phải question.

export const V2_SEGMENT = "opencode2";

/** Path proxy tới engine v2 của 1 workspace (bridge whitelist `opencode2?`). */
export function v2Path(wsId, path) {
  return `/workspace/${encodeURIComponent(wsId)}/${V2_SEGMENT}${path}`;
}

/** Mốc trang kế của list v2 (`cursor.next`), "" khi hết. */
export function nextCursorOf(payload) {
  const next = payload?.cursor?.next;
  return typeof next === "string" ? next : "";
}

/** List v2 -> mảng item (chấp nhận cả `{data:[...]}` và `{data:{items}}`). */
export function dataItems(payload) {
  const data = payload?.data ?? payload;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

// ---- session / status -----------------------------------------------------

/** Session.Info v2 -> shape v1 (giữ nguyên field, chỉ bảo đảm `time`). */
export function toV1Session(session) {
  if (!session || typeof session !== "object") return null;
  const created = Number(session.time?.created ?? 0) || 0;
  const updated = Number(session.time?.updated ?? created) || created;
  return {
    ...session,
    id: String(session.id ?? ""),
    title: typeof session.title === "string" ? session.title : "",
    time: { ...(session.time ?? {}), created, updated },
  };
}

export function toV1Sessions(payload) {
  return dataItems(payload).map(toV1Session).filter(Boolean);
}

/**
 * `/api/session/active` -> map `{sid: {type}}` như `/session/status` của v1.
 * v2 chỉ liệt kê phiên ĐANG chạy nên vắng mặt = rảnh (sessionBusyFromMap đọc
 * đúng quy ước đó).
 */
export function toV1Status(payload) {
  const map = payload?.data ?? payload;
  const out = {};
  if (!map || typeof map !== "object" || Array.isArray(map)) return out;
  for (const [sid, value] of Object.entries(map)) {
    const type = String(value?.type ?? "").toLowerCase();
    if (!type) continue;
    out[sid] = { type: type === "running" ? "busy" : type };
  }
  return out;
}

// ---- message / part -------------------------------------------------------

// Row v2 không phải tin nhắn — bỏ khỏi transcript.
const NON_MESSAGE_TYPES = new Set([
  "agent-switched",
  "model-switched",
  "location-switched",
  "idle",
  "compaction",
  "synthetic",
  "system",
  "skill",
  "shell",
]);

const TOOL_ALIASES = { shell: "bash" };

/** Tên tool v2 -> tên v1 (UI map nhãn/hàng tool theo tên v1). */
export function toolNameV1(name) {
  const raw = String(name ?? "");
  return TOOL_ALIASES[raw] ?? raw;
}

function textOfContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** Session.Message.ToolState v2 -> state v1 `{status, input, output, metadata}`. */
export function toolStateV1(state) {
  const status = String(state?.status ?? "");
  const metadata = asObject(state?.metadata);
  if (status === "streaming") {
    // Model còn đang phát tham số: chưa có input dùng được.
    return { status: "pending", input: {}, metadata };
  }
  if (status === "running") {
    return { status: "running", input: asObject(state?.input), metadata };
  }
  if (status === "error") {
    return {
      status: "error",
      input: asObject(state?.input),
      output: textOfContent(state?.content),
      error: state?.error,
      metadata,
    };
  }
  return {
    status: "completed",
    input: asObject(state?.input),
    output: textOfContent(state?.content),
    metadata,
  };
}

/**
 * content[] của 1 assistant message v2 -> parts[] v1.
 *
 * Id part phải TRÙNG với id mà bộ dịch stream tự dựng (`${mid}#t0`, `${mid}#r0`,
 * `${mid}#k<callID>`) để lúc refetch chốt transcript không nhấp nháy/không
 * nhân đôi part.
 */
export function toV1Parts(content, messageID) {
  const mid = String(messageID ?? "msg");
  const parts = [];
  let textN = 0;
  let reasonN = 0;
  for (const item of Array.isArray(content) ? content : []) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "text") {
      parts.push({ id: `${mid}#t${textN}`, type: "text", text: String(item.text ?? "") });
      textN += 1;
      continue;
    }
    if (item.type === "reasoning") {
      parts.push({
        id: `${mid}#r${reasonN}`,
        type: "reasoning",
        text: String(item.text ?? ""),
        state: { status: "completed" },
      });
      reasonN += 1;
      continue;
    }
    if (item.type === "tool") {
      parts.push({
        id: toolPartId(mid, item.id),
        type: "tool",
        tool: toolNameV1(item.name),
        state: toolStateV1(item.state),
        time: item.time,
      });
    }
  }
  return parts;
}

function toolPartId(messageID, callID) {
  return `${messageID}#k${String(callID ?? "")}`;
}

/** Một row message v2 -> `{info, parts}` v1, hoặc null nếu không phải tin. */
export function toV1Message(row) {
  if (!row || typeof row !== "object") return null;
  const type = String(row.type ?? "");
  if (NON_MESSAGE_TYPES.has(type)) return null;
  const id = String(row.id ?? "");
  if (!id) return null;
  if (type === "user") {
    const text = String(row.text ?? "");
    return {
      info: { id, role: "user", time: row.time ?? {}, localSentText: text },
      parts: text ? [{ id: `${id}#t0`, type: "text", text }] : [],
    };
  }
  if (type !== "assistant") return null;
  const info = {
    id,
    role: "assistant",
    time: row.time ?? {},
    agent: row.agent,
    model: row.model,
    cost: row.cost,
    tokens: row.tokens,
    finish: row.finish,
  };
  // v2 để lỗi ở `error` (StructuredError `{_tag, message}`); UI đọc
  // `info.error` (lib/session-ops messageErrorOf).
  if (row.error) info.error = row.error;
  return { info, parts: toV1Parts(row.content, id) };
}

export function toV1Messages(payload) {
  return dataItems(payload).map(toV1Message).filter(Boolean);
}

// ---- provider / model -----------------------------------------------------

/**
 * `/api/provider` + `/api/model` -> `{providers:[{id,name,models:{}}]}` đúng
 * shape `/config/providers` v1 để `flattenProviderModels` không phải đổi.
 * Chỉ nhận model chat: danh sách còn có model "decision"/"embedding" không
 * gửi prompt được.
 */
export function toV1Providers(providers, models) {
  const list = Array.isArray(providers) ? providers : dataItems(providers);
  const out = [];
  const byId = new Map();
  const add = (p) => {
    const id = String(p?.id ?? "");
    if (!id) return null;
    const known = byId.get(id);
    if (known) return known;
    const entry = { id, name: String(p?.name ?? id), models: {} };
    byId.set(id, entry);
    out.push(entry);
    return entry;
  };
  list.forEach(add);
  for (const model of Array.isArray(models) ? models : dataItems(models)) {
    const providerID = String(model?.providerID ?? "");
    const modelID = String(model?.modelID ?? model?.id ?? "");
    if (!providerID || !modelID) continue;
    const kind = String(model?.type ?? "chat");
    if (kind && kind !== "chat") continue;
    const provider = add({ id: providerID, name: providerID });
    if (!provider) continue;
    provider.models[modelID] = {
      id: modelID,
      name: String(model?.name ?? modelID),
      variants: model?.variants,
    };
  }
  return { providers: out };
}

// ---- form (câu hỏi của agent) ---------------------------------------------

/** Form.Info v2 -> QuestionRequest v1 (kèm `form` gốc để dựng câu trả lời). */
export function toV1Form(form) {
  if (!form || typeof form !== "object") return null;
  const fields = (Array.isArray(form.fields) ? form.fields : []).filter(
    (f) => f && typeof f === "object" && !f.hidden
  );
  return {
    id: String(form.id ?? ""),
    sessionID: String(form.sessionID ?? ""),
    title: String(form.title ?? ""),
    form,
    questions: fields.map((field) => ({
      key: String(field.key ?? ""),
      header: String(field.title ?? field.key ?? ""),
      question: String(field.title || field.description || field.key || ""),
      multiple: field.type === "multiselect",
      custom: Boolean(field.custom),
      options: (Array.isArray(field.options) ? field.options : []).map((o) => ({
        label: String(o?.label ?? o?.value ?? ""),
        description: String(o?.description ?? ""),
      })),
    })),
  };
}

export function toV1Forms(payload) {
  return dataItems(payload).map(toV1Form).filter(Boolean);
}

function optionValueOf(field, label) {
  const raw = String(label ?? "").trim();
  if (!raw) return "";
  const options = Array.isArray(field?.options) ? field.options : [];
  const byLabel = options.find((o) => String(o?.label ?? "") === raw);
  if (byLabel) return String(byLabel.value ?? raw);
  const byValue = options.find((o) => String(o?.value ?? "") === raw);
  if (byValue) return String(byValue.value ?? raw);
  return raw; // chữ tự nhập
}

/**
 * Nhãn người dùng chọn (mảng theo thứ tự field) -> `{answer:{key:value}}`
 * đúng `Form.Reply` của v2, có ép kiểu theo `type` của field.
 */
export function formAnswerOf(form, selections) {
  const fields = (Array.isArray(form?.fields) ? form.fields : []).filter(
    (f) => f && typeof f === "object" && !f.hidden
  );
  const answer = {};
  const picks = Array.isArray(selections) ? selections : [];
  fields.forEach((field, i) => {
    const chosen = (Array.isArray(picks[i]) ? picks[i] : [picks[i]]).filter(
      (v) => v !== undefined && v !== null && String(v).trim() !== ""
    );
    const key = String(field.key ?? "");
    if (!key) return;
    const type = String(field.type ?? "string");
    if (type === "multiselect") {
      answer[key] = chosen.map((label) => optionValueOf(field, label));
      return;
    }
    const first = chosen.length ? optionValueOf(field, chosen[0]) : "";
    if (type === "number" || type === "integer") {
      const num = Number(first);
      if (first !== "" && Number.isFinite(num)) answer[key] = num;
      return;
    }
    if (type === "boolean") {
      const text = String(first).toLowerCase();
      if (["true", "yes", "y", "1", "on"].includes(text)) answer[key] = true;
      else if (["false", "no", "n", "0", "off"].includes(text)) answer[key] = false;
      return;
    }
    if (first !== "") answer[key] = first;
  });
  return { answer };
}

// ---- permission -----------------------------------------------------------

/** Permission request v2 -> shape thẻ permission của v1 (UI cần `title`). */
export function toV1Permission(request) {
  if (!request || typeof request !== "object") return null;
  const id = String(request.id ?? "");
  if (!id) return null;
  const resources = Array.isArray(request.resources) ? request.resources : [];
  const title =
    String(request.message ?? "").trim() ||
    [String(request.action ?? ""), resources.join(", ")].filter(Boolean).join(" · ") ||
    id;
  return {
    id,
    sessionID: String(request.sessionID ?? ""),
    title,
    action: request.action,
    resources,
    save: request.save,
    metadata: request.metadata,
    source: request.source,
    message: request.message,
  };
}

export function toV1Permissions(payload) {
  return dataItems(payload).map(toV1Permission).filter(Boolean);
}

/** `/api/agent` -> danh sách agent v1 (`/agent` trả `[{name, description}]`). */
export function toV1Agents(payload) {
  return dataItems(payload)
    .filter((a) => a && typeof a === "object" && a.hidden !== true)
    .map((a) => ({
      name: String(a.name ?? ""),
      description: String(a.description ?? ""),
      mode: String(a.mode ?? "primary"),
    }))
    .filter((a) => a.name);
}

// ---- SSE: event v2 -> event v1 ------------------------------------------

// Cache cộng dồn cho tool: v2 phát từng bước (input.started → called →
// progress → success), còn `part.updated` của v1 là SNAPSHOT, nên phải nhớ
// input/status đã biết mới dựng lại được state đầy đủ ở mỗi bước.
const toolCache = new Map();

function toolCacheKey(messageID, callID) {
  return `${messageID}|${callID}`;
}

function toolPartOf(entry, state) {
  return {
    id: toolPartId(entry.messageID, entry.callID),
    type: "tool",
    tool: toolNameV1(entry.name),
    state,
    time: { created: entry.created },
  };
}

function textPartId(messageID, ordinal) {
  return `${messageID}#t${ordinal}`;
}

function reasoningPartId(messageID, ordinal) {
  return `${messageID}#r${ordinal}`;
}

function asEvent(name, sessionID, extra) {
  return { name, data: { type: name, sessionID, ...extra } };
}

/**
 * Một envelope SSE v2 -> mảng event v1 `{name, data}` (data.type = tên v1).
 *
 * `data` để field PHẲNG (không bọc `properties`) vì lib/chat-stream đọc
 * `data.properties ?? data` — phẳng là đường ngắn nhất mà vẫn đúng.
 */
export function translateV2Events(envelope) {
  if (!envelope || typeof envelope !== "object") return [];
  const type = String(envelope.type ?? "");
  const d = envelope.data && typeof envelope.data === "object" ? envelope.data : {};
  const created = Number(envelope.created ?? 0) || Date.now();
  // `form.created` không mang sessionID ở cấp envelope — nó nằm trong
  // `data.form` (Form.Info). Thiếu bước này thì event thành "chung" và router
  // của phiên nào cũng nhận (chat-events.sameSession coi sid rỗng là hợp lệ).
  const sid = String(d.sessionID ?? d.form?.sessionID ?? "");
  const mid = String(d.assistantMessageID ?? "");

  switch (type) {
    // ---- tin người dùng vừa vào hàng đợi ------------------------------
    case "session.inbox.enqueued": {
      const inboxID = String(d.inboxID ?? "");
      const text = String(d.item?.payload?.text ?? "");
      if (!inboxID) return [];
      return [
        asEvent("message.updated", sid, {
          message: {
            id: inboxID,
            info: {
              id: inboxID,
              role: "user",
              time: { created: Number(d.item?.time?.created ?? created) },
              localSentText: text,
            },
            parts: text ? [{ id: `${inboxID}#t0`, type: "text", text }] : [],
          },
        }),
      ];
    }

    // ---- chữ của assistant -------------------------------------------
    case "session.text.started":
      return [
        asEvent("message.part.updated", sid, {
          messageID: mid,
          part: { id: textPartId(mid, d.ordinal), type: "text", text: "" },
        }),
      ];
    case "session.text.delta":
      return [
        asEvent("message.part.delta", sid, {
          partID: textPartId(mid, d.ordinal),
          delta: String(d.delta ?? ""),
        }),
      ];
    case "session.text.ended":
      return [
        asEvent("message.part.updated", sid, {
          messageID: mid,
          part: { id: textPartId(mid, d.ordinal), type: "text", text: String(d.text ?? "") },
        }),
      ];

    // ---- suy luận -----------------------------------------------------
    case "session.reasoning.started":
      return [
        asEvent("message.part.updated", sid, {
          messageID: mid,
          part: {
            id: reasoningPartId(mid, d.ordinal),
            type: "reasoning",
            text: "",
            state: { status: "streaming" },
          },
        }),
      ];
    case "session.reasoning.delta":
      return [
        asEvent("message.part.delta", sid, {
          partID: reasoningPartId(mid, d.ordinal),
          delta: String(d.delta ?? ""),
        }),
      ];
    case "session.reasoning.ended":
      return [
        asEvent("message.part.updated", sid, {
          messageID: mid,
          part: {
            id: reasoningPartId(mid, d.ordinal),
            type: "reasoning",
            text: String(d.text ?? ""),
            state: { status: "completed" },
          },
        }),
      ];

    // ---- tool ---------------------------------------------------------
    case "session.tool.input.started": {
      const key = toolCacheKey(mid, d.id);
      const entry = {
        messageID: mid,
        callID: String(d.id ?? ""),
        name: String(d.name ?? ""),
        created,
        input: {},
        raw: "",
        metadata: {},
        status: "pending",
        content: [],
        error: undefined,
      };
      toolCache.set(key, entry);
      return [
        asEvent("message.part.updated", sid, {
          messageID: mid,
          part: toolPartOf(entry, { status: "pending", input: {}, metadata: {} }),
        }),
      ];
    }
    case "session.tool.input.ended":
    case "session.tool.input.delta": {
      const entry = toolCache.get(toolCacheKey(mid, d.id));
      if (!entry) return [];
      const chunk = String(d.text ?? d.delta ?? "");
      entry.raw = type.endsWith("delta") ? entry.raw + chunk : chunk;
      return [];
    }
    case "session.tool.called": {
      const key = toolCacheKey(mid, d.id);
      const entry = toolCache.get(key) ?? {
        messageID: mid,
        callID: String(d.id ?? ""),
        name: String(d.name ?? ""),
        created,
        raw: "",
        metadata: {},
        status: "pending",
        content: [],
      };
      entry.input = asObject(d.input);
      entry.status = "running";
      toolCache.set(key, entry);
      return [
        asEvent("message.part.updated", sid, {
          messageID: mid,
          part: toolPartOf(entry, { status: "running", input: entry.input, metadata: entry.metadata }),
        }),
      ];
    }
    case "session.tool.progress": {
      const key = toolCacheKey(mid, d.id);
      const entry = toolCache.get(key);
      if (!entry) return [];
      entry.metadata = { ...entry.metadata, ...asObject(d.metadata) };
      entry.status = "running";
      return [
        asEvent("message.part.updated", sid, {
          messageID: mid,
          part: toolPartOf(entry, { status: "running", input: entry.input, metadata: entry.metadata }),
        }),
      ];
    }
    case "session.tool.success":
    case "session.tool.failed": {
      const key = toolCacheKey(mid, d.id);
      const entry = toolCache.get(key) ?? {
        messageID: mid,
        callID: String(d.id ?? ""),
        name: String(d.name ?? ""),
        created,
        input: {},
        raw: "",
        metadata: {},
        content: [],
      };
      const failed = type.endsWith("failed");
      entry.metadata = { ...entry.metadata, ...asObject(d.metadata) };
      entry.content = Array.isArray(d.content) ? d.content : entry.content;
      entry.status = failed ? "error" : "completed";
      entry.error = failed ? d.error : undefined;
      const state = failed
        ? {
            status: "error",
            input: entry.input,
            output: textOfContent(entry.content),
            error: entry.error,
            metadata: entry.metadata,
          }
        : {
            status: "completed",
            input: entry.input,
            output: textOfContent(entry.content),
            metadata: entry.metadata,
          };
      toolCache.delete(key);
      return [asEvent("message.part.updated", sid, { messageID: mid, part: toolPartOf(entry, state) })];
    }

    // ---- vòng chạy: v2 KHÔNG phát idle/status, tự dựng -----------------
    case "session.execution.started":
      return [asEvent("session.status", sid, { properties: { [sid]: { type: "busy" } } })];
    case "session.execution.succeeded":
    case "session.execution.interrupted":
      return [asEvent("session.idle", sid, {})];
    case "session.execution.failed":
      return [
        asEvent("session.errored", sid, {
          error: d.error ?? null,
        }),
      ];

    // ---- permission + form -------------------------------------------
    case "permission.asked":
      return [asEvent("permission.updated", sid, { properties: { ...d } })];
    case "permission.replied":
      return [asEvent("permission.updated", sid, { properties: { ...d } })];
    case "form.created":
    case "form.replied":
    case "form.cancelled":
      return [asEvent("permission.updated", sid, { properties: { ...d } })];

    default:
      return [];
  }
}

/** Test seam: xoá cache tool giữa các bài. */
export function resetEventCache() {
  toolCache.clear();
}
