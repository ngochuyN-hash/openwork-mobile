import { readEngineRegistry, isProcessAlive } from "./discovery.js";
import { candidateExePaths } from "./openwork-launch.js";
import { describeOpenWorkInstall } from "./openwork-version.js";

/**
 * Ảnh chụp "OpenWork desktop trên máy tính" mà web vẽ: exe ở đâu, phiên bản
 * bao nhiêu, app có đang mở không, và các đường dẫn ứng viên để đổi.
 * Dùng chung cho /api/state và câu trả lời của POST /api/openwork/path, để hai
 * nơi không lệch nhau (web vẽ thẳng từ câu trả lời của route path).
 */
export function openworkStateInfo(config) {
  const info = describeOpenWorkInstall({ configOpenworkExe: config.openworkExe });
  const owner = readEngineRegistry()?.ownerPid;
  return {
    found: info.found,
    exe: info.exe,
    version: info.version,
    source: info.source,
    // registry nằm lại trên đĩa sau khi app đóng → phải hỏi tiến trình thật.
    running: isProcessAlive(owner),
    // Luôn kèm, kể cả khi đã tìm thấy: người dùng cần ĐỔI đường dẫn khi cài
    // lại OpenWork ở chỗ khác, không chỉ lúc "chưa thấy".
    candidates: candidateExePaths(config.openworkExe),
  };
}