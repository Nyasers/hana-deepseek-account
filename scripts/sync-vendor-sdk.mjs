// scripts/sync-vendor-sdk.mjs — 把本机宿主的 App SDK 快照同步进 vendor/hana-app-sdk
//
// 照 DSHana 的 scripts/vendor/sdk.mts：SDK 以 tgz 快照随仓库管理，构建期由打包器内联，
// 运行期不解析任何裸包名。宿主升级后这份快照会漂，所以用脚本同步而不是人肉拷贝。
//
// 源按序探测（第一个命中的赢）：
//   1. --source <dir>
//   2. <HANA_HOME>/artifacts/server/<最新版本>/skills2set/hana-app-creator/assets/sdk（随宿主分发，权威）
//   3. <HANA_HOME>/skills/hana-app-creator/assets/sdk（已安装 skill 的资产，兜底）
//
// 同步后 SDK 内容变了要重解析锁文件（pnpm 不因本地 tgz 变化自动重算）：
//   pnpm update @hana/app-sdk && pnpm install
//
// 用法：
//   node scripts/sync-vendor-sdk.mjs            同步
//   node scripts/sync-vendor-sdk.mjs --check    只校验差异并 exit 1
//   node scripts/sync-vendor-sdk.mjs --source <dir>
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEST = path.join(ROOT, "vendor", "hana-app-sdk");
const HANA_HOME =
  process.env.HANA_HOME || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), ".hanako");

/** 快照的全部构成，缺一即半份：宁可报错，也不写进去一个残份。 */
const FILES = [
  "hana-app-sdk.tgz",
  "hana-plugin-components-0.0.0.tgz",
  "hana-plugin-protocol-0.0.0.tgz",
  "hana-plugin-sdk-0.0.0.tgz",
  "source-manifest.json",
];

function arg(name) {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) return argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
    if (argv[i].startsWith(name + "=")) return argv[i].slice(name.length + 1);
  }
  return null;
}

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const head = (h) => h.slice(0, 12);

/** server 目录名形如 `1.1.111-beta-win32-x64-<hash>`；按语义版本降序。 */
function byVersionDesc(a, b) {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function findSource() {
  const explicit = arg("--source");
  if (explicit) return path.resolve(explicit);

  const serverRoot = path.join(HANA_HOME, "artifacts", "server");
  if (fs.existsSync(serverRoot)) {
    const newest = fs
      .readdirSync(serverRoot)
      .filter((v) => fs.existsSync(path.join(serverRoot, v, "skills2set", "hana-app-creator", "assets", "sdk")))
      .sort(byVersionDesc)[0];
    if (newest) return path.join(serverRoot, newest, "skills2set", "hana-app-creator", "assets", "sdk");
  }
  return path.join(HANA_HOME, "skills", "hana-app-creator", "assets", "sdk");
}

function packedVersion(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, "source-manifest.json"), "utf8"));
    return typeof j?.packedVersion === "string" ? j.packedVersion : null;
  } catch {
    return null;
  }
}

const checkOnly = process.argv.includes("--check");
const src = findSource();

const missing = FILES.filter((f) => !fs.existsSync(path.join(src, f)));
if (missing.length) {
  console.error(`[sync-vendor-sdk] 源不完整：${src} 缺 ${missing.join("、")}`);
  console.error("[sync-vendor-sdk] 用 --source <dir> 指定 App SDK 快照目录。");
  process.exit(2);
}

const srcVersion = packedVersion(src);
if (!srcVersion) {
  console.error(`[sync-vendor-sdk] 源 manifest 无效：${path.join(src, "source-manifest.json")} 的 packedVersion 读不出`);
  process.exit(2);
}

console.log(`[sync-vendor-sdk] 源 ${src}（packedVersion ${srcVersion}）`);
console.log(`[sync-vendor-sdk] 目标 ${DEST}（packedVersion ${packedVersion(DEST) ?? "未知"}）`);

const changed = [];
for (const name of FILES) {
  const from = path.join(src, name);
  const to = path.join(DEST, name);
  const same = fs.existsSync(to) && sha256(to) === sha256(from);
  if (same) continue;
  changed.push(name);
  if (checkOnly) {
    console.log(`  - ${name}  ${fs.existsSync(to) ? head(sha256(to)) : "（缺）"} → ${head(sha256(from))}`);
    continue;
  }
  fs.mkdirSync(DEST, { recursive: true });
  fs.copyFileSync(from, to);
  console.log(`[sync-vendor-sdk] 写回 ${name}`);
}

if (checkOnly) {
  if (changed.length) {
    console.error(`[sync-vendor-sdk] 漂移 ${changed.length} 个文件——跑 node scripts/sync-vendor-sdk.mjs 写回`);
    process.exit(1);
  }
  console.log(`[sync-vendor-sdk] 一致（${FILES.length} 个文件）`);
  process.exit(0);
}

if (!changed.length) {
  console.log(`[sync-vendor-sdk] 无需同步（已是 packedVersion ${packedVersion(DEST)}）`);
} else {
  console.log(`[sync-vendor-sdk] 已同步 ${changed.length} 个文件：${changed.join("、")}`);
  if (changed.includes("hana-app-sdk.tgz")) {
    console.log("[sync-vendor-sdk] SDK tarball 变了，锁文件要重解析：pnpm update @hana/app-sdk && pnpm install");
  }
}
