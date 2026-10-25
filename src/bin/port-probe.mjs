// bin/port-probe.mjs — 向系统要一个「此刻确实可绑」的回环端口号，打到 stdout。
//
// 为什么要探针而不是盲选固定端口：宿主对 service.port 的契约是「必须是声明的确定整数，
// 不是子进程打印出来让宿主去猜的号」，所以不能直接给 0。而盲选会撞上 Windows 的保留段和
// Hyper-V / WSL 占用的区间，落进去就是 EACCES（本机实测 53692–53696 全部不可绑）。
// bind(0) 拿到的号由系统保证可用，这是唯一可靠来源。
//
// 为什么必须单独成进程：App 主进程受 Node Permission Model 约束，没有 --allow-net，
// server.listen() 直接 ERR_ACCESS_DENIED。而它 spawn 出去的子进程权限不继承，
// 显式带上 --allow-net 就能 bind。
//
// 输出协议：成功时 stdout 恰好一行端口号；失败时 stderr 一行原因、退出码 1。
// 不输出别的东西——调用方按整行解析，多余日志会污染结果。
import { createServer } from "node:net";

const server = createServer();
server.once("error", (error) => {
  process.stderr.write(String(error?.code ?? error) + "\n");
  process.exit(1);
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  server.close(() => {
    if (port > 0) {
      process.stdout.write(port + "\n");
      process.exit(0);
    }
    process.stderr.write("bind(0) 未返回端口\n");
    process.exit(1);
  });
});
