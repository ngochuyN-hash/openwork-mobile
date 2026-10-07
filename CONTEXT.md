# CONTEXT — domain glossary

## Host contract

The host-machine knowledge that BOTH the desktop GUI (C#, `desktop/src`) and
the bridge (JS, `bridge/src`) must agree on: the bridge port, the data-dir
name (`openwork-bridge`), the config file name, the PID file, the log file
names, the scheduler task names (`OpenPocketBridge` autostart +
`OpenPocketBridgeWatchdog`), the `config.json` key names the GUI reads/writes,
and the tunnel state shapes — the `tunnel-state.json` fallback file and the
`/api/state` `tunnel` object. Note the deliberate split: the fallback file
uses `nextAttemptAt`, the API uses `nextRetryAt`; same meaning, two names, and
renaming either side silently degrades the GUI's tunnel status.

One source of truth: `shared/host-contract.js` (pure ESM, no imports). The
bridge imports it directly; the C# side receives `desktop/src/HostContract.cs`
generated at build time by `desktop/gen-host-contract.mjs` (the same
generated-file pattern as `IdentityKeys.cs` — the generated file is
gitignored, never hand-edited). To change the knowledge, edit the shared file
and rebuild: the two languages cannot drift apart. Drift protection lives in
`bridge/test/host-contract.test.js`.

API shapes shared with web/worker (headers, pairing-link hashes, error codes)
belong to `shared/contract.js`, not here.
