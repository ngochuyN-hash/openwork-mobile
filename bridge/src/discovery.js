import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { openworkFilePath } from "./paths.js";

// Discovery: find the openwork-server HTTP API base URL on this machine.
//
// How it works:
//  1. %APPDATA%\openwork\engine-instances.json holds the engine sidecar entry,
//     including ownerPid = the OpenWork desktop main process. The openwork-server
//     HTTP API runs INSIDE that process on a random port (62222 today, changes
//     between launches).
//  2. `netstat -ano` gives us every port that process listens on.
//  3. We probe each candidate's GET /health. The openwork-server health payload
//     uniquely has an `opencodeVersion` field (other local services don't).
//  4. GET /whoami with our owner token confirms the token is loaded (200).

export function readEngineRegistry() {
  try {
    const raw = readFileSync(openworkFilePath("engine-instances.json"), "utf8");
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    return entries.find((e) => e?.role === "primary") ?? entries[0] ?? null;
  } catch {
    return null;
  }
}

export function ownerPid() {
  const entry = readEngineRegistry();
  return Number.isInteger(entry?.ownerPid) && entry.ownerPid > 0 ? entry.ownerPid : 0;
}

// "  TCP    127.0.0.1:62222    0.0.0.0:0    LISTENING    14316" -> [62222, ...]
export function parseListeningPorts(netstatOutput, pid) {
  const ports = new Set();
  for (const line of String(netstatOutput).split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    const local = cols[1] ?? "";
    const owner = Number(cols[cols.length - 1]);
    if (owner !== pid) continue;
    const port = Number(local.split(":").pop());
    if (Number.isInteger(port) && port > 0) ports.add(port);
  }
  return [...ports];
}

export function listeningPortsForPid(pid) {
  const result = spawnSync("netstat", ["-ano"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  if (result.status !== 0 || !result.stdout) return [];
  return parseListeningPorts(result.stdout, pid);
}

async function fetchJson(url, { headers = {}, timeoutMs = 2500 } = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

// True when the /health payload looks like openwork-server (has opencodeVersion).
export function isOpenWorkServerHealth(body) {
  return Boolean(body) && body.ok === true && typeof body.opencodeVersion === "string";
}

/**
 * @returns {Promise<{baseUrl:string, version:string, opencodeVersion:string, uptimeMs:number} | null>}
 */
export async function probeServerUrl(baseUrl) {
  const health = await fetchJson(`${baseUrl}/health`).catch(() => null);
  if (!health || health.status !== 200 || !isOpenWorkServerHealth(health.body)) return null;
  return { baseUrl, ...health.body };
}

/**
 * Find the openwork-server base URL.
 * @param {{ownerToken?: string, lastServerPort?: number, serverUrlOverride?: string}} options
 */
export async function discoverServer(options = {}) {
  const override = (options.serverUrlOverride || process.env.OPENWORK_SERVER_URL || "").trim();
  const candidates = [];
  if (override) candidates.push(override.replace(/\/+$/, ""));
  if (options.lastServerPort) candidates.push(`http://127.0.0.1:${options.lastServerPort}`);
  const pid = ownerPid();
  if (pid > 0) candidates.push(...listeningPortsForPid(pid).map((port) => `http://127.0.0.1:${port}`));

  for (const baseUrl of candidates) {
    const found = await probeServerUrl(baseUrl);
    if (found) return found;
  }
  return null;
}

/** Check whether our owner token is accepted by the server (scope owner). */
export async function checkTokenActive(baseUrl, ownerToken) {
  if (!baseUrl || !ownerToken) return false;
  const whoami = await fetchJson(`${baseUrl}/whoami`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  }).catch(() => null);
  return Boolean(whoami && whoami.status === 200);
}
