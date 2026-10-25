# Hana DeepSeek Account — DeepSeek 帐号 Hana Provider App

把 DeepSeek 帐号登录接进 HanaAgent，作为一个**原生模型提供方**（`contributes.nativeProviders`）。

> 命名：`id` 与目录都是 `hana-deepseek-account`（Hana 自身器官走 `hana-` 族，参照 `hana-builder`；app id 只允许小写字母、数字、点、下划线、单连字符），显示名 `Hana DeepSeek Account`，日志标记是 `hdsa`。

源码在 `src/`，构建产出 `dist/`（它本身就是安装根，不再套 `<id>/` 一层）。SDK 走裸包名 `@hana/app-sdk/server`（devDependency，真身是 vendor 里的 tgz），构建期由 esbuild 内联；安装包里没有 `sdk/`，也没有任何需要现场解析的裸包名。

```
pnpm install
pnpm run release        # build + pack，产物落 releases/
```

| 命令 | 作用 |
| --- | --- |
| `pnpm run build` | esbuild 把 `src/index.mjs` 与内联的 SDK 打成 `dist/bin/index.mjs`（压缩） |
| `pnpm run pack` | 把 `dist/` 打成 zip + 市场 entry，落 `releases/` |
| `pnpm run release` | 上面两步 |
| `pnpm run check` | 只校验交付树（断言文件齐备、无裸包名），不写产物 |
| `pnpm run icon` | 把 `icon.svg` 光栅化成 `assets/icon-256.png`（entry 用） |
| `pnpm run sync:vendor:sdk` | 宿主升级后同步 vendor 里的 SDK 快照 |

打包脚本是自建的（`scripts/pack.mjs`），不复用宿主那套 `extension-pack.mjs`：后者除 zip 外还会产出市场投稿 metadata，且它的 `entry.json` 里的图标需要 sharp 现转。本实现只用 `node:zlib` / `node:crypto`，**CI 里无任何外部依赖**：那张 256×256 图标是 `assets/icon-256.png`，随仓库提交（改图标时跑一次 `pnpm run icon`）。

`minAppVersion` 在 build 时从 `vendor/hana-app-sdk/source-manifest.json` 的 `packedVersion` **现场写入产物**，不靠人手同步：SDK 快照是哪个宿主版本打的，就要求哪个宿主版本。两处数字一旦不一致，宿主要么直接拒装，要么让老宿主跑起一个用新接口写的 App。

许可证是 MPL-2.0（见 `LICENSE`，随包分发），SPDX 标识也写进 entry 的 `license` 字段。

不把 SDK 解包成 `sdk/` 塞进包：那份手抄快照会随宿主升级静默漂移（实测已落后，缺 `media:generate-speech`），且把一个构建期依赖变成了源码树的一部分。

---

## 1. 这是什么

- **一个 OAuth 登录流程**：DeepSeek 平台 PKCE（S256）+ 本机 loopback 回调，回调服务跑在宿主受管 runtime 里。
- **一个原生 provider**：把 `streamSimple(model, context, options)` 的 payload 翻译成 DeepSeek Messages（Anthropic 兼容）SSE，再翻译回宿主消费的流事件。
- 提供两个模型：`deepseek-flash`（DeepSeek-V41-Flash）、`deepseek-v4-pro`（DeepSeek-V4-Pro）。

### 文件

| 文件 | 作用 |
| --- | --- |
| `manifest.json` | v2 清单；`contributes.nativeProviders` 里的 descriptor 与 `index.mjs` 里 `ctx.providers.register` 传的逐字段一致 |
| `icon.svg` | 顶层身份图标：静态 SVG，无 script/animation/@import/外链 |
| `LICENSE` | MPL-2.0 许可文本（随包分发） |
| `src/index.mjs` | 入口：`defineApp` 注册 provider，含 `login` / `refresh` / `toAuth` / `stream` / `streamSimple` |
| `src/runtime/oauth-callback.mjs` | 受管 runtime 里的本机回调服务（纯 `node:http`）；产物落 `bin/` |
| `src/bin/port-probe.mjs` | 端口探针：`bind(0)` 向系统要一个此刻可绑的回环端口 |
| `build.mjs` | esbuild 构建 → `dist/` |
| `scripts/pack.mjs` | 自建打包（zip + entry）→ `releases/` |
| `assets/icon-256.png` | entry 用的 256×256 图标（`pnpm run icon` 生成，随仓库提交） |
| `releases/*.zip` | 可安装包（不进 git） |

