// Hana DeepSeek Account — Hana v2 App: DeepSeek 帐号登录 + 原生模型提供方
//
// SDK 引入形态：`@hana/app-sdk/server` 裸包名（devDependency，真身是 vendor 里的 tgz），
// 构建期由 esbuild 静态内联进 dist/index.mjs；安装包里没有 sdk/ 目录，运行期不解析裸包名。
// 宿主子进程不解析宿主 node_modules，所以内联是硬要求，见 APPS.md「第三方 App 不走这条管线」。
//
// 安全约定：token / authorization code 绝不进入日志、错误文本或任何磁盘文件；
// 唯一落点是 storage.global 的 "credential" 键。

import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineApp } from "@hana/app-sdk/server";

const APP_ID = "hana-deepseek-account";
const CLIENT_VERSION = "0.1.0";
const PLATFORM_ORIGIN = "https://platform.deepseek.com";
/** 推理与模型列表同源（`MESSAGES_BASE` 是它下面的路径）。 */
const INFERENCE_ORIGIN = "https://api.deepseek.com";
const MESSAGES_BASE = INFERENCE_ORIGIN + "/anthropic";
const CALLBACK_PATH = "/oauth/callback";
const READY_MARKER = "DEEPSEEK_OAUTH_READY";
const SERVICE_ID = "oauth-callback";
/** 探针也拿不到号时的占位端口：只用来拼 redirect_uri，不监听。 */
const FALLBACK_PORT = 47821;
/** 起不来就换号重试的次数：每次都由系统现给一个号，不是遍历固定端口表。 */
const PORT_ATTEMPTS = 8;
/** 探针本身的超时：它只做一次 bind(0) 就退出。 */
const PORT_PROBE_TIMEOUT_MS = 5000;
const CREDENTIAL_KEY = "credential";
const DEVICE_KEY = "device_id";

/**
 * 思考档位：不声明就会落到宿主兜底值 `["off","medium","high"]`（bundle 里的 `Z$e`），
 * 而那是 gpt / 通用模型的词表，不是 DeepSeek 的。DeepSeek 走三档 `low / high / max`，
 * 加上关闭共四档，与宿主自己的 model-catalog 里这两个 id 的条目逐字一致。
 *
 * 词表约束：宿主校验器只认 `high / low / medium / max`（bundle 里的那个 Set），
 * `xhigh` 不算合法档位、只能靠 `thinkingLevelMap` 映射，所以这里不写它。
 *
 * 生效路径：descriptor.models → bundle `let o = r.models.map(...)` → `getModels()`，
 * 不需要走 refreshModels。
 */
const THINKING_LEVELS = ["off", "low", "high", "max"];

