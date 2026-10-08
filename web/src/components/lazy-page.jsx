// Route-level code splitting without preact/compat. The page chunk is fetched
// the first time its route renders and cached for the session; a failed fetch
// (offline on a never-visited route, or a stale shell after a deploy) shows a
// retry banner instead of a blank screen. Only use it for pages that need the
// network anyway — an offline first visit to a lazy route cannot work.

import { useEffect, useState } from "preact/hooks";
import { Banner } from "./ui.jsx";

export function lazyPage(load, exportName) {
  let Loaded = null;
  let pending = null;

  return function LazyPage(props) {
    const [Comp, setComp] = useState(() => Loaded);
    const [attempt, setAttempt] = useState(0);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
      if (Comp) return undefined;
      let live = true;
      pending ||= load().then((mod) => {
        Loaded = mod[exportName];
      });
      pending.then(
        () => live && (setFailed(false), setComp(() => Loaded)),
        () => {
          pending = null;
          if (live) setFailed(true);
        },
      );
      return () => {
        live = false;
      };
    }, [attempt]);

    if (Comp) return <Comp {...props} />;
    if (failed) {
      return (
        <Banner actionLabel="Retry" onAction={() => setAttempt((n) => n + 1)}>
          Could not load this page. Check the connection and try again.
        </Banner>
      );
    }
    return <div class="page-loading" aria-busy="true" />;
  };
}
