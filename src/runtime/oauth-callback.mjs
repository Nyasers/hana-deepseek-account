// Hana DeepSeek Account — 受管 runtime 里的本机 OAuth 回调服务
//
// 纯 node:http，无依赖。App 子进程自己没有监听能力，所以这段代码由宿主用
// profile: "local-machine" 起在受管 runtime 里，只监听 127.0.0.1。
//
// 安全约定：不把 code / state 写进 stdout、stderr 或任何磁盘文件；
// 回调结果只留在内存里，由 App 主进程经 ctx.runtime.fetch("/status") 取走。
// stdout 上唯一允许打印的固定串是就绪标记 DEEPSEEK_OAUTH_READY。

import http from "node:http";

const READY_MARKER = "DEEPSEEK_OAUTH_READY";
const CALLBACK_PATH = "/oauth/callback";
const MAX_QUERY_LENGTH = 8192;

const portArg = Number.parseInt(process.argv[2] ?? "", 10);
const port = Number.isInteger(portArg) && portArg >= 1024 && portArg <= 65535 ? portArg : 53692;

// 内存态：pending -> 已收到一次回调（成功或失败）-> 之后一律 410。
let result = null;

function html(body) {
  return (
    "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>DeepSeek 帐号登录</title>" +
    "<style>body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;padding:48px 24px;" +
    "background:#f6f7fb;color:#1f2430;display:flex;justify-content:center}" +
    "main{max-width:32rem;background:#fff;border-radius:14px;padding:32px 28px;" +
    "box-shadow:0 8px 28px rgba(20,30,70,.10)}h1{font-size:1.25rem;margin:0 0 12px}" +
    "p{line-height:1.7;margin:0 0 8px;color:#48506b}</style>" +
    "<body><main>" +
    body +
    "</main></body></html>"
  );
}

function sendHtml(res, status, body) {
  const payload = Buffer.from(html(body), "utf8");
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(payload.byteLength),
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

function sendJson(res, status, value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.byteLength),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

function sendEmpty(res, status) {
  res.writeHead(status, { "cache-control": "no-store" });
  res.end();
}

function single(searchParams, name) {
  const all = searchParams.getAll(name);
  return all.length === 1 && all[0] ? all[0] : null;
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url ?? "/", "http://127.0.0.1");
  } catch (_badUrl) {
    sendEmpty(res, 400);
    return;
  }

  if (req.method !== "GET") {
    sendEmpty(res, 405);
    return;
  }

  if (url.pathname === "/status") {
    if (result === null) {
      sendJson(res, 200, { pending: true });
      return;
    }
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname !== CALLBACK_PATH) {
    sendEmpty(res, 404);
    return;
  }

  if (url.search.length > MAX_QUERY_LENGTH) {
    sendEmpty(res, 414);
    return;
  }

  // 只接受第一次回调。
  if (result !== null) {
    sendEmpty(res, 410);
    return;
  }

  const code = single(url.searchParams, "code");
  const state = single(url.searchParams, "state");
  const errorCode = single(url.searchParams, "error");

  if (errorCode) {
    result = { error: "平台返回授权错误：" + errorCode.slice(0, 64) };
    sendHtml(
      res,
      200,
      "<h1>登录未完成</h1><p>DeepSeek 平台返回了授权错误，请回到 Hana 重试。</p>"
    );
    return;
  }

  if (!code) {
    result = { error: "回调缺少 code 参数" };
    sendHtml(res, 200, "<h1>登录未完成</h1><p>回调缺少授权码，请回到 Hana 重试。</p>");
    return;
  }

  result = state ? { code, state } : { code };
  sendHtml(
    res,
    200,
    "<h1>登录成功</h1><p>DeepSeek 帐号已授权。可以关闭这个标签页，回到 Hana 继续。</p>"
  );
});

server.on("error", () => {
  // 端口冲突等失败：不打印任何含状态/凭据的内容，直接以非零码退出，
  // 让宿主把这次 runtime 判为 failed，App 会换下一个端口重试。
  process.exitCode = 1;
  server.close(() => process.exit(1));
});

server.listen(port, "127.0.0.1", () => {
  // 就绪标记必须精确出现在 stdout 上，宿主才认这个服务。
  process.stdout.write(READY_MARKER + "\n");
});

// 被宿主停止时干净退出。
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