const MODELS = [
  {
    id: "deepseek-flash",
    name: "DeepSeek-V4.1-Flash",
    api: "deepseek-account-messages",
    baseUrl: MESSAGES_BASE,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 393216,
    thinkingLevels: THINKING_LEVELS,
    defaultThinkingLevel: "high",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek-V4-Pro",
    api: "deepseek-account-messages",
    baseUrl: MESSAGES_BASE,
    reasoning: true,
    input: ["text"],
    contextWindow: 1048576,
    maxTokens: 393216,
    thinkingLevels: THINKING_LEVELS,
    defaultThinkingLevel: "high",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
];

const DESCRIPTOR = {
  id: "deepseek-account",
  name: "DeepSeek Account",
  // 宿主要求带 refreshModels 的 provider 必须提供这个回调，否则注册直接抛错。
  // 它真正的生效时机是用户在设置页点「读取模型」：宿主走
  // refreshNativeProviderModels → requestExplicit(force) → 本回调，
  // 返回值会替掉运行期模型表。所以这里必须能拉到平台模型列表。
  refreshModels: true,
  auth: { oauth: { name: "DeepSeek", isSubscription: true, loginLabel: "登录 DeepSeek 帐号" } },
  models: MODELS,
};

/** 宿主规范化后的 provider id（`app:<appId>:<localId>`），诊断与查询都用它。 */
const PROVIDER_ID = "app:" + APP_ID + ":" + DESCRIPTOR.id;

let hostCtx = null;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 任何出站响应文本在进入错误信息前先脱敏，避免 token 顺着异常外泄。 */
function sanitize(text) {
  return String(text == null ? "" : text)
    .replace(/dsh_[A-Za-z0-9._-]+/g, "[redacted]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

function abortError(signal) {
  const reason = signal && signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("DeepSeek 帐号登录已取消。");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError(signal);
}

/** 诊断用：宿主会把未捕获异常吞成通用文案，所以关键节点自己留痕。 */
function log(message) {
  try {
    if (hostCtx && hostCtx.logger && typeof hostCtx.logger.info === "function") {
      hostCtx.logger.info("[hdsa] " + message);
    }
  } catch (_loggingUnavailable) {}
}

function describeError(error) {
  if (!error) return "(no error)";
  const message = error && error.message ? String(error.message) : String(error);
  const stack = error && error.stack ? String(error.stack).split("\n").slice(0, 5).join(" | ") : "";
  return message + (stack ? " :: " + stack : "");
}

// ---------------------------------------------------------------------------
// 平台 HTTP（auth_init / auth_exchange）
// ---------------------------------------------------------------------------

async function platformPost(method, body) {
  const res = await hostCtx.network.fetch(PLATFORM_ORIGIN + "/auth-api/v0/dsh/" + method, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-client-bundle-id": "",
      "x-client-platform": "web",
      "x-client-version": CLIENT_VERSION,
      "x-client-locale": "zh_CN",
      "x-client-timezone-offset": String(-new Date().getTimezoneOffset() * 60),
    },
    body: JSON.stringify(body),
    timeoutMs: 30000,
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_notJson) {
    json = null;
  }

  const code = json && typeof json.code === "number" ? json.code : null;
  const bizCode =
    json && json.data && typeof json.data.biz_code === "number" ? json.data.biz_code : null;

  if (!res.ok || code !== 0 || bizCode !== 0) {
    // 刻意不回显响应体：auth_exchange 的响应里可能带 token。
    throw new Error(
      "DeepSeek 平台 " +
        method +
        " 失败：HTTP " +
        res.status +
        "，code=" +
        (code === null ? "?" : code) +
        "，biz_code=" +
        (bizCode === null ? "?" : bizCode) +
        "。请稍后重试；若持续失败，请更新本应用或检查网络。"
    );
  }
  return json.data.biz_data;
}

async function deviceId() {
  const stored = await hostCtx.storage.global.get(DEVICE_KEY);
  if (typeof stored === "string" && stored) return stored;
  const fresh = randomUUID();
  await hostCtx.storage.global.set(DEVICE_KEY, fresh);
  return fresh;
}

// ---------------------------------------------------------------------------
// 受管 runtime：本机 OAuth 回调服务
// ---------------------------------------------------------------------------

async function waitServiceReady(runtimeId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let info = null;
    try {
      info = await hostCtx.runtime.get(runtimeId);
    } catch (_runtimeGone) {
      return false;
    }
    if (!info) {
      log("runtime.get returned nothing for " + runtimeId);
      return false;
    }
    if (info.service && info.service.state === "ready") {
      log("service ready on runtime " + runtimeId);
      return true;
    }
    if (info.state === "failed" || info.state === "exited" || info.state === "stopped") {
      log(
        "runtime " + runtimeId + " ended: state=" + info.state +
        " exitCode=" + String(info.exitCode) + " service=" + JSON.stringify(info.service || null)
      );
      return false;
    }
    await sleep(200);
  }
  return false;
}

/**
 * 本 App 的安装根。
 *
 * 约定：代码全部在 `bin/` 下（entry = bin/index.mjs，与 DSHana 的 bin/app.mjs 同形），
 * 根下只留 manifest / icon / LICENSE 这类契约件。所以这里要上两层：
 * bin/index.mjs → bin/ → 安装根。
 */
function installRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/**
 * 向系统要一个「此刻确实可绑」的回环端口号。
 *
 * 宿主对 service.port 的契约是「必须是声明的确定整数，不是子进程打印出来让宿主去猜的号」
 * （runtime.d.ts 里的原话：never a port a child printed and the host guessed），所以不能给 0。
 * 而盲选固定端口会撞上 Windows 的保留段（本机实测 53692–53696 全 EACCES）——
 * 只能让系统先分配一个，再把它当作声明值交出去。
 *
 * App 主进程没有 --allow-net，自己 bind 会 ERR_ACCESS_DENIED，所以走子进程探针：
 * 权限不继承，子进程显式带 --allow-net 就能 bind。
 *
 * 任何一环失败（探针缺失 / spawn 被拒 / 输出非法）返回 null，由调用方放弃。
 */
function probePort() {
  // 整段都包在 try 里：App 子进程开着 Node Permission Model，对许可根以外的路径
  // `existsSync` 不是返回 false，而是直接抛 ERR_ACCESS_DENIED。留在 try 外就会
  // 在 login 第一步就把整次登录炸掉，而且宿主会把原始异常吞成固定文案。
  try {
    const probePath = join(installRoot(), "bin", "port-probe.mjs");
    if (!existsSync(probePath)) {
      log("端口探针不在位：" + probePath);
      return null;
    }
    // 清掉 NODE_OPTIONS（Node 会把父进程的 --permission 重注入子进程），再显式给权限 flag。
    // 注意两个 flag 必须一起给：Node 26 上单给 `--allow-net` 会直接抛
    // ERR_MISSING_OPTION("--permission is required")，探针就永远拿不到号。
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const out = execFileSync(process.execPath, ["--permission", "--allow-net", probePath], {
      encoding: "utf8",
      timeout: PORT_PROBE_TIMEOUT_MS,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    // 只解析 stdout：`--allow-net` 在部分 Node 版本上会在 stderr 打 ExperimentalWarning，
    // 不影响结果（stdout 仍只有一行端口号）。
    const port = Number(String(out).trim());
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
    log("端口探针输出非法：" + JSON.stringify(String(out).slice(0, 40)));
    return null;
  } catch (error) {
    log("端口探针失败：" + describeError(error));
    return null;
  }
}

/** 起不来就返回 null，由调用方退回宿主的「粘贴回调 URL」路径，不让登录直接失败。 */
async function tryStartCallbackRuntime() {
  let lastReason = "";
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
    // 每一轮都重新要号：探针给出的只是「此刻可绑」，从探针退出到子进程 bind 之间
    // 仍可能被别的进程抢走，所以撞上了就换一个，不是重试同一个号。
    const port = probePort();
    if (!port) {
      lastReason = "拿不到可绑的回环端口";
      break;
    }
    let runtimeId = null;
    try {
      const info = await hostCtx.runtime.start({
        runtime: "node",
        entry: "bin/oauth-callback.mjs",
        // Windows 上 scoped 不可用。native 能起（enforcement: "partial"），但本机服务到不了就绪：
        // service.state 停在 "pending"，等不到就绪标记。
        // 因此用 local-machine：它以当前用户身份运行、无文件系统隔离（enforcement: "none"），
        // 但 loopback 服务正常（实测 0.4s 就绪）。
        profile: "local-machine",
        network: "external",
        args: [String(port)],
        service: { port, readyMarker: READY_MARKER, id: SERVICE_ID },
      });
      runtimeId = info && info.runtimeId ? info.runtimeId : null;
      log(
        "runtime.start port=" + port + " -> " + JSON.stringify({
          runtimeId: info && info.runtimeId,
          state: info && info.state,
          enforcement: info && info.enforcement,
          service: info && info.service,
        })
      );
      if (runtimeId && (await waitServiceReady(runtimeId, 15000))) {
        log("callback service up on port " + port);
        return { runtimeId, port };
      }
      lastReason = "端口 " + port + " 未能就绪";
    } catch (error) {
      lastReason = sanitize(error && error.message ? error.message : String(error));
      log("runtime.start failed port=" + port + ": " + describeError(error));
    }
    if (runtimeId) {
      await hostCtx.runtime.stop(runtimeId).catch(() => {});
      // 同名服务只在真正终止后才释放名字，等一拍再试下一轮。
      await sleep(300);
    }
  }
  log("no callback runtime available; falling back to host-native code paste. last=" + (lastReason || "unknown"));
  return null;
}

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------

function parseManualCode(raw, expectedState) {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) throw new Error("没有收到回调内容，登录已取消。");

  let code = null;
  let state = null;
  try {
    const url = new URL(text);
    code = url.searchParams.get("code");
    state = url.searchParams.get("state");
  } catch (_notUrl) {
    const stateMatch = /[?&]state=([^&#\s]+)/.exec(text);
    state = stateMatch ? decodeURIComponent(stateMatch[1]) : null;
    const codeAt = text.indexOf("code=");
    if (codeAt >= 0) {
      const rest = text.slice(codeAt + 5);
      const cut = rest.search(/[&#\s]/);
      code = decodeURIComponent(cut >= 0 ? rest.slice(0, cut) : rest);
    } else {
      code = text;
    }
  }

  if (!code) throw new Error("粘贴的内容里没有 code 参数，请粘贴完整回调地址。");
  if (state && state !== expectedState) {
    throw new Error("OAuth state 校验失败：粘贴的回调与本次登录不一致，已中止。");
  }
  return code;
}

async function waitForCode(options) {
  const interaction = options.interaction;
  const runtimeId = options.runtimeId;
  const expectedState = options.expectedState;
  const redirectUri = options.redirectUri;

  let finished = false;
  const promptControl = new AbortController();
  const relay = () => promptControl.abort();
  if (interaction.signal) {
    if (interaction.signal.aborted) throw abortError(interaction.signal);
    interaction.signal.addEventListener("abort", relay, { once: true });
  }

  const poll = runtimeId ? (async () => {
    while (!finished) {
      throwIfAborted(interaction.signal);
      let res = null;
      try {
        res = await hostCtx.runtime.fetch(runtimeId, "/status");
      } catch (error) {
        if (finished) return null;
        await sleep(500);
        continue;
      }
      let payload = null;
      try {
        payload = JSON.parse(await res.text());
      } catch (_badJson) {
        payload = null;
      }
      if (payload && payload.error) {
        throw new Error("本机 OAuth 回调失败：" + sanitize(String(payload.error)));
      }
      if (payload && typeof payload.code === "string" && payload.code) {
        if (payload.state !== expectedState) {
          throw new Error("OAuth state 校验失败：回调 state 与本次登录不一致，已中止。");
        }
        return payload.code;
      }
      await sleep(500);
    }
    return null;
  })() : new Promise(() => {});

  const manual = (async () => {
    const raw = await interaction.prompt({
      type: "manual_code",
      message: "若浏览器没有自动完成，把地址栏里的完整回调 URL 粘到这里：",
      // 宿主把那块输入框当等宽区、用于展示设备码，默认占位是 redirect_uri。
      // 放一串 `http://127.0.0.1:<port>/oauth/callback` 在界面上既冗长又容易被当成要填的内容，
      // 而正常路径下回调是自动完成的，这个输入框只是兜底。所以改成状态文案。
      placeholder: "等待授权",
      signal: promptControl.signal,
    });
    return parseManualCode(raw, expectedState);
  })();

  // 两条路都挂一个 no-op catch，避免落败分支后来 reject 变成 unhandled rejection。
  poll.catch(() => {});
  manual.catch(() => {});

  try {
    return await Promise.race([poll, manual]);
  } finally {
    finished = true;
    promptControl.abort();
    if (interaction.signal) interaction.signal.removeEventListener("abort", relay);
  }
}

async function login(interaction) {
  try {
    return await loginInner(interaction);
  } catch (error) {
    log("login failed: " + describeError(error));
    throw error;
  }
}

async function loginInner(interaction) {
  log("login start");
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());

  const callback = await tryStartCallbackRuntime();
  const runtimeId = callback ? callback.runtimeId : null;
  // 没有回调服务时仍要一个 redirect_uri 才能发起 login；再要一次号，占位意义仅在于
  // 「是个本机回环地址」，这一轮靠用户粘贴回调 URL 完成。万一探针也拿不到，
  // 用一个不在 Windows 保留段里的高号占位（EPHEMERAL 段之外），不让登录直接卡在这里。
  const port = callback ? callback.port : (probePort() || FALLBACK_PORT);
  try {
    const redirectUri = "http://127.0.0.1:" + port + CALLBACK_PATH;

    const init = await platformPost("auth_init", {
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      redirect_uri: redirectUri,
      locale: "zh_CN",
      login_source: "web",
    });

    if (!init || typeof init.authorize_url !== "string" || !init.authorize_url) {
      throw new Error("DeepSeek 平台 auth_init 没有返回 authorize_url。");
    }
    log("auth_init ok; authorize_url received");

    // 用 `device_code` 而不是 `auth_url` 来通知，是为了拿到宿主自己的「等待授权中…」
    // 且不渲染设备码区。两条路径的差别（bundle 133734-133740）：
    //   auth_url    : polling 只在 usesCallbackServer 为真时才置位，而 App provider 恒为 false
    //                 （publish 只传六个字段，不含它），所以只能靠 instructions 换取轮询，
    //                 代价是那句文案会被当成设备码渲染、还带「点击复制」。
    //   device_code : `P.polling = !0` 无条件置位，且 userCode 是空字符串时
    //                 `f && (p.instructions = f)` 因 falsy 而不写 instructions。
    // 结果是前端只收到 `{ sessionId, url, polling: true }`，落到 `h && !p && !u` 那一支，
    // 只渲染 i18n 的「等待授权中…」。
    //
    // 语义上这也更贴实情：这一步确实在等外面发生的事，本地输入框只是兜底。
    // verificationUri 必须是个合法 URL（宿主校验），它就是浏览器要打开的授权页。
    interaction.notify({
      type: "device_code",
      userCode: "",
      verificationUri: init.authorize_url,
    });

    log("device_code notified; waiting for code (runtime=" + String(runtimeId) + ")");
    const code = await waitForCode({ interaction, runtimeId, expectedState: state, redirectUri });
    if (!code) throw new Error("没有拿到授权码，登录未完成。");
    log("authorization code received");

    const exchanged = await platformPost("auth_exchange", {
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      device_id: await deviceId(),
      device_model: process.platform + "-" + process.arch,
      os_version: process.platform + " " + os.release(),
    });

    if (!exchanged || typeof exchanged.token !== "string" || !exchanged.token) {
      throw new Error("DeepSeek 平台 auth_exchange 没有返回 token。");
    }

    const credential = {
      type: "oauth",
      access: exchanged.token,
      refresh: "", // 平台不发 refresh token
      expires: Date.now() + 365 * 864e5,
    };
    await hostCtx.storage.global.set(CREDENTIAL_KEY, credential);
    return credential;
  } finally {
    if (runtimeId) await hostCtx.runtime.stop(runtimeId).catch(() => {});
  }
}

async function refresh(credential) {
  // 同步点：宿主取凭据时经同一套闸门（capability 断言 → isCurrent → 条目/回调），
  // 闸门拦下时这里不会响，可据此把“闸门拦人”与“我们的流有问题”分开。
  log("refresh called (sync)");
  // 契约里 storage.global.set 是同步返回 void，不是 Promise：不能对它 .catch()。
  try {
    hostCtx.storage.global.set(CREDENTIAL_KEY, credential);
  } catch (_storageUnavailable) {
    // 存不下也不该让宿主拿不到凭据；内存里的 credential 仍然有效。
  }
  return credential;
}

async function toAuth(credential) {
  // 诊断打点：宿主的 provider 适配器会先断言能力再进回调，此处只记形状，
  // 不落任何凭据内容（取值一律折算成布尔）。
  const shape = credential && typeof credential === "object"
    ? "type=" + String(credential.type) + " access=" + (typeof credential.access === "string" && credential.access.length > 0) +
      " refresh=" + (typeof credential.refresh === "string" && credential.refresh.length > 0) +
      " expires=" + (typeof credential.expires === "number" && Number.isFinite(credential.expires)) +
      " keys=" + Object.keys(credential).join(",")
    : "credential=" + String(credential);
  log("toAuth called (sync); " + shape);
  const auth = {
    baseUrl: MESSAGES_BASE,
    headers: {
      "x-dsh-auth-token": String(credential.access),
      "anthropic-version": "2023-06-01",
    },
  };
  log("toAuth returning; keys=" + Object.keys(auth).join(",") + " baseUrl=" + auth.baseUrl);
  return auth;
}

// ---------------------------------------------------------------------------
// 出站请求体
// ---------------------------------------------------------------------------

function toWireContent(block, forToolResult) {
  if (!block || typeof block !== "object") return null;
  if (block.type === "text") {
    return typeof block.text === "string" ? { type: "text", text: block.text } : null;
  }
  if (block.type === "image") {
    if (typeof block.data !== "string" || !block.data) return null;
    const mediaType = typeof block.mimeType === "string" && block.mimeType ? block.mimeType : "image/png";
    return { type: "image", source: { type: "base64", media_type: mediaType, data: block.data } };
  }
  if (forToolResult) return null;
  if (block.type === "thinking") {
    if (typeof block.thinking !== "string" || !block.thinking) return null;
    const out = { type: "thinking", thinking: block.thinking };
    if (typeof block.thinkingSignature === "string" && block.thinkingSignature) {
      out.signature = block.thinkingSignature;
    }
    if (block.redacted === true) out.redacted = true;
    return out;
  }
  if (block.type === "toolCall") {
    return {
      type: "tool_use",
      id: String(block.id),
      name: String(block.name),
      input: block.arguments && typeof block.arguments === "object" ? block.arguments : {},
    };
  }
  return null;
}

function toWireMessages(message) {
  if (!message || typeof message !== "object") return [];

  if (message.role === "user") {
    if (typeof message.content === "string") {
      return message.content ? [{ role: "user", content: message.content }] : [];
    }
    const blocks = [];
    for (const block of Array.isArray(message.content) ? message.content : []) {
      const wire = toWireContent(block, false);
      if (wire) blocks.push(wire);
    }
    return blocks.length ? [{ role: "user", content: blocks }] : [];
  }

  if (message.role === "toolResult") {
    const blocks = [];
    for (const block of Array.isArray(message.content) ? message.content : []) {
      const wire = toWireContent(block, true);
      if (wire) blocks.push(wire);
    }
    return [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: String(message.toolCallId),
            content: blocks.length ? blocks : [{ type: "text", text: "" }],
            is_error: message.isError === true,
          },
        ],
      },
    ];
  }

  if (message.role === "assistant") {
    const blocks = [];
    for (const block of Array.isArray(message.content) ? message.content : []) {
      const wire = toWireContent(block, false);
      if (wire) blocks.push(wire);
    }
    return blocks.length ? [{ role: "assistant", content: blocks }] : [];
  }

  return [];
}

function resolveEffort(options) {
  const requested = options && options.reasoning;
  if (requested === false) return "off";
  if (typeof requested === "string") {
    const value = requested.trim().toLowerCase();
    if (value === "off" || value === "none" || value === "disabled") return "off";
    if (value === "low" || value === "high" || value === "max") return value;
    if (value === "medium") return "high";
  }
  return "high";
}

function resolveMaxTokens(model, options) {
  const requested = options && options.maxTokens;
  if (typeof requested === "number" && Number.isFinite(requested) && requested > 0) {
    return Math.floor(requested);
  }
  return model.maxTokens;
}

function buildRequestBody(model, context, options) {
  const source = context && typeof context === "object" ? context : {};
  const messages = [];
  for (const message of Array.isArray(source.messages) ? source.messages : []) {
    for (const wire of toWireMessages(message)) messages.push(wire);
  }

  const body = {
    model: model.id,
    stream: true,
    messages,
    max_tokens: resolveMaxTokens(model, options),
  };

  if (typeof source.systemPrompt === "string" && source.systemPrompt) {
    body.system = source.systemPrompt;
  }

  const effort = resolveEffort(options);
  body.thinking = { type: effort === "off" ? "disabled" : "enabled" };
  if (effort !== "off") body.output_config = { effort };

  if (options && typeof options.temperature === "number" && Number.isFinite(options.temperature)) {
    body.temperature = options.temperature;
  }

  const tools = Array.isArray(source.tools) ? source.tools : [];
  if (tools.length) {
    body.tools = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }

  return body;
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

async function* sseLines(res) {
  const body = res && res.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let cut = buffer.indexOf("\n");
        while (cut >= 0) {
          const line = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 1);
          yield line.endsWith("\r") ? line.slice(0, -1) : line;
          cut = buffer.indexOf("\n");
        }
      }
      buffer += decoder.decode();
      if (buffer) yield buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
    } finally {
      if (typeof reader.releaseLock === "function") reader.releaseLock();
    }
    return;
  }
  // 宿主目前把 ctx.network.fetch 整体缓冲；没有流时退回整段文本。
  const text = typeof res.text === "function" ? await res.text() : "";
  for (const raw of text.split("\n")) {
    yield raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  }
}