### 装法

把 `releases/hana-deepseek-account-v0.1.0.zip` 装上（市场或宿主 HTTP 的本地安装流程 stage → confirm）。也可以直接把 `dist/` 当安装目录用。

安装后需要在 **设置 → 应用 → 应用能力** 里授予：

- `app/provider.provide`（注册原生 provider）
- `app/provider.auth`（本 App 的认证生命周期）
- `app/runtime.execute`（起受管 runtime）
- `app/runtime.local-machine`（Windows 上 `scoped` 不可用；`native` 需一次性管理员初始化，故不用。见 §3.1）
- `app/runtime.network`（见下面 §3.1，**实测必须**）
- `app/process.spawn`（端口探针是子进程：主进程没有 `--allow-net`，自己 bind 会被拒）

并在 **设置 → 模型** 里完成一次「登录 DeepSeek 帐号」。

---

## 2. 结论清单

### 2.1 已跑通（有实测证据）

| 项 | 证据 |
| --- | --- |
| `validate_app.mjs --dir --json` | `{"ok":true,"issues":[],"summary":{"errors":0,"warnings":0}}`，exit 0 |
| `validate_app.mjs --archive --json` | `{"ok":true,"issues":[],"summary":{"errors":0,"warnings":0}}`，exit 0 |
| `scripts/pack.mjs` 取代宿主打包器 | 宿主那套 `pack_app.mjs` 产出 `dist-extensions/`；本项目用自建脚本 → `releases/` |
| `auth_init` 真实探针 | HTTP 200，`code=0 / biz_code=0`，拿到 `authorize_url`；**`x-client-version: "0.1.0"` 被平台接受** |
| 假 token 打 `/v1/messages` | HTTP 401，`{"error":{"message":"Authentication Fails (invalid dsh token) ...","type":"authentication_error",...}}` |
| `oauth-callback.mjs` 独立起得来 | `node bin/oauth-callback.mjs <port>`，stdout 精确输出 `DEEPSEEK_OAUTH_READY` |
| `/status` 行为 | 未回调时 `200 {"pending":true}`；收到回调后 `200 {"code":"...","state":"..."}` |
| `/oauth/callback` 行为 | 首次 `200 text/html`；重复请求 `410`；未知路径 `404` |
| 流事件映射 | 用假宿主跑通 6 个事件（`start` / `thinking_delta` / `text_delta`×2 / `toolcall_end` / `done`），**逐个通过宿主 `FWr` 等价校验** |
| 出站请求体 | 生成的 body 与 `dsh-llm-deepseek` 的 `serialize()` 同形（`stream` / `thinking` / `output_config.effort` / `input_schema` / `tool_result`） |
| 登录编排 | 假宿主下验证：PKCE challenge/verifier 各 43 字符、`state` 独立、`device_code` 通知、回调 runtime 在 `finally` 里停掉、探针拿不到号时降级为粘贴兜底、state 不匹配即失败 |
| `refresh` / `toAuth` | `refresh` 原样返回并回写 storage；`toAuth` 回 `{ baseUrl, headers: { "x-dsh-auth-token", "anthropic-version" } }` |
| thinking 历史回传 | 带 `thinkingSignature` 的 thinking 块、toolCall、`is_error` 的 tool_result 都正确落到 wire body |
| 图片输入 | `{type:"image",data,mimeType}` → `{type:"image",source:{type:"base64",media_type,data}}` |

### 2.2 真机验证（用户参与，已通过）

