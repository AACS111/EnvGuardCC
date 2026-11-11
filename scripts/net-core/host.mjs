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
import { lstat, realpath, readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createNetCore } from "../net-core.mjs";
import { findPortOwner, processCommandLine, processName } from "./ports.mjs";
import { createFirewallGuard } from "./firewall.mjs";
import { disableSystemIpv6, restoreSystemIpv6 } from "./system-ipv6.mjs";
import { assertStrictKernelConfig } from "./config.mjs";
import os from "node:os";

export const HOST_TOKEN_HEADER = "x-envguardcc-host-token";
const ACTIONS = new Set(["start", "stop", "restart", "heartbeat", "guard-status", "guard-block", "guard-activate", "guard-release", "ipv6"]);

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

// 特权进程不直接把用户可改写的文件路径交给内核：验证后复制到私有目录。
export async function readHostConfig(stateDir, requested) {
  const file = resolveConfigPath(stateDir, requested);
  if ((await lstat(path.join(stateDir, "net-core"))).isSymbolicLink()) throw new Error("内核配置目录不得是符号链接。");
  const root = await realpath(path.join(stateDir, "net-core"));
  const actual = await realpath(file);
  if (!actual.startsWith(root + path.sep) || (await lstat(file)).isSymbolicLink()) throw new Error("拒绝符号链接或真实路径逃逸的内核配置。");
  const info = await lstat(actual);
  if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error("内核配置必须是 4MB 以内的普通文件。");
  const raw = await readFile(actual, "utf8");
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error("内核配置过大。");
  const config = parseYaml(raw, { maxAliasCount: 100 });
  const fields = new Set(["mode", "log-level", "ipv6", "hosts", "sniffer", "mixed-port", "external-controller", "secret", "authentication", "tun", "dns", "proxies", "proxy-groups", "rules"]);
  if (!config || Array.isArray(config) || typeof config !== "object" || Object.keys(config).some(key => !fields.has(key))) throw new Error("特权宿主只接受 EGCC 生成的配置字段，禁止外部文件、脚本和 provider。");
  if (typeof config.secret !== "string" || config.secret.length < 32) throw new Error("特权内核必须配置控制器密钥。");
  return config;
}

