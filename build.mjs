// build.mjs — 把 src/ 打成一份可直接安装的 App 目录 dist/
//
// 形态照 DSHana：SDK 走裸包名 `@hana/app-sdk/server`（devDependency，真身是 vendor 里的 tgz），
// 由 esbuild 在构建期静态内联进产物；安装包里没有 sdk/ 目录，也不在用户机器上解析裸包名。
// 宿主子进程不解析宿主 node_modules（见 APPS.md「第三方 App 不走这条管线」），所以内联是硬要求。
//
// 产物（dist/ 本身就是安装根，manifest 里的路径都相对它）：
//   manifest.json          App 契约件（entry = bin/index.mjs）
//   icon.svg               身份图标
//   LICENSE                许可文本
//   bin/index.mjs          App 主体（单文件，SDK 与 node: 内建之外无外部依赖）
//   bin/oauth-callback.mjs 受管 runtime 入口（宿主以 node 直接执行，必须独立成文件）
//   bin/port-probe.mjs     端口探针（主进程 spawn 它去 bind(0) 拿可绑端口）
//
// 代码全部收在 bin/ 下（与 DSHana 的 bin/app.mjs + bin/dsh.mjs 同形），根下只留契约件。
// dist/ 不套 `<id>/` 一层：本地安装直接把 dist/ 当包目录用，zip 的根也就是它。
//
// 用法：node build.mjs
import { mkdir, rm, copyFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const ROOT = dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(await readFile(join(ROOT, "manifest.json"), "utf8"));
const DIST = join(ROOT, "dist");
const BIN = join(DIST, "bin");

if (!existsSync(join(ROOT, "node_modules", "@hana", "app-sdk"))) {
  throw new Error("缺 @hana/app-sdk：先 pnpm install（真身是 vendor/hana-app-sdk/hana-app-sdk.tgz）");
}

await rm(DIST, { recursive: true, force: true });
await mkdir(BIN, { recursive: true });

await build({
  entryPoints: [join(ROOT, "src", "index.mjs")],
  outfile: join(BIN, "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // node: 内建由运行时提供；只要包名外部化，内联的 SDK 就与宿主的 node_modules 无关。
  external: ["node:*"],
  // 交付产物开压缩（对齐 DSHana 的 `optimization.minimize=!0`）：这是安装包里的代码，
  // 不是给人读的源；留一份未压缩的 50 KB 只是让包变大。
  minify: true,
  // 注释全去：本仓的习惯是把“为什么”写成注释，那些理由留在 src/ 里，产物不需要。
  legalComments: "none",
  logLevel: "info",
});

// 受管 runtime 入口不进主 bundle：宿主按 entry 路径以 node 执行它，必须保持独立文件。
await copyFile(join(ROOT, "src", "runtime", "oauth-callback.mjs"), join(BIN, "oauth-callback.mjs"));

// 端口探针必须自包含且单独成文件：主进程没有 --allow-net，要 spawn 它去 bind(0) 拿号。
// 它只依赖 node:net，无需打包。
await copyFile(join(ROOT, "src", "bin", "port-probe.mjs"), join(BIN, "port-probe.mjs"));

await copyFile(join(ROOT, "manifest.json"), join(DIST, "manifest.json"));
await copyFile(join(ROOT, "icon.svg"), join(DIST, "icon.svg"));

// 许可证随包分发：MPL-2.0 要求把许可文本连同源码一起给出。
if (!existsSync(join(ROOT, "LICENSE"))) {
  throw new Error("缺 LICENSE：MPL-2.0 要求随包附许可文本");
}
await copyFile(join(ROOT, "LICENSE"), join(DIST, "LICENSE"));

// minAppVersion 必须跟 SDK 走：SDK 快照就是用哪个宿主版本打的，就要求哪个宿主版本。
// 在产物里现场写一遍，而不是靠人手同步——两处数字一旦不一致，宿主要么直接拒装，
// 要么让老宿主跑起一个用新接口写的 App（错在运行期才发现，比拒装难查多了）。
const sdkManifest = JSON.parse(
  await readFile(join(ROOT, "vendor", "hana-app-sdk", "source-manifest.json"), "utf8")
);
const sdkVersion = sdkManifest.packedVersion;
if (typeof sdkVersion !== "string" || !sdkVersion) {
  throw new Error("vendor/hana-app-sdk/source-manifest.json 缺 packedVersion：先跑 node scripts/sync-vendor-sdk.mjs");
}
const distManifest = JSON.parse(await readFile(join(DIST, "manifest.json"), "utf8"));
if (distManifest.minAppVersion !== sdkVersion) {
  distManifest.minAppVersion = sdkVersion;
  await writeFile(join(DIST, "manifest.json"), JSON.stringify(distManifest, null, 2) + "\n", "utf8");
}

// 入口路径必须与产物布局一致：manifest 说 bin/index.mjs，文件就得在那儿。
const entryPath = join(DIST, ...distManifest.entry.split("/"));
if (!existsSync(entryPath)) {
  throw new Error(`manifest.entry = ${distManifest.entry}，但产物里没有这个文件（拒绝出包）`);
}

console.log("[build] " + DIST + " 已就绪（bin/index.mjs + bin/oauth-callback.mjs + bin/port-probe.mjs + 契约件）");
console.log("[build] minAppVersion = " + sdkVersion + "（跟 vendor 里的 SDK 快照走）");