| 项 | 结果 |
| --- | --- |
| **真实登录** | 通过。浏览器授权 → 本机回调接住 code → `auth_exchange` 落库 |
| **真实推理** | 通过。日志：`toAuth` → `streamImpl` → `stream start` → `upstream HTTP 200` → `stream done reason=stop` |
| `--smoke` | 通过，`backend.status = "loaded"` |
| 受管 runtime 就绪与端口 | 通过。探针要号 → `service ready`（0.4s 量级），多轮登录稳定 |
| 端到端 `streamSimple` | 通过。宿主真实消费了流事件，会话正常产出回复 |

仍然**只能靠用户参与**的部分：首次授权必须有人在浏览器里点同意。自动化测不了那一步。

---

## 3. 实现要点与踩坑

这一节记的是「看上去能行、实际不行」的那些地方。每一条都是实测或读码确认过的，不是推测。

### 3.1 runtime profile 只能用 `local-machine`

`native` / `local-machine` 都强制要求 `network: "external"`（宿主硬校验）；而 Windows 上 `supportsLoopback` 恒为 `false`，所以 `loopback` 也不成立。

`native` 在 Windows 上还需要一次性**管理员**初始化本机沙箱身份：

```
hana-win-sandbox.exe --initialize-native-identity --native-identity-home <HANA_HOME>
```

未初始化时 `runtime.start` 直接失败（Win32 740）。所以本 App 用 `local-machine`（能力词换成 `app/runtime.local-machine`，不再要 `app/runtime.native`）。

> 代价（如实记）：`local-machine` 的 `enforcement` 是 `none`——这个受管进程以**当前用户身份**运行、**没有文件系统隔离**。它实际只监听 `127.0.0.1` 并转交一次回调。换回 `native` 能收紧，代价是每台机器做一次管理员初始化。

### 3.2 `storage.global.set` 是同步返回 void，不是 Promise

`context.d.ts` 里是 `readonly set: (key: string, value: unknown) => void`。

所以 `await set(...).catch(...)` 会抛 `TypeError: Cannot read properties of undefined (reading 'catch')`。已经改用 `try { set(...) } catch {}`。

### 3.3 `toolcall_end` 的 `toolCall` 必须带 `type: "toolCall"`

宿主校验器要求 `t.toolCall.type !== "toolCall"` 就判非法，整个事件被拒并抛 `App provider emitted an invalid or oversized stream event`。已按校验器补上。

### 3.4 `minAppVersion` 跟 SDK 快照走

不手写。build 时从 `vendor/hana-app-sdk/source-manifest.json` 的 `packedVersion` 写进产物。
当前值 `1.1.111-beta`。手写的风险是两处数字会漂：宿主要么按旧值放行一个用新接口写的 App（运行期才报错），要么按新值拒装本可以跑的包。

### 3.5 错误信息绝不回显响应体

`auth_exchange` 的成功响应里含 `token`，失败响应也可能回显请求片段；`/v1/messages` 的 401 message 里确实带 `****robe` 这样的 key 片段。

所以平台调用失败时只回 `HTTP status + code + biz_code`，401 用固定文案指向「重新登录」。这与 §4.4 的安全约定同一条线。

### 3.6 两个次要观察（未改，记录备查）

- **`network.allowLocalhost: true` 用不上。** `ctx.network.fetch` 只打两个公网域名；回调服务走 `ctx.runtime.fetch`（受管服务代理），不经 manifest 的 `network` 白名单。想收紧可以删掉这个键，不影响功能。
- **`cost` 全 0 是占位，不是「免费」。** DeepSeek 没公开这两个模型的单价，所以四个字段都是 0。用量统计里的费用列会显示 0，**不代表不花钱**；真实计费以平台账单为准。

---

## 4. 协议与实现要点

### 4.1 登录

