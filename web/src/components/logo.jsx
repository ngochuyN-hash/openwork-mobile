/** Logo OpenWork chính chủ (openwork-mark.svg — lục giác navy).
 *  App chỉ có nền sáng nên dùng luôn bản gốc. Trước đây chỗ này nghe
 *  `prefers-color-scheme` để đổi sang openwork-mark-dark.svg — sau khi bỏ
 *  chế độ tối, đoạn đó chỉ làm logo bị tối trên nền sáng của máy đang bật
 *  dark. Đừng thêm lại: nếu sau này làm nền tối thì đổi ở token + 1 chỗ
 *  duy nhất, không phải mỗi component nghe media query riêng. */
export function OpenWorkMark({ className, label = "OpenWork" }) {
  return (
    <img src="/openwork-mark.svg" alt={label} class={className} width="64" height="64" />
  );
}