// scripts/pack.mjs — 把 dist/ 打成可安装 zip + 市场 entry，产物落 releases/。
//
// zip 只用 node 内建 zlib 写，不引打包器。entry（市场投稿元数据）需要一张 256×256 的 PNG 图标，
// 而本 App 的身份图标是 SVG：光栅化结果 assets/icon-256.png 随仓库提交，这里只读文件，
// 不在打包时现转（CI 里没有完整宿主，也就没有 sharp）。
//
// 从 DSHana 的 pack/index.mts 继承的纪律（那几条都是被坑出来的）：
//   · zip 根 = 包根：manifest.json 必须在 zip 根级，不能套一层 `<name>/`，
//     否则宿主装不上（它会在包根读 manifest.json）。
//   · 先写临时文件再 rename：中途失败不会留一个半截 zip 被当成成品。
//   · 出包前断言关键件在位，缺一个就拒绝出包，不做"大概能装"的包。
//   · 同一份产物要能核对：打印文件数、体积、SHA256，并把这个 SHA 写进 entry。
//
// entry 里的 archive.url 用 `{{BASE_URL}}` 占位，由发布侧替换成真实下载前缀
// （与宿主打包器同一约定）。
//
// 许可证：LICENSE 进 zip（源码分发的合规要求，MPL-2.0 也要求附许可文本），
// 同时把 SPDX 标识写进 entry.license。
//
// 用法：
//   node scripts/pack.mjs                     打包（zip + entry）
//   node scripts/pack.mjs --check             只校验交付树，不写产物
//   node scripts/pack.mjs --publisher <名字>  指定发布者（默认取 package.json 的 publisher）
import { createHash } from "node:crypto";
import { deflateRawSync, crc32 } from "node:zlib";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
const MANIFEST = JSON.parse(await readFile(join(ROOT, "manifest.json"), "utf8"));
const DIST = join(ROOT, "dist");
const OUT_DIR = join(ROOT, "releases");
// zip 直接用 `<id>-v<version>.zip`（不带 kind 前缀，但版本带 v，与 DSHana 的 `dshana-v<ver>.zip` 同形）；
// 只有 entry 才带 `app-` 前缀。
const ZIP_NAME = `${MANIFEST.id}-v${MANIFEST.version}.zip`;
const ENTRY_NAME = `app-${MANIFEST.id}-${MANIFEST.version}.entry.json`;

/** 交付清单：缺任何一个就不出包。这些是宿主装载/运行真正会碰到的文件。 */
const REQUIRED = [
  "manifest.json",
  MANIFEST.icon,
  MANIFEST.entry, // bin/index.mjs
  "bin/oauth-callback.mjs", // 受管 runtime 入口
  "bin/port-probe.mjs", // 端口探针
  // MPL-2.0 要求随包附许可文本；源码分发时它是交付件的一部分，不是可选文档。
  "LICENSE",
];

const argv = process.argv.slice(2);
const checkOnly = argv.includes("--check");
const publisher = (() => {
  const i = argv.indexOf("--publisher");
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return PKG.publisher || "Nyaser";
})();

function fail(message) {
  console.error("[pack] " + message);
  process.exit(1);
}

// ---- 1. 断言交付树 ----
if (!existsSync(DIST)) fail(`找不到 ${DIST}：先跑 node build.mjs`);

const missing = REQUIRED.filter((rel) => !existsSync(join(DIST, rel)));
if (missing.length) fail(`交付件缺失：${missing.join("、")}（拒绝出包）`);

// 产物里不该出现裸包名：宿主子进程不解析宿主 node_modules，内联是硬要求。
const entrySource = await readFile(join(DIST, MANIFEST.entry), "utf8");
const bareImport = /(?:from|import)\s*["'](@[a-z0-9-]+\/[^"']+|[a-z][a-z0-9-]*)["']/i.exec(entrySource);
if (bareImport) fail(`入口里还有裸包名 ${bareImport[1]}：构建没内联，装到宿主里会解析失败`);

// 入口里不允许残留开发路径：源码里出现构建机绝对路径，装到别人机器上就会指到不存在的位置。
const leakedPath = /[A-Za-z]:[\\/](?:Users|Hanako|\.hanako)[\\/]/.exec(entrySource);
if (leakedPath) fail(`入口里残留构建机绝对路径：${leakedPath[0]}`);

// ---- 2. 暂存目录：组装台 ----
// 照 DSHana 的分工：dist/ 是构建产物（工位，不直接进包）；pack 另建一个暂存目录做组装，
// 在它上面跑断言、然后才写 zip。好处是“要进包的东西”与“dist 里的中间物”能分开——
// 以后 dist 里多出什么（sourcemap、缓存）也不会默认漏进安装包。
const STAGE = join(ROOT, ".cache", "pkg");
await rm(STAGE, { recursive: true, force: true });
await mkdir(STAGE, { recursive: true });
for (const rel of REQUIRED) {
  const from = join(DIST, rel);
  const to = join(STAGE, rel);
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
}