export function createKernelHost({ token, binary, stateDir, apiPort = 39090, host = "127.0.0.1", port = 39091, spawn, fetchImpl, lookup, logger = () => {}, requiresAdmin = true, ports = {}, leaseTimeoutMs = 30000, ownerAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'ESRCH' ? false : null; }
}, createCore = createNetCore, systemIpv6 = { disable: disableSystemIpv6, restore: restoreSystemIpv6 }, firewall = createFirewallGuard() } = {}) {
  if (typeof token !== "string" || token.length < 16) throw new Error("宿主令牌太短。");
  if (typeof binary !== "string" || !binary) throw new Error("缺少内核二进制路径。");
  if (typeof stateDir !== "string" || !stateDir) throw new Error("缺少状态目录。");

  const portOwner = ports.portOwner ?? ((value) => findPortOwner(value));
  const ownerCommandLine = ports.processCommandLine ?? ((pid) => processCommandLine(pid));
  const ownerName = ports.processName ?? ((pid) => processName(pid));
  const killOwner = ports.kill ?? ((pid) => { try { process.kill(pid, "SIGKILL"); return true; } catch { return false; } });

  let core = null;
  let ipv6State = null;
  let ipv6Operation = Promise.resolve();
  let closing = false;
  let leaseAt = 0;
  let leaseOwner = null;
  let leaseSuspect = false;
  let leaseTimer;
  let monitoring = false;
  let lastGuardInspection = 0;
  let privateHome;
  let networkKey = "";
  const physicalNetwork = () => JSON.stringify(Object.entries(os.networkInterfaces()).filter(([name]) => name !== "utun90").map(([name, rows]) => [name, rows.filter(row => !row.internal).map(row => row.address).sort()]).sort());
  let operation = Promise.resolve();
  const serialize = (action) => {
    const next = operation.then(action);
    operation = next.catch(() => {});
    return next;
  };
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

  /** 由特权宿主执行 IPv6 系统开关：enabled=true 表示恢复系统 IPv6，false 表示关闭。 */
  async function applyIpv6(enabled) {
    if (enabled) {
      const state = ipv6State;
      ipv6State = null;
      if (!state) return { enabled: true, changed: false };
      try {
        const changed = await systemIpv6.restore(state);
        return { enabled: true, changed, service: state.service };
      } catch (error) {
        ipv6State = state;
        throw error;
      }
    }
    if (ipv6State) return { enabled: false, ...ipv6State };
    try { ipv6State = await systemIpv6.disable({ platform: process.platform }); }
    catch (error) { ipv6State = error.ipv6State ?? ipv6State; throw error; }
    return { enabled: false, ...ipv6State };
  }
  function queueIpv6(enabled) {
    const pending = ipv6Operation.then(() => applyIpv6(enabled));
    ipv6Operation = pending.catch(() => {});
    return pending;
  }

  async function start(configPath, strict = false, guardRevision = null) {
    if (!strict && firewall.status().armed) throw new Error("系统断流保护仍在生效，请先明确解除严格模式。");
    if (core) await core.stop();
    const leftover = await clearLeftoverKernel();
    if (leftover) logger(`[host] 已清理遗留内核 ${leftover}，释放端口 ${apiPort}。`);
    const config = await readHostConfig(stateDir, configPath);
    if (strict) { assertStrictKernelConfig(config); await firewall.arm(config, { expectedReleaseId: guardRevision }); }
    // mkdtemp 的 0700 目录由宿主所有；以后原文件被替换不影响本次验证过的快照。
    if (privateHome) await rm(privateHome, { recursive: true, force: true });
    privateHome = await mkdtemp(path.join(tmpdir(), "envguardcc-host-"));
    const snapshot = path.join(privateHome, "config.yaml");
    await writeFile(snapshot, stringifyYaml(config), { mode: 0o600 });
    core = createCore({ binary, homeDir: privateHome, configPath: snapshot, apiPort, secret: config.secret, spawn, fetchImpl, lookup, logger });
    await core.start();
    leaseAt = Date.now();
    networkKey = physicalNetwork();
    return { running: true, apiPort, clearedLeftover: leftover, guard: firewall.status() };
  }

  async function stop() {
    if (firewall.status().armed) await firewall.block("内核已停止，等待重新验证连接。");
    if (core) {
      await core.stop();
      core = null;
    }
    // 宿主可能跟丢了自己的 children（进程重启/异常退出）：此时 core 为 null，
    // 旧内核依旧占着端口并维持 TUN —— 必须按“确认属于本程序”的规则再清一次。
    // 否则用户关掉应用后流量仍在隧道里（实测事故）。
    const leftover = await clearLeftoverKernel();
    if (leftover) logger(`[host] 停止时清理了遗留内核 ${leftover}。`);
    if (privateHome) { await rm(privateHome, { recursive: true, force: true }); privateHome = null; }
    await queueIpv6(true).catch((error) => logger(`[host] 恢复 IPv6 失败：${error.message}`));
    return { running: false, clearedLeftover: leftover };
  }

  function send(response, status, body) {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(body));
  }

  const server = http.createServer(async (request, response) => {
    if (closing) { send(response, 503, { ok: false, reason: "宿主正在退出。" }); return; }
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
      send(response, 200, { ok: true, running: Boolean(core?.state().running), apiPort, requiresAdmin, guard: firewall.status(), hostProtocol: 3, capabilities: ["ipv6", "owner-lease"] });
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
    if (action === 'heartbeat') {
      if (!core?.state().running) { send(response, 409, { ok: false, code: 'KERNEL_NOT_RUNNING', reason: "内核未运行。" }); return; }
      if (leaseOwner && (value.leaseOwner?.id !== leaseOwner.id || value.leaseOwner?.pid !== leaseOwner.pid)) {
        send(response, 409, { ok: false, code: 'LEASE_MISMATCH', reason: '应用实例已变化，请重新连接宿主。' }); return;
      }
      leaseAt = Date.now();
      leaseSuspect = false;
      send(response, 200, { ok: true, guard: firewall.status() });
      return;
    }

    try {
      if (action === "ipv6") {
        send(response, 200, { ok: true, ...await queueIpv6(value.enabled === true) }); return;
      }
      if (action === "guard-status") { send(response, 200, { ok: true, guard: await firewall.inspect() }); return; }
      if (action === "guard-block") { send(response, 200, { ok: true, guard: await firewall.block() }); return; }
      if (action === "guard-release") { send(response, 200, { ok: true, guard: await firewall.release() }); return; }
      if (action === "guard-activate") {
        if (!core?.state().running) throw new Error("内核未运行，不能解除连接阻断。");
        send(response, 200, { ok: true, guard: await firewall.activate() }); return;
      }
      if (action === "stop") { send(response, 200, { ok: true, ...await serialize(stop) }); return; }
      const configPath = resolveConfigPath(stateDir, value?.configPath);
      if (value.leaseOwner && (!Number.isInteger(value.leaseOwner.pid) || value.leaseOwner.pid <= 0 || value.leaseOwner.pid > 2147483647 || typeof value.leaseOwner.id !== 'string' || !/^[\w-]{1,128}$/.test(value.leaseOwner.id))) throw new Error('无效的应用实例标识。');
      const result = await serialize(async () => {
        if (action === "restart") await stop();
        const started = await start(configPath, value.strict === true, value.guardRevision ?? null);
        leaseOwner = value.leaseOwner ? { pid: value.leaseOwner.pid, id: value.leaseOwner.id } : null;
        leaseSuspect = false;
        return started;
      });
      send(response, 200, { ok: true, ...result });
    } catch (error) {
      send(response, 500, { ok: false, reason: error.message });
    }
  });

  return {
    server,
    token,
    apiPort,
    async listen() {
      await firewall.restore();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      server.removeAllListeners("error");
      leaseTimer = setInterval(() => {
        if (monitoring) return;
        monitoring = true;
        void serialize(async () => {
          if (firewall.status().armed) {
            const current = physicalNetwork();
            if ((!core?.state().running && firewall.status().phase !== "blocked") || current !== networkKey) {
              await firewall.block("网卡或内核状态变化，保持阻断直到重新验证。");
              networkKey = current;
              lastGuardInspection = 0;
            }
            if (Date.now() - lastGuardInspection >= 5000) { await firewall.inspect(); lastGuardInspection = Date.now(); }
          }
          if (core && Date.now() - leaseAt > leaseTimeoutMs) {
            let alive = null;
            try { if (leaseOwner) alive = await ownerAlive(leaseOwner.pid); } catch { /* 无法确认时保留进程。 */ }
            if (!leaseOwner || alive === false) {
              logger('[host] 应用已退出或旧版租约过期，回收内核。');
              await stop();
            } else {
              if (!leaseSuspect) logger('[host] 应用心跳暂时失联，未确认应用退出，保留内核并等待重连。');
              leaseSuspect = true;
              leaseAt = Date.now();
            }
          }
        }).catch(error => logger(`[host] 租约回收失败：${error.message}`)).finally(() => { monitoring = false; });
      }, Math.min(1000, leaseTimeoutMs));
      leaseTimer.unref();
      return { url: `http://${host}:${server.address().port}`, port: server.address().port };
    },
    async close() {
      closing = true;
      try {
        await serialize(stop);
        clearInterval(leaseTimer);
        await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
      } catch (error) { closing = false; throw error; }
    },
    status: () => ({ running: Boolean(core?.state().running), apiPort, base }),
  };
}

// 命令行入口（由特权宿主调用）：
//   node scripts/net-core/host.mjs --state-dir <dir> --token-file <file> --binary <mihomo> [--api-port 39090] [--port 39091]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--recover-network")) {
    if (process.getuid?.() !== 0 || process.platform !== "darwin") throw new Error("网络恢复工具需要 macOS 管理员权限。");
    await createFirewallGuard().release();
    process.stderr.write("已解除 EGCC 系统断流规则；未修改其他 PF 规则。\n");
    process.exit(0);
  }
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