```
App                         宿主受管 runtime              DeepSeek 平台
 |--- port-probe ----------->  子进程 bind(0) 要一个可绑端口
 |--- runtime.start --------->| 监听那个 127.0.0.1:<port>
 |--- POST auth_init -------->|                              | (PKCE S256)
 |<-- authorize_url ---------|<-----------------------------|
 |--- notify(device_code) -->  用户浏览器打开并同意
 |                             |<-- GET /oauth/callback?code=...&state=...
 |--- runtime.fetch /status ->|  (轮询，500ms)
 |<-- { code, state } --------|
 |--- POST auth_exchange ---->|                              | (code_verifier)
 |<-- token ------------------|<-----------------------------|
 |--- storage.global.set("credential") ; runtime.stop() ------|
```

降级：探针拿不到号或服务起不来时，仍会用一个占位 `redirect_uri` 发起 `auth_init`，
同时挂一个 `manual_code` prompt 让用户粘贴完整回调 URL；谁先到用谁，另一路取消。

### 4.2 为什么 token 的事实源是 App 自己

宿主调 App provider 的 `streamSimple(model, context, options)` 时**不会把凭据传进来**（`options` 里只有 `signal` / `onPayload` / `reasoning` / `maxTokens` / `temperature` / `sessionId` / `toolChoice` / `transport` / `cacheRetention` / `thinkingBudgets` / `timeoutMs` / `maxRetries` 等，没有 `apiKey` / `headers`）。

所以 `login` 与 `refresh` 都写 `ctx.storage.global`，`stream` 从这里读。`login` 仍然把 credential 返回给宿主，让宿主记认证状态。

### 4.3 事件映射

| DeepSeek Messages SSE | yield 的宿主事件 |
| --- | --- |
| `message_start` | `{ type: "start", partial }` |
| `content_block_start`(text/thinking/tool_use) | 只建块，不发事件 |
| `content_block_delta` `text_delta` | `{ type: "text_delta", contentIndex, delta, partial }` |
| `content_block_delta` `thinking_delta` | `{ type: "thinking_delta", ... }` |
| `content_block_delta` `signature_delta` | 存进该块的 `thinkingSignature` |
| `content_block_delta` `input_json_delta` | 累积进 `arguments` |
| `content_block_stop`(tool_use) | `{ type: "toolcall_end", contentIndex, toolCall: { type:"toolCall", id, name, arguments }, partial }` |
| `message_delta.stop_reason` | `end_turn`→`stop`、`max_tokens`→`length`、`tool_use`→`toolUse` |
| `error` | 抛错（不伪装成正常结束） |
| `message_stop` / 流结束 | `{ type: "done", reason, message }` |

SSE 解析处理跨 chunk 半行、`event:`/`data:` 行、`:` 注释、`ping`、`[DONE]`。

`done.message` 里 `api` / `provider` / `model` 分别取 `model.api` / `model.provider`（宿主给的规范身份，不自己编）/ `model.id`。

### 4.4 安全约定

- token / authorization code **不写任何日志、错误文本、磁盘文件**。唯一落点是 `ctx.storage.global` 的 `credential` 键。
- `bin/oauth-callback.mjs` 的 stdout 上只有就绪标记 `DEEPSEEK_OAUTH_READY`，回调结果只在内存里，由 App 经 `ctx.runtime.fetch("/status")` 取走。
- 出站错误文本一律脱敏；401/403 只给固定文案（上游 401 的 message 会回显 key 片段，已实测）。
- 不读 DSH 的 `.credentials.yaml` 或任何别的 App 的数据目录。
- 不在 App 进程里 `import("node:http")` 或 `listen`；一律走受管 runtime。

---

## 5. 验证命令与回执

校验器在 `H:\.hanako\skills\hana-app-creator\scripts\`，`HANA_APP_TOOLS_ROOT` 指向当前宿主安装目录
（如 `H:\.hanako\artifacts\server\1.1.111-beta-win32-x64-…`）。这一节是**本地验证**，CI 不需要。

```powershell
pnpm run release                    # build + pack → releases/

