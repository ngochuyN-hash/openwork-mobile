// Lựa chọn của composer: model, mức suy luận, agent, slash command. Danh sách
// do engine khai nên nạp bất đồng bộ; lựa chọn nhớ trong localStorage phải
// được đối chiếu lại với danh sách vừa nhận.
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ow, owAgents, owCommands } from "../api.js";
import { loadEffort, pushRecentModel } from "../components/model-picker.jsx";
import { isModelUsable, resolveKnownModel } from "../lib/model-behavior.js";

/**
 * @param {{wsId: string, sessionId: string}} args
 *   `sessionId` chỉ để nạp lại khi đổi phiên (giữ nhịp cũ của màn chat).
 */
export function useChatOptions({ wsId, sessionId }) {
  const [models, setModels] = useState([]); // [{value:'provider/model', label, providerName, modelName, modelId}]
  const [modelsLoading, setModelsLoading] = useState(true);
  const [model, setModel] = useState(() => localStorage.getItem("owm_model") ?? "");
  const [effort, setEffort] = useState(loadEffort); // mức suy luận (localStorage)
  const [agents, setAgents] = useState([]);
  const [agent, setAgent] = useState(() => localStorage.getItem("owm_agent") ?? "");
  const [commands, setCommands] = useState([]);

  // Mirror của model: flushQueue chạy trong listener SSE/online đóng từ effect
  // cũ (deps không có model) — đọc state thì gửi tin queue đi với model CŨ.
  const modelRef = useRef(model);
  modelRef.current = model;
  // Agent cũng phải có mirror: flushQueue chạy trong listener SSE cũ, đọc state
  // sẽ gửi tin queue đi bằng agent CŨ.
  const agentRef = useRef(agent);
  agentRef.current = agent;
  // Tương tự: mức suy luận và danh sách model nạp bất đồng bộ — gửi tin phải
  // theo mức/model ĐANG CHỌN, không phải bản chụp lúc effect chạy.
  const effortRef = useRef(effort);
  effortRef.current = effort;
  const modelsRef = useRef(models);
  modelsRef.current = models;

  useEffect(() => {
    const base = `/workspace/${encodeURIComponent(wsId)}/opencode`;
    // Agent + slash command: nạp một lần, rẻ và cần cho composer.
    owAgents(wsId)
      .then((list) => {
        const usable = list.filter((a) => a?.name && a.hidden !== true);
        setAgents(usable);
        // Agent đang chọn (hoặc bản nhớ lần trước) phải còn trong danh sách
        // engine vừa trả. Engine đã xoá thì bỏ hẳn — kể cả localStorage vẫn
        // nhớ tên đó: gửi agent ma lên chỉ nhận lỗi từ engine.
        const wanted = agentRef.current || localStorage.getItem("owm_agent") || "";
        if (!wanted) return;
        if (usable.some((a) => a.name === wanted)) {
          setAgent(wanted); // khôi phục lựa chọn lần trước khi state còn trắng
        } else {
          localStorage.removeItem("owm_agent");
          setAgent("");
        }
      })
      .catch(() => setAgents([]));
    owCommands(wsId).then(setCommands).catch(() => setCommands([]));

    // Model picker: engine yêu cầu model tường minh khi gửi prompt, không có
    // thì message treo vĩnh viễn.
    ow(`${base}/config/providers`)
      .then((payload) => {
        const providers = payload?.providers ?? payload?.data?.providers ?? [];
        const flat = [];
        for (const p of providers) {
          for (const m of Object.values(p.models ?? {})) {
            flat.push({
              value: `${p.id}/${m.id}`,
              label: `${p.name} · ${m.name ?? m.id}`,
              providerName: p.name ?? p.id,
              modelName: m.name ?? m.id,
              modelId: m.id,
              // Danh sách mức suy luận engine khai cho model này. Giữ nguyên
              // shape engine trả; lib/model-behavior bóc ra và KHÔNG bịa thêm
              // mức nào không có trong đây.
              variants: m.variants,
            });
          }
        }
        setModels(flat);
        // Model nhớ trong localStorage có thể đã bị engine đổi tên/xoá — giữ
        // thì mọi tin gửi đi đều im lặng không phản hồi. Chọn lại trong danh
        // sách vừa nhận, và xoá key để lần sau không phải dò lại.
        const kept = resolveKnownModel(modelRef.current, flat);
        if (kept !== modelRef.current) {
          localStorage.setItem("owm_model", kept);
          setModel(kept);
        } else if (!localStorage.getItem("owm_model") && flat.length) {
          localStorage.setItem("owm_model", kept);
          setModel(kept);
        }
      })
      .catch(() => {})
      .finally(() => setModelsLoading(false));
  }, [wsId, sessionId]);

  const changeModel = useCallback((value) => {
    setModel(value);
    localStorage.setItem("owm_model", value);
    pushRecentModel(value);
  }, []);

  const changeAgent = useCallback((name) => {
    setAgent(name);
    if (name) localStorage.setItem("owm_agent", name);
    else localStorage.removeItem("owm_agent");
  }, []);

  /**
   * Tham số gửi prompt, đọc qua ref chứ không đọc state: hàm này chạy cả
   * trong flushQueue — listener đóng từ effect setup lúc mount, state mới
   * không chạm tới được (đọc state ở đây là gửi tin bằng model/mức CŨ).
   *
   * `variants` lấy theo model ĐANG chọn trong catalog: mức suy luận chỉ gửi
   * được với variant engine thật sự khai cho model đó (lib/model-behavior).
   */
  const promptArgs = useCallback((text) => {
    const value = modelRef.current;
    const current = modelsRef.current.find((m) => m.value === value);
    return {
      text,
      model: value,
      agent: agentRef.current,
      effort: effortRef.current,
      variants: current?.variants,
    };
  }, []);

  /** Model đang chọn còn nằm trong danh sách engine khai không (đọc qua ref). */
  const modelUsable = useCallback(() => isModelUsable(modelRef.current, modelsRef.current), []);

  return {
    models, modelsLoading, model, changeModel,
    effort, setEffort,
    agents, agent, changeAgent,
    commands,
    promptArgs, modelUsable,
  };
}
