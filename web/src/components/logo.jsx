import { useEffect } from "preact/hooks";

/** Logo OpenWork chính chủ (openwork-mark.svg — lục giác navy).
 *  Dùng SVG gốc nên giữ chi tiết khối. Dark mode dùng bản -dark
 *  (navy -> ngà, trắng -> tối) theo prefers-color-scheme. */
export function OpenWorkMark({ className, label = "OpenWork" }) {
  const darkQuery = "(prefers-color-scheme: dark)";
  useDarkSwap(className, darkQuery);
  return (
    <img
      src="/openwork-mark.svg"
      alt={label}
      class={className}
      data-ow-mark={className ?? ""}
      width="64"
      height="64"
    />
  );
}

function useDarkSwap(className, query) {
  useEffect(() => {
    const mq = window.matchMedia(query);
    const apply = () => {
      const els = document.querySelectorAll(`img[data-ow-mark="${className ?? ""}"]`);
      for (const el of els) el.src = mq.matches ? "/openwork-mark-dark.svg" : "/openwork-mark.svg";
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [className]);
}