$env:HANA_APP_TOOLS_ROOT = 'H:\.hanako\artifacts\server\<当前版本>'
node validate_app.mjs --dir dist --json
node validate_app.mjs --dir dist --json --smoke
node validate_app.mjs --archive releases\hana-deepseek-account-v0.1.0.zip --json
```

> `--dir` 传的是 `dist` 而不是仓库根：校验器要求 `manifest.id` 等于目录名。

### `--dir --json` 回执（原样）

```json
{"ok":true,"issues":[],"summary":{"errors":0,"warnings":0}}
```

（完整回执含 `manifest` / `normalizedIcon` / `uiRoutes`；`normalizedIcon.warnings` 为空。）

### `--smoke` 回执（原样）

```json
"smoke":{"ok":true,"issues":[],"backend":{"status":"loaded","error":null},"surfaces":[],"document":{"status":"not-tested"}}
```

`backend.status = "loaded"` = 宿主在隔离 AppHost 里真实加载了本产物的后端。

### 打包产物

| 文件 | 说明 |
| --- | --- |
| `releases/hana-deepseek-account-v0.1.0.zip` | 可安装包（zip 根 = 包根；版本带 `v`，与 DSHana 的 `dshana-v<ver>.zip` 同形） |
| `releases/app-hana-deepseek-account-0.1.0.entry.json` | 市场 entry（只有它带 `app-` 前缀；`archive.url` 中的 `{{BASE_URL}}` 由发布侧替换） |

zip 内含 6 个文件：`manifest.json` / `icon.svg` / `LICENSE`，以及 `bin/` 下的
`index.mjs` / `oauth-callback.mjs` / `port-probe.mjs`。
代码全部收在 `bin/`（与 DSHana 的 `bin/app.mjs` + `bin/dsh.mjs` 同形），根下只留契约件。
`README.md` 与 `SPEC.md` / `STATUS.md` 不进包：前两者是仓库文档，后两者是本地工作档。

同一份输入两次构建的 zip 字节一致（固定 DOS 时间戳），可用 SHA256 核对。

---

## 6. 局限

- 只在 Windows 上验过。Windows 上 `scoped` 不可用；`native` 需要一次性管理员初始化（见 §3.1），未初始化时 `runtime.start` 直接失败（真宿主实测）。
- 因此 App 用 `profile: "local-machine"`：不需要管理员初始化，但该受管进程以当前用户身份运行、没有文件系统隔离（`enforcement: "none"`）。
- **回调端口必须现问系统要**：`53692–53696` 在本机全落在 Windows 保留段里（`bind` 返 `EACCES`），写死端口会让回调服务起不来。所以用子进程探针 `bind(0)` 现要一个。
- 回调服务起不来时**降级**为宿主原生的「粘贴回调 URL」路径，登录不会因此直接失败。
- **设置页的 provider 摘要看不到本 App**：`/providers/summary` 的遍历集合是 `getAllProvidersRaw()`，
  而它来自配置文件（`provider-catalog` / `auth-storage`），**不包含 App provider**；App provider 的元数据
  握在 `ctx.providers.register()` 那一侧。对比 `getChatModelEntries()` 走
  `getChatModelSelection()` → `resolveChatProvider()`，是能解析到 App provider 的。
  所以同一个 provider 在聊天模型选择器里可选，在摘要页里不可见。
- **provider 图标显示为占位方块**：宿主前端把 `provider → SVG` 的映射硬编码在
  `ActionFeedbackIcons-*.js` 里，按 provider id 精确匹配；我们的 id 是
  `app:hana-deepseek-account:deepseek-account`，匹配不上。而 App provider descriptor 的字段白名单
  （`id/name/models/auth/refreshModels/filterModels/fetchDeferred/cancelDeferred`）没有图标位。
  白名单是**硬拒**：`validateAppProviderDescriptorV2()` 遇到未知字段直接抛
  `Unknown App provider descriptor field: <key>`，`icon` / `iconUrl` / `iconSvg` 实测全部被拒。
  同一份 descriptor 里模型层（`AppProviderModelV2`）反而有索引签名、允许自定义字段，两层严格度不一致。
