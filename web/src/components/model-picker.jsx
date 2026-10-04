// Model picker kiểu desktop OpenWork (domains/models/model-picker-list):
// danh sách NHÓM (Gần đây → từng provider, sort tên) + ô search + check
// lựa chọn — thay cho <select> phẳng. Mobile = bottom sheet tái dùng
// .sheet-backdrop/.sheet của dự án; item ≥44px, input 16px (pwa-workspace-ui).
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "./icons.jsx";
import {
  EFFORT_NONE,
  effortLabelVi,
  effortOptionsFor,
  fastModeEffort,
  normalizeEffort,
  parseModelValue,
  resolveEffort,
} from "../lib/model-behavior.js";

const RECENT_KEY = "owm_model_recent";
const RECENT_MAX = 4;
// Mức suy luận nhớ theo máy (đọc/ghi ở đây, logic thuần nằm lib/model-behavior).
const EFFORT_KEY = "owm_effort";

/** Lưu model vừa chọn vào danh sách Gần đây (mỗi lần đổi model mới lưu). */
export function pushRecentModel(value) {
  if (!value) return;
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    const next = [value, ...list.filter((v) => v !== value)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {}
}

export function ModelPicker({ models, value, onChange, loading }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef(null);
  const current = models.find((m) => m.value === value);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const t = setTimeout(() => inputRef.current?.focus(), 90);
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (m) => !q || `${m.label} ${m.value}`.toLowerCase().includes(q);
    const out = [];
    const push = (name, items) => {
      if (items.length) out.push({ name, items });
    };
    // Gần đây chỉ hiện khi KHÔNG gõ — khi tìm kiếm thì toàn danh sách mới.
    if (!q) {
      let recents = [];
      try {
        recents = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
      } catch {}
      const seen = new Set();
      push(
        "Gần đây",
        recents
          .map((v) => models.find((m) => m.value === v))
          .filter((m) => m && !seen.has(m.value) && seen.add(m.value))
          .slice(0, RECENT_MAX)
      );
    }
    const byProvider = new Map();
    for (const m of models) {
      if (!match(m)) continue;
      if (!byProvider.has(m.providerName)) byProvider.set(m.providerName, []);
      byProvider.get(m.providerName).push(m);
    }
    for (const name of [...byProvider.keys()].sort((a, b) => a.localeCompare(b))) {
      push(name, byProvider.get(name));
    }
    return out;
    // `open` để tính lại Gần đây mỗi lần mở sheet.
  }, [models, query, open]);

  return (
    <>
      <button
        class="model-pill"
        type="button"
        aria-haspopup="dialog"
        aria-label={`Model đang dùng: ${current?.label ?? "đang tải"}. Bấm để chọn model khác`}
        onClick={() => setOpen(true)}
      >
        <span class="model-pill-label">{current ? current.label : loading ? "Đang tải model…" : "Mặc định"}</span>
        <ChevronDownIcon size={14} />
      </button>

      {open && (
        <div class="sheet-backdrop" onClick={() => setOpen(false)}>
          <div class="card sheet model-sheet" role="dialog" aria-modal="true" aria-label="Chọn model" onClick={(e) => e.stopPropagation()}>
            <div class="sheet-grabber" />
            <div class="model-search">
              <SearchIcon size={16} />
              <input
                ref={inputRef}
                type="search"
                placeholder="Tìm model…"
                aria-label="Tìm model"
                value={query}
                onInput={(e) => setQuery(e.currentTarget.value)}
              />
            </div>
            <div class="model-list" role="listbox" aria-label="Danh sách model">
              {loading &&
                [0, 1, 2].map((i) => (
                  <div class="model-option" key={i} aria-hidden="true">
                    <span class="sk" style="height:13px;width:56%" />
                    <span class="sk" style="height:10px;width:34%" />
                  </div>
                ))}
              {!loading && groups.length === 0 && (
                <p class="model-empty">Không có model nào khớp “{query}”.</p>
              )}
              {groups.map((g) => (
                <div key={g.name} role="presentation">
                  <div class="model-group">{g.name}</div>
                  {g.items.map((m) => {
                    const selected = m.value === value;
                    return (
                      <button
                        key={m.value}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        class={`model-option${selected ? " selected" : ""}`}
                        onClick={() => {
                          onChange(m.value);
                          pushRecentModel(m.value);
                          setOpen(false);
                        }}
                      >
                        <span class="model-option-text">
                          <span class="model-option-name">{m.modelName || m.label}</span>
                          <span class="model-option-sub">{m.providerName} · {m.modelId}</span>
                        </span>
                        {selected && <CheckIcon size={18} />}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ---- Mức suy luận + chế độ nhanh ----
// Toàn bộ quy tắc (variant vs reasoning_effort, chế nào hợp lệ) nằm ở
// lib/model-behavior.js — ở đây chỉ dựng nút và lưu lựa chọn. Model nào không
// có variant nào thì ẩn hẳn: có nút mà bấm xong chẳng đổi gì thì hỏng trải nghiệm.

/** Đọc mức suy luận đã nhớ (mặc định = để engine tự quyết). */
export function loadEffort() {
  try {
    return normalizeEffort(localStorage.getItem(EFFORT_KEY) ?? "");
  } catch {
    return EFFORT_NONE;
  }
}

export function saveEffort(effort) {
  try {
    localStorage.setItem(EFFORT_KEY, normalizeEffort(effort));
  } catch {}
}

/**
 * Pill "Suy luận: …" đứng cạnh pill model. Bấm ra sheet chọn mức + một nút
 * "Chế độ nhanh" (nhảy thẳng mức nhẹ nhất mà model có).
 * `variants` là `variants` của model ĐANG chọn trong catalog, lấy từ
 * lib/model-behavior effortOptionsFor — không tự chế danh sách ở đây.
 */
export function EffortPicker({ modelValue, variants, effort, onChange }) {
  const [open, setOpen] = useState(false);
  const model = parseModelValue(modelValue);
  const options = useMemo(() => effortOptionsFor(model, variants), [modelValue, variants]);
  const inputRef = useRef(null);
  // Đổi sang model không có mức đã chọn -> tự về Mặc định, không giữ mức ma.
  const current = resolveEffort(effort, model, variants);
  const currentLabel = effortLabelVi(current);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 90);
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Model không có mức nào ngoài "Mặc định" -> không hiện gì cả.
  if (options.length <= 1) return null;

  const pick = (id) => {
    onChange(id);
    saveEffort(id);
    setOpen(false);
  };

  // Mức nhẹ nhất của model này — "Chế độ nhanh" chỉ hiện khi thực sự có.
  const fast = fastModeEffort(model, variants);

  const goFast = () => {
    if (fast === EFFORT_NONE) return;
    pick(fast);
  };

  return (
    <>
      <button
        class="model-pill"
        type="button"
        aria-haspopup="dialog"
        aria-label={`Mức suy luận: ${currentLabel}. Bấm để đổi`}
        onClick={() => setOpen(true)}
      >
        <span class="model-pill-label">Suy luận: {currentLabel}</span>
        <ChevronDownIcon size={14} />
      </button>

      {open && (
        <div class="sheet-backdrop" onClick={() => setOpen(false)}>
          <div class="card sheet model-sheet" role="dialog" aria-modal="true" aria-label="Chọn mức suy luận" onClick={(e) => e.stopPropagation()}>
            <div class="sheet-grabber" />
            <div class="model-group">Mức suy luận</div>
            <div class="model-list" role="listbox" aria-label="Mức suy luận">
              {fast !== EFFORT_NONE && (
                <button type="button" class="model-option" onClick={goFast}>
                  <span class="model-option-text">
                    <span class="model-option-name">Chế độ nhanh</span>
                    <span class="model-option-sub">Mức nhẹ nhất model này có</span>
                  </span>
                </button>
              )}
              {options.map((o) => (
                <button key={o.id} ref={o.id === EFFORT_NONE ? inputRef : undefined} type="button" role="option" aria-selected={current === o.id} class={`model-option${current === o.id ? " selected" : ""}`} onClick={() => pick(o.id)}>
                  <span class="model-option-text">
                    <span class="model-option-name">{o.vi}</span>
                    {o.id === EFFORT_NONE && <span class="model-option-sub">Để model tự chọn</span>}
                  </span>
                  {current === o.id && <CheckIcon size={18} />}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