// ---- 3. 收集文件 ----
/** 递归列出文件（zip 里的路径一律用 `/`）。 */
async function walk(dir, base = dir) {
  const out = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, item.name);
    if (item.isDirectory()) {
      out.push(...(await walk(full, base)));
      continue;
    }
    // 软链接进 zip 跨机解压即断，宿主也会拒收。
    if (!item.isFile()) fail(`暂存树里有非普通文件（软链？）：${relative(base, full)}`);
    out.push(relative(base, full).split(sep).join("/"));
  }
  return out.sort();
}

const files = await walk(STAGE);
// 暂存树里只能有清单上的那些文件，多一个就是组装漏了过滤。
const unexpected = files.filter((rel) => !REQUIRED.includes(rel));
if (unexpected.length) fail(`暂存树里有清单外的文件：${unexpected.join("、")}`);
console.log(`[pack] 暂存 ${files.length} 个：${files.join("、")}`);
if (checkOnly) {
  await rm(STAGE, { recursive: true, force: true });
  console.log("[pack] --check 通过（未写产物）");
  process.exit(0);
}

// ---- 4. 写 zip ----
/**
 * 最小 zip 写入：本地文件头 + 数据 + 中央目录 + EOCD。
 * 不写 ZIP64：本包远小于 4 GB / 65535 条目。
 */
function dosDateTime(date) {
  const time =
    ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day =
    (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

// 固定时间戳（DOS 纪元 1980-01-01 00:00）：同样的输入得到同样的 zip 字节，
// 便于比对两次构建是否只差内容，也让 CI 的产物可复现。
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

const chunks = [];
const central = [];
let offset = 0;

for (const rel of files) {
  const buf = await readFile(join(STAGE, rel));
  const name = Buffer.from(rel, "utf8");
  // deflate 只对够大的文件有意义；小文件的 deflate 头反而更大。
  const useDeflate = buf.length > 512;
  const body = useDeflate ? deflateRawSync(buf, { level: 9 }) : buf;
  const method = useDeflate ? 8 : 0;
  const crc = crc32(buf);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
  local.writeUInt16LE(20, 4); // 解压所需版本 2.0
  local.writeUInt16LE(0x0800, 6); // 通用位：文件名为 UTF-8
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(buf.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28); // 无扩展字段

  chunks.push(local, name, body);

  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0); // 中央目录头签名
  entry.writeUInt16LE(20, 4); // 创建版本
  entry.writeUInt16LE(20, 6); // 解压所需版本
  entry.writeUInt16LE(0x0800, 8);
  entry.writeUInt16LE(method, 10);
  entry.writeUInt16LE(DOS_TIME, 12);
  entry.writeUInt16LE(DOS_DATE, 14);
  entry.writeUInt32LE(crc, 16);
  entry.writeUInt32LE(body.length, 20);
  entry.writeUInt32LE(buf.length, 24);
  entry.writeUInt16LE(name.length, 28);
  entry.writeUInt16LE(0, 30); // 扩展字段长度
  entry.writeUInt16LE(0, 32); // 注释长度
  entry.writeUInt16LE(0, 34); // 磁盘号
  entry.writeUInt16LE(0, 36); // 内部属性
  entry.writeUInt32LE(0, 38); // 外部属性
  entry.writeUInt32LE(offset, 42);
  central.push(entry, name);

  offset += local.length + name.length + body.length;
}

const centralBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0); // EOCD 签名
eocd.writeUInt16LE(0, 4); // 本磁盘号
eocd.writeUInt16LE(0, 6); // 中央目录起始磁盘号
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20); // 注释长度

const zip = Buffer.concat([...chunks, centralBuf, eocd]);

// ---- 5. 先校验归档，过了才落位 ----
// 照 DSHana 的顺序：zip 先写临时文件 → 拿宿主校验器验一遍 → 通过才 rename 成成品。
// 少了这一步，一个结构不对的 zip 会静默躺在 releases/ 里，等人装机时才报错。
// 校验器只在本地/开发机上有（CI 里没有宿主），所以本地拿不到时就跳过并明说。
await mkdir(OUT_DIR, { recursive: true });
const zipPath = join(OUT_DIR, ZIP_NAME);
const tmpZip = join(OUT_DIR, "." + ZIP_NAME + ".tmp");
await rm(tmpZip, { force: true });
await writeFile(tmpZip, zip);

