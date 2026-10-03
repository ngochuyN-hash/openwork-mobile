// Build bộ cài OpenPocket — MỘT file OpenPocket-Setup.exe.
//
// Flow: assert web/dist is FRESH (never ship a stale bundle) → stage
// (bridge + VENDORED bridge/node_modules + web/dist + OpenPocket.exe +
// HUONG-DAN) → zip → NHÚNG zip vào exe trình cài (desktop/src/OpenPocketSetup.cs,
// csc /res:) → OpenPocket-Setup.exe ở gốc dự án.
//
// node_modules is VENDORED: the bridge has exactly one production dependency
// (qrcode-terminal, no deps of its own — see bridge/package-lock.json). The
// closure is computed from the lockfile and copied from the dev tree's
// bridge/node_modules, so the END USER never runs npm install — the installer
// only needs node.exe itself (to run the bridge). The dev tree's node_modules
// may still carry removed packages (sharp, node-screenshots, …) — they are
// NOT in the lockfile closure and therefore never staged.
//
// Run: node desktop/build-setup.js                (full build)
//      node desktop/build-setup.js --stage-only   (stop after staging, for checks)
// Prereq: desktop/bin/OpenPocket.exe built first (desktop\build.bat).

const fs = require("fs");
const path = require("path");
const { execSync, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const STAGE = path.join(process.env.TEMP, "openpocket-sfx-stage");
const ZIP = path.join(process.env.TEMP, "openpocket-package.zip");
const OUT_EXE = path.join(ROOT, "OpenPocket-Setup.exe");
const STAGE_ONLY = process.argv.includes("--stage-only");

// Newest mtime under every given root (recursive). Missing roots are skipped;
// returns 0 when nothing exists so the freshness assert fails loudly.
function newestMtime(roots) {
  let newest = 0;
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p)) walk(path.join(p, name));
    } else if (st.mtimeMs > newest) {
      newest = st.mtimeMs;
    }
  };
  for (const p of roots) if (fs.existsSync(p)) walk(p);
  return newest;
}

// 0a. web/dist must be at least as new as every web source file — a dist
// older than the sources means someone forgot `npm run build` and the exe
// would ship a stale bundle.
function assertDistFresh() {
  const distDir = path.join(ROOT, "web", "dist");
  if (!fs.existsSync(distDir)) {
    throw new Error("web/dist does not exist — build first: cd web && npm run build");
  }
  const srcRoots = [
    path.join(ROOT, "web", "src"),
    path.join(ROOT, "web", "public"),
    path.join(ROOT, "web", "index.html"),
    path.join(ROOT, "web", "vite.config.js"),
    path.join(ROOT, "web", "package.json"),
  ];
  const srcNewest = newestMtime(srcRoots);
  const distNewest = newestMtime([distDir]);
  if (distNewest < srcNewest) {
    const fmt = (ms) => new Date(ms).toISOString();
    throw new Error(
      "web/dist is STALE (newest dist " + fmt(distNewest) +
      " < newest web source " + fmt(srcNewest) + ")" +
      " — rebuild first: cd web && npm run build"
    );
  }
}

// 0b. Production dependency closure from bridge/package-lock.json —
// dependencies of dependencies included; devDependencies ignored.
function productionClosure(lock) {
  const packages = lock.packages || {};
  const root = packages[""] || {};
  const names = new Set();
  const queue = Object.keys(root.dependencies || {});
  while (queue.length > 0) {
    const name = queue.shift();
    if (names.has(name)) continue;
    names.add(name);
    const entry = packages["node_modules/" + name];
    if (!entry) {
      throw new Error(
        'package-lock.json has no entry for "' + name + '"' +
        " — refresh it: cd bridge && npm install"
      );
    }
    for (const dep of Object.keys(entry.dependencies || {})) queue.push(dep);
  }
  return Array.from(names).sort();
}

