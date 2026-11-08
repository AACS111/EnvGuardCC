// mihomo 内核主管：进程生命周期、外部控制器 API、健康巡检与重启。
// 与 EnvGuardCC 现有桌面后台一致，失败一律"关闭"而不是"降级继续"：
// 拿不到内核状态时，调用方应把审计判为未通过并停止受保护客户端。

import { spawn as nodeSpawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import dns from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { inIpv4Range } from "./net-core/config.mjs";
import { findPortOwner, processName } from "./net-core/ports.mjs";
import { fileURLToPath } from "node:url";

const LOOPBACK = "127.0.0.1";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function encodePath(value) {
  return encodeURIComponent(String(value));
}

/**
 * @param {object} options
 * @param {string} options.binary 内核可执行文件路径（绝对路径）
 * @param {string} options.homeDir 内核工作目录（-d）
 * @param {string} options.configPath 配置文件路径（-f）
 * @param {number} [options.apiPort] 外部控制器端口
 * @param {string} [options.secret] 外部控制器密钥
 * @param {number} [options.readyTimeoutMs] 就绪等待上限
 * @param {number} [options.maxRestarts] 连续自动重启次数上限
 * @param {Function} [options.spawn] 注入口，便于测试
 * @param {Function} [options.fetchImpl] 注入口，便于测试
 * @param {Function} [options.logger] 日志（只写 stderr/文件，不写 stdout）
 */
export function createNetCore({
  binary,
  homeDir,
  configPath,
  apiPort = 9090,
  secret = "",
  readyTimeoutMs = 20000,
  maxRestarts = 3,
  // 生产必须开启：仅有 API 可用不代表虚拟网卡真的建立（非管理员时内核会空跑）。
  // 允许传函数：运行时可随时开关 TUN，校验也跟着变。
  verifyTunnel = false,
  // 由特权宿主托管时，本进程只等 API 就绪，不负责 spawn/kill。
  manageProcess = true,
  // 端口归属探查（测试可注入）。
  portOwner = (port) => findPortOwner(port),
  portOwnerName = (pid) => processName(pid),
  lookup = (host, options) => dns.lookup(host, options),
  spawn = nodeSpawn,
  fetchImpl = globalThis.fetch,
  logger = () => {},
} = {}) {
  if (typeof binary !== "string" || !binary) throw new Error("缺少内核可执行文件路径。");
  if (typeof homeDir !== "string" || !homeDir) throw new Error("缺少内核工作目录。");
  if (typeof configPath !== "string" || !configPath) throw new Error("缺少内核配置文件路径。");
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) throw new Error("外部控制器端口无效。");

  const wantsTunnel = () => (typeof verifyTunnel === "function" ? Boolean(verifyTunnel()) : Boolean(verifyTunnel));
  let child = null;
  let ready = false;
  let stopping = false;
  let exitInfo = null;
  let restarts = 0;
  let restarting = null;
  let operation = Promise.resolve();
  const exits = new WeakMap();
  const kernelPids = new WeakMap();
  const serialize = (action) => (...values) => {
    const next = operation.then(() => action(...values));
    operation = next.catch(() => {});
    return next;
  };

  const base = `http://${LOOPBACK}:${apiPort}`;
  const authHeaders = () => (secret ? { Authorization: `Bearer ${secret}` } : {});

  /** 隧道活性：fake-ip 生效时，系统解析必须落在 fake-ip 段，否则说明 TUN 未接管。 */
  async function tunnelStatus({ host = "claude.ai", waitMs = 0 } = {}) {
    const deadline = Date.now() + waitMs;
    for (;;) {
      let timer;
      try {
        // 固定域名可能命中开启 TUN 前的系统缓存；默认 getaddrinfo 还可能优先返回 AAAA。
        // 新子域 + 显式 A 查询验证当前 DNS 路径，不清空全系统缓存。
        const probeHost = `egcc-${randomUUID()}.${host}`;
        const answer = await Promise.race([
          lookup(probeHost, { family: 4 }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("隧道解析探测超时。")), 4000); }),
        ]);
        const address = String(answer?.address ?? answer ?? "");
        const result = { active: inIpv4Range(address), host, address };
        if (result.active || Date.now() >= deadline) return result;
      } catch (error) { if (Date.now() >= deadline) throw error; }
      finally { clearTimeout(timer); }
      await delay(250);
    }
  }

  function args() {
    // -d 工作目录、-f 配置、-ext-ctl 外部控制器监听地址。
    return ["-d", homeDir, "-f", configPath, "-ext-ctl", `${LOOPBACK}:${apiPort}`];
  }

  function pipeLines(stream, label) {
    if (!stream?.on) return;
    let buffer = "";
    stream.setEncoding?.("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) logger(`${label}: ${line.trim()}`);
    });
  }

  function wire(next) {
    next.on?.('message', message => {
      if (message?.type === 'kernel-pid' && Number.isInteger(message.pid) && message.pid > 0) kernelPids.set(next, message.pid);
    });
    next.on?.("exit", (code, signal) => {
      exits.set(next, { code, signal });
      if (child !== next) return;
      exitInfo = { code, signal };
      ready = false;
      if (!stopping) logger(`内核进程退出（code=${code ?? "null"} signal=${signal ?? "null"}）`);
    });
    next.on?.("error", (error) => {
      if (!next.pid) exits.set(next, { error: error?.message });
      if (child !== next) return;
      exitInfo = { code: null, signal: null, error: error?.message ?? String(error) };
      ready = false;
      logger(`内核进程错误：${exitInfo.error}`);
    });
    pipeLines(next.stderr, "kernel");
    pipeLines(next.stdout, "kernel");
  }

  async function request(pathname, { method = "GET", body } = {}) {
    const response = await fetchImpl(`${base}${pathname}`, {
      method,
      headers: { ...authHeaders(), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`内核接口 ${method} ${pathname} 返回 ${response.status}。`);
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async function waitReady() {
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (exitInfo) throw new Error(`内核启动失败（退出码 ${exitInfo.code ?? "null"}${exitInfo.error ? `，${exitInfo.error}` : ""}）。`);
      try {
        const version = await request("/version");
        if (version?.version) {
          ready = true;
          return version;
        }
      } catch {
        // 内核尚未监听端口，继续等待。
      }
      await delay(200);
    }
    throw new Error("内核就绪超时，请检查内核配置或端口占用。");
  }

  async function launch() {
    if (!manageProcess) {
      await waitReady();
      if (wantsTunnel()) {
        const tunnel = await tunnelStatus({ waitMs: 4000 });
        if (!tunnel.active) {
          ready = false;
          throw new Error(`隧道未接管：新的 IPv4 查询未返回 fake-ip（${tunnel.address || "空"}）。请检查助手日志、系统 DNS 或其他 VPN 的冲突。`);
        }
      }
      return;
    }
    if (child && ready) return;
    stopping = false;
    exitInfo = null;
    await mkdir(homeDir, { recursive: true });
    // 上一个内核没退干净时，新内核会因端口冲突秒退，然后被误判成「未就绪」。
    // 这里先把真相说清楚：端口上到底是谁，而不是让用户去猜。
    const ownerPid = await portOwner(apiPort).catch(() => null);
    if (ownerPid) {
      const ownerName = await portOwnerName(ownerPid).catch(() => null);
      throw new Error(`外部控制器端口 ${apiPort} 已被进程 ${ownerPid}${ownerName ? `（${ownerName}）` : ""} 占用；多半是上一个内核未退出。请先结束该进程或换端口，不要把它当成「内核已就绪」。`);
    }
    logger(`启动内核：${binary} ${args().join(" ")}`);
    const guardian = fileURLToPath(new URL('./net-core/guardian.cjs', import.meta.url));
    const next = spawn(process.execPath, [guardian, binary, ...args()], { stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true });
    child = next;
    wire(next);
    try {
      await waitReady();
      // 就绪不等于「我们养的那台就绪」：端口被别的内核占着时，等待也会「成功」，
      // 但那台内核不归我们管，停它/重启它/读它都是假象。
      if (!next.pid) throw new Error("内核进程未返回 PID，无法确认接管者。");
      if (exitInfo) throw new Error(`内核启动失败（退出码 ${exitInfo.code ?? "null"}${exitInfo.error ? `，${exitInfo.error}` : ""}）。`);
      if (wantsTunnel()) {
        const tunnel = await tunnelStatus({ waitMs: 4000 });
        if (!tunnel.active) throw new Error(`隧道未接管：${tunnel.host} 解析为 ${tunnel.address || "空"}，不在 fake-ip 段；请确认内核具备 TUN 权限。`);
        logger(`隧道已接管：${tunnel.host} → ${tunnel.address}`);
      }
      logger("内核已就绪。");
    } catch (error) {
      await terminate();
      throw error;
    }
  }

  async function terminate() {
    if (!manageProcess) { ready = false; child = null; return; }
    const current = child;
    ready = false;
    if (!current) return;
    try {
      if (current.stdin?.end) current.stdin.end();
      else current.kill?.();
    } catch {
      // 已经退出。
    }
    const deadline = Date.now() + 5000;
    while (!exits.has(current) && Date.now() < deadline) await delay(50);
    if (!exits.has(current)) {
      try {
        current.kill?.("SIGKILL");
      } catch {
        // 进程已经消失。
      }
      const forcedDeadline = Date.now() + 2000;
      while (!exits.has(current) && Date.now() < forcedDeadline) await delay(50);
    }
    if (!exits.has(current)) throw new Error(`内核 ${current.pid ?? "未知 PID"} 未确认退出，拒绝报告停止成功。`);
    const kernelPid = kernelPids.get(current);
    if (kernelPid) {
      let alive = false;
      try { process.kill(kernelPid, 0); alive = true; }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      if (alive) throw new Error(`内核 ${kernelPid} 仍在运行，守护进程退出不代表内核已停止。`);
    }
    child = null;
    exitInfo = null;
  }

  /** 手动启动会重置自动重启计数；自动恢复走 launch()，不重置。 */
  async function start() {
    restarts = 0;
    return launch();
  }

  async function stop() {
    stopping = true;
    await terminate();
    logger("内核已停止。");
  }

  async function restart() {
    if (restarting) return restarting;
    restarting = (async () => {
      restarts += 1;
      logger(`内核重启（第 ${restarts} 次）。`);
      await terminate();
      await launch();
      return status();
    })().finally(() => {
      restarting = null;
    });
    return restarting;
  }

  /** 健康巡检：返回内核是否可用；不可用时按上限自动重启，超出上限返回 false。 */
  async function health() {
    if (stopping) return false;
    if (ready) {
      try {
        const version = await request("/version");
        if (version?.version) {
          if (!wantsTunnel()) return true;
          const tunnel = await tunnelStatus();
          if (tunnel.active) return true;
          logger(`隧道失效：${tunnel.host} → ${tunnel.address || "空"}`);
          ready = false;
        }
      } catch {
        ready = false;
      }
    }
    if (restarts >= maxRestarts) {
      logger("内核连续重启超出上限，停止自动恢复。");
      return false;
    }
    try {
      await restart();
      return ready;
    } catch (error) {
      logger(`内核重启失败：${error.message}`);
      return false;
    }
  }

  async function status() {
    if (!ready) throw new Error("内核未就绪。");
    const [version, connections, proxies] = await Promise.all([
      request("/version"),
      request("/connections"),
      request("/proxies"),
    ]);
    return {
      running: ready,
      version: version?.version ?? null,
      connections,
      proxies,
      restarts,
    };
  }

  async function selectProxy(group, name) {
    if (typeof name !== "string" || !name) throw new Error("缺少节点名称。");
    // 幂等：已经是当前节点时直接成功。mihomo 对“选中自身”会返回 400 proxy not exist。
    const current = await request(`/proxies/${encodePath(group)}`).catch(() => null);
    if (current?.now === name) return true;
    try {
      await request(`/proxies/${encodePath(group)}`, { method: "PUT", body: { name } });
      return true;
    } catch (error) {
      // 实测：部分内核版本首次加载后选择器内部列表为空，PUT 会返回 400；
      // 重新加载同一份配置即可重建选择器，但重载是异步完成的，必须等待并重试。
      if (!/返回 400/.test(error.message)) throw error;
      const payload = await readFile(configPath, "utf8");
      await request("/configs?force=true", { method: "PUT", body: { payload } });
      let lastError = error;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await delay(300);
        try {
          await request(`/proxies/${encodePath(group)}`, { method: "PUT", body: { name } });
          return true;
        } catch (retryError) { lastError = retryError; }
      }
      throw lastError;
    }
  }

  async function reload(payload) {
    if (typeof payload !== "string" || !payload.includes("rules:")) throw new Error("拒绝加载无效配置。");
    await request("/configs?force=true", { method: "PUT", body: { payload } });
    logger("内核配置已热加载。");
    return true;
  }

  /**
   * 热加载磁盘上的配置，并恢复各选择器原来的节点。
   * mihomo 重载会把 select 组重置成第一个节点，不恢复的话「换了 DNS」会顺手把出口也换掉。
   */
  async function reloadFromFile({ removedSelectors = [] } = {}) {
    // 读不到当前选择时不得把默认选择当成原选择继续重载。
    const before = await request("/proxies");
    const selections = Object.entries(before?.proxies ?? {})
      .filter(([group, value]) => group !== "GLOBAL" && value?.type === "Selector" && typeof value.now === "string" && value.now)
      .map(([group, value]) => [group, value.now]);
    const candidate = parseYaml(await readFile(configPath, "utf8"));
    // 调用方可明确移除不再使用的组（例如其他直连模式的 AUTO-PROXY）；
    // 仍存在的组必须保持原节点，不能借此忽略选择器损坏。
    const retained = selections.filter(([group]) => !removedSelectors.includes(group) || candidate?.["proxy-groups"]?.some(item => item?.name === group));
    for (const [group, name] of retained) {
      if (group === "GLOBAL") continue; // 内核自动生成的虚拟组，不属于用户配置。
      const selector = candidate?.["proxy-groups"]?.find(item => item?.name === group && item.type === "select");
      if (!selector || !selector.proxies?.includes(name)) throw new Error(`拒绝重载：选择器 ${group} 的原节点 ${name} 已不存在，请显式选择新出口。`);
      // 将原节点编译为默认值，消除“先重载成第一个节点再 PUT 恢复”的窗口。
      selector.proxies = [name, ...selector.proxies.filter(item => item !== name)];
    }
    const payload = stringifyYaml(candidate);
    await request("/configs?force=true", { method: "PUT", body: { payload } });
    for (const [group, name] of retained) {
      if (group === "GLOBAL") continue;
      // 重载是异步完成的，选择器列表可能还没就绪，按 selectProxy 的经验重试几次。
      let restored = false;
      for (let attempt = 0; attempt < 5 && !restored; attempt += 1) {
        if (attempt) await delay(250);
        const actual = await request(`/proxies/${encodePath(group)}`).catch(() => null);
        restored = actual?.now === name;
      }
      if (!restored) {
        ready = false;
        throw new Error(`配置重载后选择器 ${group} 未保持原出口，拒绝报告成功。`);
      }
    }
    logger(`内核配置已热加载，选择器恢复 ${retained.length} 个。`);
    return retained.length;
  }

  function state() {
    return { running: ready, pid: child ? (kernelPids.get(child) ?? child.pid ?? null) : null, supervisorPid: child?.pid ?? null, restarts, exit: exitInfo };
  }

  return { start: serialize(start), stop: serialize(stop), restart: serialize(restart), health: serialize(health), status, selectProxy, reload, reloadFromFile, request, tunnelStatus, state, args };
}
