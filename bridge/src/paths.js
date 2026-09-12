import { join } from "node:path";
import { homedir } from "node:os";

// Where OpenWork desktop keeps its runtime data (server.json, tokens.json,
// engine-instances.json). Override with OPENWORK_DIR for tests.
export function openworkDataDir() {
  const override = (process.env.OPENWORK_DIR || "").trim();
  if (override) return override;
  const appData = process.env.APPDATA;
  if (appData) return join(appData, "openwork");
  return join(homedir(), ".openwork");
}

export function openworkFilePath(name) {
  return join(openworkDataDir(), name);
}
