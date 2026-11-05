// 特权内核宿主：以 SYSTEM（Windows 服务/计划任务）或 root（macOS LaunchDaemon）运行，
// 负责真正启动 mihomo —— 只有它能创建 TUN 虚拟网卡。
//
// 安全边界：
//   - 只监听 127.0.0.1；
//   - 每个请求都必须带随机令牌（timing-safe 比较）；
//   - 只接受固定动作，配置文件路径必须位于状态目录内，禁止路径逃逸；
//   - 不提供任意命令执行、文件读写或代理转发能力。

import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createNetCore } from "../net-core.mjs";
import { findPortOwner, processCommandLine, processName } from "./ports.mjs";

export const HOST_TOKEN_HEADER = "x-envguardcc-host-token";
const ACTIONS = new Set(["start", "stop", "restart"]);

function tokenMatches(expected, received) {
  if (typeof received !== "string" || !received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 配置路径必须落在状态目录的 net-core 子目录内，且不能是符号链接逃逸后的外部路径。 */
export function resolveConfigPath(stateDir, requested) {
  const root = path.resolve(stateDir, "net-core");
  const target = path.resolve(root, String(requested ?? "config.yaml"));
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error("配置文件必须位于状态目录内。");
  if (!target.endsWith(".yaml")) throw new Error("只允许加载 .yaml 配置。");
  return target;
}

export function createKernelHost({ token, binary, stateDir, apiPort = 39090, host = "127.0.0.1", port = 39091, spawn, fetchImpl, lookup, logger = () => {}, requiresAdmin = true, ports = {} } = {}) {
  if (typeof token !== "string" || token.length < 16) throw new Error("宿主令牌太短。");
  if (typeof binary !== "string" || !binary) throw new Error("缺少内核二进制路径。");
  if (typeof stateDir !== "string" || !stateDir) throw new Error("缺少状态目录。");

  const portOwner = ports.portOwner ?? ((value) => findPortOwner(value));
  const ownerCommandLine = ports.processCommandLine ?? ((pid) => processCommandLine(pid));
  const ownerName = ports.processName ?? ((pid) => processName(pid));
  const killOwner = ports.kill ?? ((pid) => { try { process.kill(pid, "SIGKILL"); return true; } catch { return false; } });

  let core = null;
  const base = `http://127.0.0.1:${apiPort}`;

  /**
   * 清掉上一次遗留的内核：宿主重启后 core 变成 null，但旧内核可能还占着端口，
   * 此时直接 spawn 新内核会因绑定失败秒退，宿主就永远报 running:false。
   * 只杀「确认属于本程序」的进程：FlClash 之类也可能叫 mihomo.exe，不能按名字杀。
   */
  async function clearLeftoverKernel() {
    const pid = await portOwner(apiPort).catch(() => null);
    if (!pid) return null;
    const command = await ownerCommandLine(pid).catch(() => null);
    const ours = typeof command === "string" && (command.includes(binary) || command.includes(stateDir));
    if (!ours) {
      throw new Error(`端口 ${apiPort} 已被进程 ${pid} 占用，且无法确认它是本程序的内核（${command ? "命令行不匹配" : "读不到命令行"}）；为避免误杀其它代理软件，宿主拒绝启动。`);
    }
    killOwner(pid);
    // 等到端口真的释放，否则新内核依旧绑不上。
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!await portOwner(apiPort).catch(() => null)) return pid;
    }
    throw new Error(`已尝试结束遗留内核 ${pid}，但端口 ${apiPort} 仍被占用（${await ownerName(pid).catch(() => null) ?? "未知进程"}）。`);
  }

  async function start(configPath) {
    if (core) await core.stop();
    const leftover = await clearLeftoverKernel();
    if (leftover) logger(`[host] 已清理遗留内核 ${leftover}，释放端口 ${apiPort}。`);
    core = createNetCore({ binary, homeDir: path.dirname(configPath), configPath, apiPort, spawn, fetchImpl, lookup, logger });
    await core.start();
    return { running: true, apiPort, clearedLeftover: leftover };
  }

  async function stop() {
    if (core) {
      await core.stop();
      core = null;
    }
    // 宿主可能跟丢了自己的 children（进程重启/异常退出）：此时 core 为 null，
    // 旧内核依旧占着端口并维持 TUN —— 必须按“确认属于本程序”的规则再清一次。
    // 否则用户关掉应用后流量仍在隧道里（实测事故）。
    const leftover = await clearLeftoverKernel().catch((error) => {
      logger(`[host] 停止时清理遗留内核失败：${error.message}`);
      return null;
    });
    if (leftover) logger(`[host] 停止时清理了遗留内核 ${leftover}。`);
    return { running: false, clearedLeftover: leftover };
  }

  function send(response, status, body) {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(body));
  }

  const server = http.createServer(async (request, response) => {
    const remote = request.socket.remoteAddress;
    if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
      send(response, 403, { error: "只允许本机访问。" });
      return;
    }
    if (!tokenMatches(token, request.headers[HOST_TOKEN_HEADER])) {
      send(response, 401, { error: "缺少或错误的宿主令牌。" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      send(response, 200, { ok: true, running: Boolean(core), apiPort, requiresAdmin });
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/kernel") {
      send(response, 404, { error: "未知接口。" });
      return;
    }
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      if (Buffer.byteLength(body) > 8192) { send(response, 413, { error: "请求体过大。" }); return; }
    }
    let value;
    try { value = JSON.parse(body || "{}"); }
    catch { send(response, 400, { error: "无效的 JSON。" }); return; }
    const action = value?.action;
    if (!ACTIONS.has(action)) { send(response, 400, { error: "未知动作。" }); return; }

    try {
      if (action === "stop") { send(response, 200, { ok: true, ...await stop() }); return; }
      const configPath = resolveConfigPath(stateDir, value?.configPath);
      await access(configPath);
      if (action === "restart") await stop();
      send(response, 200, { ok: true, ...await start(configPath) });
    } catch (error) {
      send(response, 500, { ok: false, reason: error.message });
    }
  });

  return {
    server,
    token,
    apiPort,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      server.removeAllListeners("error");
      return { url: `http://${host}:${server.address().port}`, port: server.address().port };
    },
    async close() { await stop(); await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }); },
    status: () => ({ running: Boolean(core), apiPort, base }),
  };
}

// 命令行入口（由特权宿主调用）：
//   node scripts/net-core/host.mjs --state-dir <dir> --token-file <file> --binary <mihomo> [--api-port 39090] [--port 39091]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { readFile, writeFile, mkdir } = await import("node:fs/promises");
  const { randomBytes } = await import("node:crypto");
  const argv = process.argv.slice(2);
  const flag = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  const stateDir = flag("state-dir");
  const tokenFile = flag("token-file");
  const binary = flag("binary");
  if (!stateDir || !tokenFile || !binary) {
    process.stderr.write("[host] 缺少 --state-dir / --token-file / --binary\n");
    process.exit(1);
  }
  let token;
  try {
    token = (await readFile(tokenFile, "utf8")).trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    token = randomBytes(32).toString("hex");
    await mkdir(path.dirname(tokenFile), { recursive: true });
    await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
    process.stderr.write(`[host] 已生成宿主令牌：${tokenFile}\n`);
  }
  const host = createKernelHost({
    token, binary, stateDir,
    apiPort: Number(flag("api-port", "39090")),
    port: Number(flag("port", "39091")),
    logger: (line) => process.stderr.write(`[host] ${line}\n`),
  });
  const { url } = await host.listen();
  process.stderr.write(`[host] 监听 ${url}\n`);
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { void host.close().finally(() => process.exit(0)); });
}