const STOP_REASONS = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "toolUse",
  pause_turn: "stop",
  refusal: "stop",
};

function parseToolArguments(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_badJson) {
    return {};
  }
}

function hasToolCall(content) {
  for (const block of content) {
    if (block && block.type === "toolCall") return true;
  }
  return false;
}

function finalizeContent(content) {
  const out = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") {
      if (typeof block.text === "string" && block.text) out.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "thinking") {
      const keep = (typeof block.thinking === "string" && block.thinking) || block.redacted === true;
      if (!keep) continue;
      const copy = { type: "thinking", thinking: typeof block.thinking === "string" ? block.thinking : "" };
      if (typeof block.thinkingSignature === "string" && block.thinkingSignature) {
        copy.thinkingSignature = block.thinkingSignature;
      }
      if (block.redacted === true) copy.redacted = true;
      out.push(copy);
      continue;
    }
    if (block.type === "toolCall") {
      if (typeof block.id === "string" && block.id && typeof block.name === "string" && block.name) {
        out.push({
          type: "toolCall",
          id: block.id,
          name: block.name,
          arguments: block.arguments && typeof block.arguments === "object" ? block.arguments : {},
        });
      }
    }
  }
  return out;
}

function streamImpl(model, context, options) {
  // 普通函数（非 generator）：这个 log 在**调用当下同步执行**，用于区分
  // “RPC 没落到我们身上”和“返回的 AsyncIterable 过不了序列化”。
  log("streamImpl called (sync) model=" + String(model && model.id));
  return (async function* () {
    try {
      log("streamImpl entered (gen) model=" + String(model && model.id));
      yield* streamInner(model, context, options);
    } catch (error) {
      log("stream failed: " + describeError(error));
      throw error;
    }
  })();
}