function verifyArchive(archivePath) {
  const toolsRoot = process.env.HANA_APP_TOOLS_ROOT;
  if (!toolsRoot) return { skipped: "未设 HANA_APP_TOOLS_ROOT" };
  const script = join(toolsRoot, "scripts", "validate-app.mjs");
  if (!existsSync(script)) return { skipped: "找不到 validate-app.mjs" };
  try {
    const out = execFileSync(process.execPath, [script, "--archive", archivePath, "--json"], {
      encoding: "utf8",
      timeout: 180000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, HANA_APP_TOOLS_ROOT: toolsRoot },
    });
    const report = JSON.parse(out.slice(out.indexOf("{")));
    const errors = (report.issues || []).filter((i) => i.severity === "error");
    if (errors.length) return { errors };
    return { ok: true, warnings: (report.issues || []).length };
  } catch (error) {
    // 校验器自己崩了不能当成包好的证据。
    const text = String(error && error.message ? error.message : error);
    return { errors: [{ code: "VALIDATOR_FAILED", message: text.slice(0, 200) }] };
  }
}

const verdict = verifyArchive(tmpZip);
if (verdict.errors) {
  await rm(tmpZip, { force: true });
  fail("归档校验未通过：" + verdict.errors.map((i) => i.code + " " + i.message).join("；"));
}
if (verdict.skipped) console.warn(`[pack] 跳过归档校验（${verdict.skipped}）——CI 环境正常`);
else console.log(`[pack] 归档校验通过（warnings=${verdict.warnings}）`);

await rename(tmpZip, zipPath);

const sha = createHash("sha256").update(zip).digest("hex");
console.log(`[pack] ${zipPath}`);
console.log(`[pack] ${files.length} 个文件 · ${(zip.length / 1024).toFixed(1)} KB · SHA256 ${sha.toUpperCase()}`);

// 组装台用完即清（与 DSHana 的 postpackage 同纪律）：里面只有可再生的副本。
await rm(STAGE, { recursive: true, force: true });

// ---- 6. 市场 entry ----
// icon 要 256×256 PNG 的 data URL（宿主打包器用 sharp 产出同一规格）。
// 本 App 的身份图标是 SVG，所以光栅化结果是 assets/icon-256.png，随仓库提交；
// 打包只读文件——CI 里没有完整宿主，不能指望当场转换。
// 改图标时跑 `node scripts/make-icon-png.mjs` 重新生成。
const ICON_PNG = join(ROOT, "assets", "icon-256.png");

async function loadIcon() {
  if (!existsSync(ICON_PNG)) {
    return { icon: undefined, reason: "缺 assets/icon-256.png（跑 node scripts/make-icon-png.mjs）" };
  }
  const bytes = await readFile(ICON_PNG);
  // PNG 签名：89 50 4E 47。宁可拒绝也不往 entry 里塞一份坏图。
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    return { icon: undefined, reason: "assets/icon-256.png 不是 PNG" };
  }
  return { icon: `data:image/png;base64,${bytes.toString("base64")}` };
}

// archive.url 恒为 `{{BASE_URL}}/<zip 名>`。这是市场协议的硬要求，不是可选写法：
// 同步器靠 `{{BASE_URL}}/` 前缀取出 zip 资产名、再去 Release 资产里找同名文件
// （`assetFileName()` 只认这个前缀，否则抛 “entry archive.url must name a local {{BASE_URL}} ZIP asset”），
// 取到实例后再把整串换成真实的 browser_download_url 写进 index.v2.json。
// 所以这里刻意不提供覆盖参数：填绝对地址会让投稿在校验阶段直接失败。
const BASE_URL = "{{BASE_URL}}";

const { icon, reason } = await loadIcon();
const license = typeof PKG.license === "string" && PKG.license ? PKG.license : undefined;
if (!license) console.warn("[pack] package.json 缺 license：entry 里不写 SPDX 标识");
const entry = {
  kind: "app",
  id: MANIFEST.id,
  name: MANIFEST.name,
  publisher,
  description: MANIFEST.description,
  version: MANIFEST.version,
  permissions: (MANIFEST.capabilities || []).map((capability) => ({ capability })),
};
if (MANIFEST.minAppVersion) entry.compatibility = { minAppVersion: MANIFEST.minAppVersion };
if (license) entry.license = license;
if (icon) entry.icon = icon;
else console.warn(`[pack] entry 里不带 icon（${reason}）`);
entry.archive = {
  url: BASE_URL + "/" + ZIP_NAME,
  sha256: sha,
  size: zip.length,
  format: "zip",
};

const entryPath = join(OUT_DIR, ENTRY_NAME);
await writeFile(entryPath, JSON.stringify(entry, null, 2) + "\n", "utf8");
console.log(`[pack] ${entryPath}`);
