// Dẹt hoá catalog model của engine (GET /config/providers) thành danh sách chọn
// cho ModelPicker — tách khỏi pages/chat.jsx (round 4, 09/10) để luật dựng danh
// sách test được không cần render. Shape engine trả chấp nhận cả hai dạng bọc:
// {providers} hoặc {data:{providers}}; model không có name thì dùng id.
export function flattenProviderModels(payload) {
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
        // Danh sách mức suy luận engine khai cho model này. Giữ nguyên shape
        // engine trả; lib/model-behavior bóc ra và KHÔNG bịa thêm mức nào
        // không có trong đây.
        variants: m.variants,
      });
    }
  }
  return flat;
}