async function* streamInner(model, context, options) {
  const stored = await hostCtx.storage.global.get(CREDENTIAL_KEY);
  const access = stored && typeof stored.access === "string" ? stored.access : "";
  if (!access) {
    throw new Error("尚未登录 DeepSeek 帐号：请先在「设置 → 模型」里完成登录。");
  }
  log(
    "stream start model=" + model.id + " provider=" + String(model.provider) +
    " baseUrl=" + String(model.baseUrl) +
    " msgs=" + (context && Array.isArray(context.messages) ? context.messages.length : -1) +
    " tools=" + (context && Array.isArray(context.tools) ? context.tools.length : 0)
  );

  let body = buildRequestBody(model, context, options);
  if (options && typeof options.onPayload === "function") {
    const replaced = await options.onPayload(body, model);
    if (replaced !== undefined) body = replaced;
  }

  const res = await hostCtx.network.fetch(model.baseUrl + "/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "text/event-stream",
      "anthropic-version": "2023-06-01",
      "x-dsh-auth-token": access,
    },
    body: JSON.stringify(body),
    signal: options ? options.signal : undefined,
    timeoutMs: 600000,
  });

  log("upstream HTTP " + res.status + " model=" + model.id);

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      // 上游 401 的响应体可能回显凭据片段，因此只给固定文案，不回显正文。
      throw new Error(
        "DeepSeek 帐号凭据已被拒绝（HTTP " + res.status + "）：请重新登录 DeepSeek 帐号。"
      );
    }
    let detail = "";
    try {
      detail = sanitize(await res.text());
    } catch (_unreadable) {
      detail = "";
    }
    throw new Error(
      "DeepSeek Messages 请求失败（HTTP " + res.status + "）。" + (detail ? " " + detail : "")
    );
  }

  const startedAt = Date.now();
  const content = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  const toolJson = new Map();
  let stopReason = "stop";
  let eventName = "";
  let dataLines = [];
  let started = false;

  const makeUsage = () => ({
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });

  const makePartial = (reason) => ({
    role: "assistant",
    content: content.map((block) => Object.assign({}, block)),
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: makeUsage(),
    stopReason: reason || "stop",
    timestamp: startedAt,
  });

  const applyUsage = (raw) => {
    if (!raw || typeof raw !== "object") return;
    if (typeof raw.input_tokens === "number" && Number.isFinite(raw.input_tokens)) {
      usage.input = raw.input_tokens;
    }
    if (typeof raw.output_tokens === "number" && Number.isFinite(raw.output_tokens)) {
      usage.output = raw.output_tokens;
    }
    if (typeof raw.cache_read_input_tokens === "number" && Number.isFinite(raw.cache_read_input_tokens)) {
      usage.cacheRead = raw.cache_read_input_tokens;
    }
    if (typeof raw.cache_creation_input_tokens === "number" && Number.isFinite(raw.cache_creation_input_tokens)) {
      usage.cacheWrite = raw.cache_creation_input_tokens;
    }
    usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  };

  for await (const line of sseLines(res)) {
    throwIfAborted(options ? options.signal : null);

    if (line === "") {
      if (!dataLines.length) {
        eventName = "";
        continue;
      }
      const payload = dataLines.join("\n");
      const name = eventName;
      dataLines = [];
      eventName = "";
      if (payload === "[DONE]") continue;

      let event = null;
      try {
        event = JSON.parse(payload);
      } catch (_badJson) {
        event = null;
      }
      if (!event || typeof event !== "object") continue;

      const type = typeof event.type === "string" ? event.type : name;
      if (type === "error" || name === "error") {
        const message =
          event.error && typeof event.error.message === "string"
            ? sanitize(event.error.message)
            : "上游返回 error 事件";
        throw new Error("DeepSeek Messages 流中断：" + message);
      }
      if (type === "ping") continue;

      if (type === "message_start") {
        applyUsage(event.message && event.message.usage);
        started = true;
        yield { type: "start", partial: makePartial("stop") };
        continue;
      }

      if (type === "content_block_start") {
        const index = event.index;
        const block = event.content_block || {};
        if (typeof index !== "number" || index < 0) continue;
        if (block.type === "text") {
          content[index] = { type: "text", text: typeof block.text === "string" ? block.text : "" };
        } else if (block.type === "thinking" || block.type === "redacted_thinking") {
          content[index] = {
            type: "thinking",
            thinking: typeof block.thinking === "string" ? block.thinking : "",
            ...(block.type === "redacted_thinking" ? { redacted: true } : {}),
          };
        } else if (block.type === "tool_use") {
          content[index] = {
            type: "toolCall",
            id: typeof block.id === "string" ? block.id : "",
            name: typeof block.name === "string" ? block.name : "",
            arguments: {},
          };
          toolJson.set(index, "");
        }
        continue;
      }

      if (type === "content_block_delta") {
        const index = event.index;
        const delta = event.delta || {};
        const block = typeof index === "number" ? content[index] : null;
        if (!block) continue;
        if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
          block.text = (typeof block.text === "string" ? block.text : "") + delta.text;
          yield { type: "text_delta", contentIndex: index, delta: delta.text, partial: makePartial("stop") };
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
          block.thinking = (typeof block.thinking === "string" ? block.thinking : "") + delta.thinking;
          yield {
            type: "thinking_delta",
            contentIndex: index,
            delta: delta.thinking,
            partial: makePartial("stop"),
          };
        } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
          block.thinkingSignature = delta.signature;
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          toolJson.set(index, (toolJson.get(index) || "") + delta.partial_json);
        }
        continue;
      }

      if (type === "content_block_stop") {
        const index = event.index;
        const block = typeof index === "number" ? content[index] : null;
        if (block && block.type === "toolCall") {
          block.arguments = parseToolArguments(toolJson.get(index));
          toolJson.delete(index);
          yield {
            type: "toolcall_end",
            contentIndex: index,
            toolCall: {
              type: "toolCall",
              id: block.id,
              name: block.name,
              arguments: block.arguments,
            },
            partial: makePartial("stop"),
          };
        }
        continue;
      }

      if (type === "message_delta") {
        const delta = event.delta || {};
        if (typeof delta.stop_reason === "string") {
          stopReason = STOP_REASONS[delta.stop_reason] || "stop";
        }
        applyUsage(event.usage);
        continue;
      }

      // message_stop 只是收尾信号，真正的事件在循环结束后统一发。
      continue;
    }

    if (line.startsWith(":")) continue; // SSE 注释 / keep-alive
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
      continue;
    }
  }

  if (!started) {
    yield { type: "start", partial: makePartial("stop") };
  }

  const blocks = finalizeContent(content);
  const reason = hasToolCall(blocks) && stopReason === "stop" ? "toolUse" : stopReason;
  const message = {
    role: "assistant",
    content: blocks,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: makeUsage(),
    stopReason: reason,
    timestamp: startedAt,
  };
  const textChars = blocks.reduce(
    (n, block) => n + (block && block.type === "text" ? String(block.text || "").length : 0),
    0
  );
  log("stream done reason=" + reason + " blocks=" + blocks.length + " textChars=" + textChars);
  yield { type: "done", reason, message };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 发现回调：宿主要求声明了 `refreshModels: true` 时必须有这个函数，否则注册直接抛错。
 *
 * **宿主从不主动调它。** 1.1.7-beta 的 bundle 里 `refreshModels` 出现 12 次，全是定义、
 * 描述符校验与 RPC 分发；`POST /api/providers/fetch-models` 的三个分支（registry / builtin /
 * hana-catalog）没有一个走这里。模型列表的实际来源是 DESCRIPTOR.models（即 MODELS）。
 *
 * 所以本函数只回那份表：平台出了新模型、改了限额或删了模型，**必须改 MODELS 并重发版**。
 * 不要在这里发请求演“自动发现”：那只会让人以为能自动更新，而实际上永远不执行。
 */
async function refreshModels() {
  log("refreshModels called（宿主当前不调，仅满足注册契约）");
  return { models: MODELS };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export const name = "hana-deepseek-account";

export default defineApp(async (sdk) => {
  hostCtx = sdk;
  await sdk.providers.register(DESCRIPTOR, {
    name: DESCRIPTOR.name,
    models: DESCRIPTOR.models,
    auth: { oauth: { login, refresh, toAuth } },
    refreshModels,
    stream: streamImpl,
    streamSimple: streamImpl,
  });
  log("apply done; provider registered");
  // 诊断：把本 App 的真实授权状态打出来。宿主在调用 provider 之前会先断言
  // app/provider.provide 与 app/provider.auth，未授予时异常会被吞成固定文案。
  try {
    const caps = await sdk.bus.request("app:capabilities", {});
    log("capabilities: " + JSON.stringify(caps));
  } catch (error) {
    log("capabilities probe failed: " + describeError(error));
  }
});