// Stage bridge/node_modules with ONLY the lockfile closure. A package missing
// or version-mismatched in the dev tree is a hard error (stale install must
// not silently become a broken installer).
function stageNodeModules() {
  const lockPath = path.join(ROOT, "bridge", "package-lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  const names = productionClosure(lock);
  const staged = [];
  for (const name of names) {
    const srcDir = path.join(ROOT, "bridge", "node_modules", name);
    if (!fs.existsSync(path.join(srcDir, "package.json"))) {
      throw new Error(
        "bridge/node_modules/" + name + " is missing locally" +
        " — install it: cd bridge && npm install"
      );
    }
    const want = lock.packages["node_modules/" + name].version;
    const have = JSON.parse(fs.readFileSync(path.join(srcDir, "package.json"), "utf8")).version;
    if (have !== want) {
      throw new Error(
        "bridge/node_modules/" + name + " is " + have +
        ", lockfile wants " + want + " — refresh: cd bridge && npm install"
      );
    }
    fs.cpSync(srcDir, path.join(STAGE, "bridge", "node_modules", name), { recursive: true });
    staged.push(name + "@" + want);
  }
  return staged;
}

// 1. Stage — bố cục đúng như app đòi (OpenPocket.exe nằm cạnh bridge\, web\)
assertDistFresh();
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(path.join(STAGE, "bridge"), { recursive: true });
fs.mkdirSync(path.join(STAGE, "web"), { recursive: true });
fs.cpSync(path.join(ROOT, "bridge", "src"), path.join(STAGE, "bridge", "src"), { recursive: true });
fs.cpSync(path.join(ROOT, "bridge", "scripts"), path.join(STAGE, "bridge", "scripts"), { recursive: true });
fs.cpSync(path.join(ROOT, "bridge", "bin"), path.join(STAGE, "bridge", "bin"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "bridge", "package.json"), path.join(STAGE, "bridge", "package.json"));
fs.copyFileSync(path.join(ROOT, "bridge", "package-lock.json"), path.join(STAGE, "bridge", "package-lock.json"));
fs.copyFileSync(path.join(ROOT, "bridge", "VERSION"), path.join(STAGE, "bridge", "VERSION"));
fs.cpSync(path.join(ROOT, "web", "dist"), path.join(STAGE, "web", "dist"), { recursive: true });
const vendored = stageNodeModules();
const exePath = path.join(ROOT, "desktop", "bin", "OpenPocket.exe");
if (!fs.existsSync(exePath)) {
  throw new Error("desktop/bin/OpenPocket.exe not found — build it first: desktop\\build.bat");
}
fs.copyFileSync(exePath, path.join(STAGE, "OpenPocket.exe"));
fs.copyFileSync(path.join(ROOT, "HUONG-DAN.txt"), path.join(STAGE, "HUONG-DAN.txt"));
console.log("vendored node_modules:", vendored.join(", "));

if (STAGE_ONLY) {
  console.log("Stage complete (no exe built):", STAGE);
  process.exit(0);
}

// 2. Zip (Compress-Archive mangled tên có dấu — mọi entry giữ ASCII, đã vậy)
execSync(
  `powershell -NoProfile -Command "Compress-Archive -Path '${STAGE}\\*' -DestinationPath '${ZIP}' -Force"`,
  { stdio: "inherit" }
);

// 3. Nhúng zip vào exe trình cài bằng csc có sẵn trong Windows
const csc64 = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const csc32 = "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe";
const csc = fs.existsSync(csc64) ? csc64 : csc32;
const args = [
  "/target:winexe",
  "/optimize",
  "/codepage:65001",
  `/win32manifest:${path.join(ROOT, "desktop", "src", "setup.manifest")}`,
  "/r:System.dll",
  "/r:System.Drawing.dll",
  "/r:System.Windows.Forms.dll",
  "/r:System.IO.Compression.dll",
  "/r:System.IO.Compression.FileSystem.dll",
  "/r:Microsoft.CSharp.dll",
  `/res:${ZIP}`,
  `/out:${OUT_EXE}`,
  path.join(ROOT, "desktop", "src", "OpenPocketSetup.cs"),
];
const build = spawnSync(csc, args, { encoding: "utf8" });
if (build.error) throw build.error;
if (build.status !== 0) {
  console.error(build.stdout);
  console.error(build.stderr);
  process.exit(build.status || 1);
}

console.log("OpenPocket-Setup.exe:", (fs.statSync(OUT_EXE).size / 1024).toFixed(0) + " KB");
