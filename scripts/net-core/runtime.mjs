// 内核运行时封装：把"是否启用、用哪个二进制、用哪些节点、当前路由证据"收敛成一个对象。
// 供 scripts/dev.mjs、desktop/backend.mjs 与网关导入接口共用。
//
// 规则：
//   - 没有二进制、没有节点、环境变量显式关闭，都返回可读原因，而不是假装可用；
//   - 导入节点后必须重建配置并重启内核，否则界面会显示旧节点；
//   - 导入失败不覆盖已有节点配置。

import { access, mkdir, mkdtemp, readFile, writeFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { DEFAULT_AUTO_GROUP, DEFAULT_FAKE_IP_RANGE, DEFAULT_GROUP, CLAUDE_GUARD_GROUP, DEFAULT_ROUTE_EXCLUSIONS, LOCAL_DIRECT_PROXY, assertKernelConfig, buildKernelConfig, ingressSummary, inIpv4Range, serializeKernelConfig, strictKernelConfig } from "./config.mjs";
import { migrateStore, pickActive, publicSources, removeSource, renameSource, serializeStore, upsertSource } from "./sources.mjs";
import { isClaudeHost, listConnections, routingEvidence, routingSummary } from "./routes.mjs";
import { publicDnsForCountry, resolvePublicDns } from "./public-dns.mjs";
import { fetchSubscription, fetchTextViaProxy, normalizeProxies, parseSubscription } from "./subscription.mjs";
import { elevationStatus } from "./privilege.mjs";
import { findPortOwner } from "./ports.mjs";
import { loadVerifiedNodeHosts, resolveNodeHosts } from "./node-dns.mjs";
import { createNetCore } from "../net-core.mjs";
import { createNetworkTakeover } from "./takeover.mjs";
import { createConnectionLog } from "./connection-log.mjs";
import { assertClaudeSupportedExit, claudeRegionSupport } from "../../src/detection/claude-regions.mjs";
import { isHostingExit } from "../../src/detection/exit-quality.mjs";
import { disableSystemIpv6, restoreSystemIpv6 } from "./system-ipv6.mjs";
import { checkHostHealth, hostInstallDecision, HOST_PROTOCOL } from "./host-protocol.mjs";

const DEFAULT_API_PORT = 39090;

/** 用户网络声明的字段白名单；未知字段会让内核启动失败，所以读写两侧共用同一份。 */
const NETWORK_FIELDS = ["directDomains", "dnsServers", "directInterface", "dnsInterface", "strictRoute", "routeExcludeAddresses"];
// 试算用占位节点：未配置节点时仍要能校验字段，但占位节点绝不会被写进真实配置。
const VALIDATION_NODE = { name: "validation-only", type: "ss", server: "127.0.0.1", port: 1, cipher: "aes-128-gcm", password: "validation-only" };

export function networkConfigPath(stateDir, env = process.env) {
  return env.CHECKCC_NET_CORE_NETWORK_CONFIG || path.join(stateDir, "net-core-network.json");
}

/** 可选的用户内网配置；显式指定的文件缺失或内容损坏时拒绝静默回退。 */
export async function loadLocalNetworkConfig(stateDir, env = process.env) {
  const explicit = env.CHECKCC_NET_CORE_NETWORK_CONFIG;
  const file = networkConfigPath(stateDir, env);
  try {
    const config = JSON.parse(await readFile(file, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("配置必须是 JSON 对象");
    if (Object.keys(config).some((key) => !NETWORK_FIELDS.includes(key))) throw new Error("仅支持 directDomains、dnsServers、directInterface、dnsInterface、strictRoute 和 routeExcludeAddresses 字段");
    return config;
  } catch (error) {
    if (!explicit && error.code === "ENOENT") return {};
    throw new Error(`读取内网配置失败（${file}）：${error.message}`, { cause: error });
  }
}

/**
 * 保存前试算：走与启动完全相同的生成 + 不变量校验路径。
 * 因此界面永远写不出「内核拒绝启动」的配置，错误也在保存时给出具体原因。
 */
export function validateNetworkConfig(config, { proxies = null } = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("配置必须是 JSON 对象。");
  const unknown = Object.keys(config).filter((key) => !NETWORK_FIELDS.includes(key));
  if (unknown.length) throw new Error(`不支持的字段：${unknown.join("、")}。`);
  const nodes = Array.isArray(proxies) && proxies.length ? proxies : [VALIDATION_NODE];
  const built = buildKernelConfig({ proxies: nodes, selected: nodes[0].name, egressMode: "rule", localNetwork: config });
  assertKernelConfig(built, { egressMode: "rule", strictRoute: config.strictRoute ?? true });
  return built;
}

/** 原子写入用户网络配置：先写临时文件再 rename；校验失败时调用方不会走到这里。 */
export async function saveLocalNetworkConfig(stateDir, config, env = process.env) {
  const file = networkConfigPath(stateDir, env);
  const temporary = `${file}.${process.pid}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return file;
}

/** 可选网卡：排除回环与内核自己的 TUN 网卡（地址落在 Fake-IP 段）。 */
export function listNetworkInterfaces(networkInterfaces = () => os.networkInterfaces()) {
  const result = [];
  for (const [name, addresses] of Object.entries(networkInterfaces() ?? {})) {
    const ipv4 = (addresses ?? []).find((entry) => entry.family === "IPv4" && !entry.internal);
    if (!ipv4 || inIpv4Range(ipv4.address, DEFAULT_FAKE_IP_RANGE)) continue;
    result.push({ name, address: ipv4.address });
  }
  return result.sort((left, right) => left.name.localeCompare(right.name));
}

/** 把用户输入翻译成真实产物：界面展示「实际生效了什么」，而不是复述输入。 */
export function describeNetworkConfig(config, { proxies = null } = {}) {
  const built = validateNetworkConfig(config, { proxies });
  const target = config.directInterface ? LOCAL_DIRECT_PROXY : "DIRECT";
  const addresses = Array.isArray(config.routeExcludeAddresses) ? config.routeExcludeAddresses : [];
  // 落在默认私网段里的地址只是冗余，不是错误：界面标注、不拦保存。
  const redundancy = addresses.flatMap((value) => {
    const address = String(value).split("/")[0];
    const coveredBy = DEFAULT_ROUTE_EXCLUSIONS.find((cidr) => inIpv4Range(address, cidr));
    return coveredBy ? [{ value: String(value), coveredBy, address }] : [];
  });
  const redundantHosts = new Set(redundancy.map((item) => item.address));
  return {
    target,
    domainRules: (config.directDomains ?? []).map((domain) => `DOMAIN-SUFFIX,${String(domain).trim().toLowerCase()},${target}`),
    // 只列「用户新增且真正改变了路由」的 IP 规则：默认私网规则与冗余项不重复罗列。
    ipRules: built.rules.filter((rule) => {
      if (!rule.startsWith("IP-CIDR,") || !rule.endsWith(`,${target}`)) return false;
      const payload = rule.split(",")[1];
      return !DEFAULT_ROUTE_EXCLUSIONS.includes(payload) && !redundantHosts.has(payload.split("/")[0]);
    }),
    nameserverPolicy: built.dns["nameserver-policy"],
    fakeIpFilter: built.dns["fake-ip-filter"],
    dnsServers: built.dns["direct-nameserver"],
    // 默认排除段由后端给出，界面只做展示性覆盖判断，不复制一份 CIDR 表。
    defaultExclusions: [...DEFAULT_ROUTE_EXCLUSIONS],
    // 落在默认私网段里的地址只是冗余，不是错误：界面标注、不拦保存。
    redundantAddresses: redundancy.map(({ value, coveredBy }) => ({ value, coveredBy })),
  };
}

/** 解析结果归一化：只收 A 记录，并标出假地址（说明该域名仍在走代理）。 */
export function summarizeDnsAnswer(answer, { name = "", restarted = false, elapsedMs = 0 } = {}) {
  const addresses = (Array.isArray(answer?.Answer) ? answer.Answer : [])
    .filter((row) => row?.type === 1 && typeof row.data === "string")
    .map((row) => row.data);
  return {
    name,
    status: Number(answer?.Status ?? -1),
    addresses,
    fakeIp: addresses.some((address) => inIpv4Range(address, DEFAULT_FAKE_IP_RANGE)),
    restarted,
    elapsedMs,
  };
}

/** 稳定指纹：用于判断「已保存但尚未重启生效」，不受键顺序影响。 */
function fingerprintNetwork(config) {
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    return value;
  };
  return JSON.stringify(stable(config ?? {}));
}

export function kernelBinaryName(platform = process.platform) {
  return platform === "win32" ? "mihomo.exe" : "mihomo";
}

export function nodesFilePath(stateDir) {
  return path.join(stateDir, "net-nodes.json");
}

/**
 * 节点配置文件：{ version: 2, sources: [...], activeId }。
 * 旧版只有 { proxies, selected, source }，读取时迁移成一条隐式供应商，写回时升级格式。
 */
export async function loadNodes(stateDir) {
  const file = nodesFilePath(stateDir);
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    const store = migrateStore(raw);
    if (!store.proxies.length) return { state: "empty", file, ...store };
    return { state: "ready", file, ...store };
  } catch (error) {
    if (error.code === "ENOENT") return { state: "missing", file };
    return { state: "invalid", file, reason: error.message };
  }
}

/** 原子写入节点配置：供应商快照是唯一真相，active 快照写回顶层供旧代码只读。 */
export async function saveNodes(stateDir, { sources = [], activeId = null, proxyServerDns = null }) {
  const file = nodesFilePath(stateDir);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const content = `${JSON.stringify(serializeStore({ sources, activeId, proxyServerDns }), null, 2)}\n`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return file;
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** 按优先级解析内核二进制：显式环境变量 → 状态目录 → 仓库内已校验产物。 */
export async function resolveKernelBinary({ stateDir, env = process.env, platform = process.platform, root } = {}) {
  const name = kernelBinaryName(platform);
  const candidates = [
    env.CHECKCC_NET_CORE_BINARY,
    stateDir ? path.join(stateDir, "kernel", name) : null,
    root ? path.join(root, "node_modules", ".checkcc-kernel", name) : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

function demoNodes() {
  return [
    { name: "演示节点 A（不可用）", type: "ss", server: "127.0.0.1", port: 9, cipher: "aes-128-gcm", password: "demo" },
    { name: "演示节点 B（不可用）", type: "ss", server: "127.0.0.1", port: 9, cipher: "aes-128-gcm", password: "demo" },
  ];
}

/**
 * @param {object} options
 * @param {string} options.stateDir 状态目录（节点与运行配置都写在这里）
 * @param {object} [options.env]
 * @param {Function} [options.logger]
 * @param {Function} [options.spawn] / [options.fetchImpl] / [options.lookup] 注入点，便于测试
 * @param {string} [options.platform]
 * @param {string} [options.root]
 */
export async function createKernelRuntime({ stateDir, env = process.env, root, logger = () => {}, spawn, fetchImpl, lookup, download, createCore = createNetCore, takeover, claudeProxy = null, interfaces = () => os.networkInterfaces(), healthScheduler = { every: setInterval, clear: clearInterval }, systemIpv6 = { disable: disableSystemIpv6, restore: restoreSystemIpv6 }, ipv6Fetch = fetchTextViaProxy, exitFetch = fetchTextViaProxy, platform = process.platform } = {}) {
  const binary = await resolveKernelBinary({ stateDir, env, platform, root });
  const networkTakeover = takeover ?? createNetworkTakeover({ platform, ownBinary: binary });
  // 特权宿主模式：优先用显式环境变量；否则尝试读取安装器写入的令牌并探测宿主健康。
  // 探测失败就回退本机 spawn，避免"装了但没跑起来"时整个网络面板不可用。
  let hostUrl = env.CHECKCC_NET_CORE_HOST || null;
  let hostToken = env.CHECKCC_NET_CORE_HOST_TOKEN || null;
  let hostGuard = null;
  // 宿主协议版本：只和「够新」的宿主合作。旧宿主健康检查会通过，但缺少 ipv6/guard 动作，
  // 继续用它只会让动作失败后退化成本机非提权执行（Windows 表现为 System Error 5）。
  let hostProtocol = 0;
  let hostCapabilities = [];
  let hostStale = null;
  let hostInstallBusy = false;
  let hostInstallFailure = null;
  /** 重新探测特权宿主：装宿主与启动应用有先后关系，不能在构造时探一次就定终身。 */
  async function detectHost() {
    if (env.CHECKCC_NET_CORE_HOST && env.CHECKCC_NET_CORE_HOST_TOKEN) {
      hostUrl = env.CHECKCC_NET_CORE_HOST;
      hostToken = env.CHECKCC_NET_CORE_HOST_TOKEN;
      // 显式注入的宿主由调用方负责版本匹配（本机直连调试/测试）。
      hostProtocol = HOST_PROTOCOL;
      hostCapabilities = [];
      hostStale = null;
      return true;
    }
    hostStale = null;
    try {
      const token = (await readFile(path.join(stateDir, "host-token"), "utf8")).trim();
      const candidate = hostUrl || `http://127.0.0.1:${Number(env.CHECKCC_NET_CORE_HOST_PORT) || 39091}`;
      const health = await (fetchImpl ?? globalThis.fetch)(`${candidate}/health`, { headers: { "X-EnvGuardCC-Host-Token": token }, signal: AbortSignal.timeout(1500) });
      if (!health.ok) return false;
      const value = await health.json();
      const negotiated = checkHostHealth(value);
      hostUrl = candidate;
      hostToken = token;
      hostGuard = value.guard ?? null;
      hostProtocol = negotiated.protocol;
      hostCapabilities = negotiated.capabilities;
      if (!negotiated.ok) {
        hostStale = negotiated;
        logger(`[net-core] 特权宿主版本过旧（协议 ${negotiated.protocol || "未知"}，需要 ≥ ${negotiated.required}${negotiated.missing.length ? `，缺少 ${negotiated.missing.join("/")}` : ""}）：开启保护时会请求一次系统授权更新。`);
        return false;
      }
      return true;
    } catch { return false; }
  }
  let hostMode = await detectHost();
  const loaded = await loadNodes(stateDir);
  // 演示模式：仅供开发者验证页面与内核链路，节点指向本机一个必然不可用的端口。
  let nodes = loaded.state === "ready"
    ? loaded
    : env.CHECKCC_NET_CORE_DEMO === "1"
      ? { state: "ready", demo: true, proxies: demoNodes() }
      : loaded;
  // 演示节点或手工构造的节点没有供应商概念：补一条来源，界面与切换逻辑才有统一入口。
  nodes = { sources: [], activeId: null, proxies: [], selected: null, source: null, ...nodes };
  if (nodes.state === "ready" && !nodes.sources.length && nodes.proxies.length) {
    nodes = { ...nodes, ...migrateStore({ proxies: nodes.proxies, selected: nodes.selected }) };
  }

  const apiPort = Number(env.CHECKCC_NET_CORE_API_PORT || DEFAULT_API_PORT);
  // 生命周期内共享给配置与控制器；不放进 report、环境变量或日志。
  const controllerSecret = randomBytes(32).toString("hex");
  // 本机代理端口：内核启动后对外提供 HTTP/SOCKS 混合代理，不再依赖 FlClash 之类的系统代理。
  // 出站模式：rule=海外走节点（默认），global=全部走节点，direct=除固定 Claude 出口外全直连。
  const modeFile = path.join(stateDir, "net-core-mode.json");
  let egressMode = env.CHECKCC_NET_CORE_MODE || null;
  if (!egressMode) {
    try { egressMode = JSON.parse(await readFile(modeFile, "utf8"))?.mode ?? null; } catch { /* 首次运行没有存档 */ }
  }
  // 旧版本可能保存过已移除的「仅 Claude」模式：统一迁移到 rule。
  egressMode = ["rule", "global", "direct"].includes(egressMode) ? egressMode : "rule";
  const mixedPort = Number(env.CHECKCC_NET_CORE_MIXED_PORT || 39080);
  // 固定出口探测：在主内核里给探测主机加一条钉死专用组的路由，探测走已有的混合入口，
  // 由主内核自己的 dialer 拨号（TUN 下已绑定物理网卡），不再另起临时内核。
  const exitProbeUrl = env.CHECKCC_NET_CORE_EXIT_PROBE_URL || "https://ipwho.is/";
  let exitProbeHost = "";
  try { exitProbeHost = new URL(exitProbeUrl).hostname.toLowerCase(); } catch { throw new Error("固定出口探测地址无效。"); }
  if (!exitProbeHost) throw new Error("固定出口探测地址缺少主机名。");
  const localProxy = `http://127.0.0.1:${mixedPort}`;
  const strictProxy = `http://egcc:${controllerSecret}@127.0.0.1:${mixedPort}`;
  const originalProxyEnvironment = env.CHECKCC_PROXY;
  const connectionFile = path.join(stateDir, "net-core-connection.json");
  let savedTunnel = false;
  try {
    const preference = JSON.parse(await readFile(connectionFile, "utf8"));
    if (typeof preference.tunEnabled !== "boolean") throw new Error("隧道偏好格式无效。");
    savedTunnel = preference.tunEnabled;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  let ownedProxyEnv = false;
  // 宿主模式默认接管 TUN（装宿主就是为了建网卡）；本机直连模式需显式开启。
  // 不能写成 const：launch() 会重新探测宿主后重算，否则「先启动应用、后装宿主」会让 TUN 永久写死成关闭。
  const resolveTunEnabled = () => env.CHECKCC_NET_CORE_TUN === "1" || (env.CHECKCC_NET_CORE_TUN !== "0" && savedTunnel);
  let tunEnabled = resolveTunEnabled();
  const strictFile = path.join(stateDir, "net-core-strict.json");
  let strictEnabled = false, strictBaselineIp = null, lastExitCheck = 0;
  try {
    const saved = JSON.parse(await readFile(strictFile, "utf8"));
    strictEnabled = saved.enabled === true;
    strictBaselineIp = typeof saved.baselineIp === "string" ? saved.baselineIp : null;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (hostGuard?.armed) strictEnabled = true;
  else if (strictEnabled && hostGuard?.phase === "off" && hostGuard.checkedAt) { strictEnabled = false; strictBaselineIp = null; await persistStrict(false, null); }
  async function persistStrict(enabled = strictEnabled, baselineIp = strictBaselineIp) {
    await mkdir(stateDir, { recursive: true });
    const temporary = `${strictFile}.${process.pid}.tmp`;
    try { await writeFile(temporary, JSON.stringify({ enabled, baselineIp }), { mode: 0o600 }); await rename(temporary, strictFile); }
    finally { await rm(temporary, { force: true }); }
  }
  // 区域锁定只保留在本次运行内：出口落回 Claude 不支持地区后，配置里直接 REJECT
  // Claude 域名。应用彻底退出时不留下任何锁定状态，下次启动按当前出口重新检测。
  let regionLock = null;
  // 复检节奏：未锁定 30 秒一次；断开后前 5 分钟每 5 秒抢修一次，之后降频。
  // CHECKCC_NET_CORE_EXIT_CHECK_MS 可供回归/诊断缩短间隔（下限 250ms）。
  const EXIT_CHECK_MS = Math.max(250, Number(env.CHECKCC_NET_CORE_EXIT_CHECK_MS) || 30000);
  const FAST_RECHECK_MS = Math.min(5000, EXIT_CHECK_MS);
  // 抢修窗口默认 5 分钟；可用 CHECKCC_NET_CORE_RECOVERY_WINDOW_MS 缩短（回归测试用）。
  const RECOVERY_WINDOW_MS = Number(env.CHECKCC_NET_CORE_RECOVERY_WINDOW_MS);
  const FAST_RECHECK_WINDOW_MS = Number.isFinite(RECOVERY_WINDOW_MS) && RECOVERY_WINDOW_MS >= 0 ? RECOVERY_WINDOW_MS : 5 * 60 * 1000;
  const LOCKED_EXIT_CHECK_MS = Math.min(15000, EXIT_CHECK_MS);
  // 「出口不在支持地区」会把人卡在必须手动处理的路径上，必须连续多次确认才算数。
  const REGION_ESCALATION_STREAK = 3;
  // 网络恢复即放行：一次通过就解除，不等第二轮。
  const NETWORK_RECOVERY_STREAK = 1;
  // 网络异常时的处置：claude=只阻断 Claude（默认，其他流量照常）；all=严格断流，封全部非节点流量。
  const GUARD_POLICY_FILE = path.join(stateDir, "net-core-guard-policy.json");
  let networkFailurePolicy = "claude";
  try {
    const saved = JSON.parse(await readFile(GUARD_POLICY_FILE, "utf8"))?.networkFailure;
    if (saved === "claude" || saved === "all") networkFailurePolicy = saved;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (env.CHECKCC_NET_CORE_NETWORK_FAILURE === "claude" || env.CHECKCC_NET_CORE_NETWORK_FAILURE === "all") networkFailurePolicy = env.CHECKCC_NET_CORE_NETWORK_FAILURE;
  // 未保护阻断：保护关闭时仍保持 TUN 接管，只对 Claude 域名 REJECT。
  // 与区域锁不同，它不是网络故障状态，只能由「开启保护」显式解除。
  let unprotectedLock = null;
  const claudeBlocked = () => Boolean(regionLock || unprotectedLock);
  // 关闭保护只关 TUN（内核继续跑，节点延迟/切换仍然可用）；显式 null 表示跟随默认。
  let tunOverride = null;
  const configPath = path.join(stateDir, "net-core", "config.yaml");
  const homeDir = path.join(stateDir, "net-core");
  let core = null;
  let ipv6Guard = null;
  let ipv6Probe = null;
  let ipv6Protected = false;
  const shouldProtectIpv6 = () => tunEnabled && ipv6Probe?.supported === true && ipv6Probe.node === nodes.selected;
  let hostHeartbeat = null;
  let lastError = null;
  let operation = Promise.resolve();
  let changing = false;
  let healthTimer = null;
  let healthPending = false;
  let healthFailures = 0;
  let nextRecoveryAt = 0;
  let networkGeneration = 0;
  let networkKey = "";
  let lastHealthAt = null;
  let lastTunnelCaptured = null;
  // 出口复检证据：单次探测结果不足以判定锁/解锁，只有连续结果才做决定。
  let nextExitCheckAt = 0;
  let exitEvidence = { supported: 0, unsupported: 0, failures: 0, lastAt: null, lastError: null };
  // 锁定开始时间：用于「断开 5 分钟内 5 秒抢修」的窗口计算。
  let guardBlockedAt = null;
  // Claude 守卫组的当前选择：true=已切到 REJECT（只影响 Claude 域名），false=走固定出口。
  // 守卫组切换是内核 API 调用，不重载配置，因此不会断开其他流量。
  let claudeGuardBlocked = false;
  // 最近一次验证通过的节点：出口异常时先回切到它，而不是直接升级成地区锁。
  let lastVerifiedNode = null;
  const connectionLog = await createConnectionLog({ stateDir, logger,
    readConnections: () => core?.state().running ? core.request("/connections") : null,
  });
  const stopConnectionLog = () => connectionLog.stop().catch(() => logger("[connection-log] 传输记录保存失败；不影响内核停止。"));
  function connectionState() {
    const fresh = lastHealthAt && Date.now() - Date.parse(lastHealthAt) < 15000;
    const guardFresh = hostGuard?.armed === true && Date.now() - Date.parse(hostGuard.checkedAt ?? "") < 15000;
    const state = !core ? "off" : regionLock ? "blocked" : strictEnabled && (!guardFresh || hostGuard?.phase !== "active") ? "blocked" : lastError ? "error" : changing || !fresh ? "unknown" : !tunEnabled ? "proxy" : lastTunnelCaptured === true ? "verified" : "unknown";
    return {
      state, networkGeneration, checkedAt: lastHealthAt, tunCaptured: fresh ? lastTunnelCaptured : null,
      reason: regionLock?.reason || lastError || (state === "verified" ? null : state === "proxy" ? "本机代理运行中，但未接管系统流量。" : "系统隧道尚未验证或证据已过期。"),
      systemKillSwitch: Boolean(guardFresh), strictTravel: Boolean(strictEnabled && guardFresh && state === "verified"), strictEnabled,
      regionLocked: Boolean(regionLock), regionLock: regionLock ? { ...regionLock } : null,
      claudeBlocked: claudeBlocked(), unprotectedGuard: unprotectedLock ? { ...unprotectedLock } : null,
      // 守卫组真实选择：blocked 表示 Claude 域名在内核里被切到了 REJECT（不重载配置）。
      claudeGuard: claudeGuardBlocked ? "blocked" : "open",
    };
  }
  const serialize = (action, mutating = true) => (...args) => {
    const next = operation.then(async () => {
      const previous = changing;
      if (mutating) changing = true;
      try { return await action(...args); }
      finally { if (mutating) changing = previous; }
    });
    operation = next.catch(() => {});
    return next;
  };
  // 只跟踪 IPv4：内核关闭了 IPv6，macOS 的 IPv6 隐私地址轮换不应被当成“网络变化”。
  const interfacesKey = () => JSON.stringify(Object.entries(interfaces()).flatMap(([name, entries]) =>
    (entries ?? []).filter(item => !item.internal && item.family !== "IPv6" && item.family !== 6 && !inIpv4Range(item.address)).map(item => `${name}:${item.address}`)).sort());
  function startHealthMonitor() {
    if (healthTimer) return;
    networkKey = interfacesKey();
    healthTimer = healthScheduler.every(() => {
      if (healthPending) return;
      healthPending = true;
      return serialize(checkHealth, false)().catch(error => logger(`[net-core] 健康检查失败：${error.message}`)).finally(() => { healthPending = false; });
    }, 5000);
    healthTimer.unref?.();
  }
  function stopHealthMonitor() {
    healthScheduler.clear(healthTimer);
    healthTimer = null;
  }
  /** 内核当前实际选中的 Claude 出口节点；读不到时返回 null。 */
  const currentGroupNode = async () => (await core?.request("/proxies").catch(() => null))?.proxies?.[DEFAULT_GROUP]?.now ?? null;
  /** 网络变化/换节点后旧证据作废，并允许立刻复检。 */
  const resetExitEvidence = () => { exitEvidence = { supported: 0, unsupported: 0, failures: 0, lastAt: null, lastError: null }; nextExitCheckAt = 0; };
  /** 探测失败按 5→10→20 秒退避；断开后前 5 分钟 5 秒一次，之后 15 秒，未锁定 30 秒。 */
  function scheduleExitCheck() {
    const now = Date.now();
    const locked = Boolean(regionLock) || (strictEnabled && hostGuard?.phase !== "active");
    // 抢修窗口从「刚断开」开始算：网络已经恢复过一次就不必再高频探测。
    const since = regionLock ? Date.parse(regionLock.at) : guardBlockedAt ?? now;
    const fast = locked && now - since < FAST_RECHECK_WINDOW_MS;
    const base = fast ? FAST_RECHECK_MS : locked ? LOCKED_EXIT_CHECK_MS : EXIT_CHECK_MS;
    const backoff = exitEvidence.failures > 0 ? 2 ** Math.min(exitEvidence.failures - 1, 2) : 1;
    nextExitCheckAt = now + Math.min(EXIT_CHECK_MS, base * backoff);
  }
  /** 严格断流：只有用户显式选择「阻断全部网络」时才使用；默认只阻断 Claude。 */
  async function blockSystemTraffic() {
    guardBlockedAt = Date.now();
    return hostAction("guard-block");
  }
  /**
   * 网络恢复窗口：网络刚断开/刚锁定的 5 分钟。期间只重试连接与出口复检，不重建内核、
   * 不升级地区锁——重建内核和全量重载都会把全部流量断掉，正是「一波动就全断」的来源。
   */
  const recoveryWindowStart = () => (regionLock ? Date.parse(regionLock.at ?? "") : guardBlockedAt ?? 0) || 0;
  function inFastRecoveryWindow() {
    const at = recoveryWindowStart();
    return at > 0 && Date.now() - at < FAST_RECHECK_WINDOW_MS;
  }
  /** 只切换 Claude 守卫组：阻断/放行 Claude 域名，不重载配置、不影响其他连接。 */
  async function setClaudeGuard(blocked) {
    if (!core || typeof core.selectProxy !== "function") return false;
    await core.selectProxy(CLAUDE_GUARD_GROUP, blocked ? "REJECT" : DEFAULT_GROUP);
    claudeGuardBlocked = blocked;
    return true;
  }
  /** 锁定期间把守卫组切到 REJECT；失败只记日志，锁状态仍然生效。 */
  async function applyClaudeGuard(blocked) {
    if (!core || strictEnabled) return false;
    try { return await setClaudeGuard(blocked); }
    catch (error) { logger(`[net-core] Claude 守卫组切换失败：${error.message}`); return false; }
  }
  function noteLockRecheck(exit) {
    if (!regionLock) return null;
    const supported = claudeRegionSupport(exit?.countryCode) === "supported";
    regionLock = {
      ...regionLock,
      // 复检一旦看到明确出口就把国家/IP 补上：界面和升级判定都靠它。
      ...(exit?.countryCode ? { countryCode: exit.countryCode.toUpperCase() } : {}),
      ...(exit?.ip ? { ip: exit.ip } : {}),
      recheckAttempts: (regionLock.recheckAttempts ?? 0) + 1,
      recheckAt: new Date().toISOString(),
      recheckProbe: exit?.ip ? { ip: exit.ip, countryCode: exit.countryCode ?? null } : null,
      recovered: supported ? (regionLock.recovered ?? 0) + 1 : 0,
    };
    return regionLock;
  }
  const unsupportedExitReason = (code, attempts) => `固定出口${code ? ` ${code}` : ""} 暂不在 Claude 支持地区${attempts > 1 ? `（已连续 ${attempts} 次复检确认）` : ""}；已阻断 Claude 流量，正在自动复检，恢复后自动解除。`;
  /** 固定出口变了基线时：默认只阻断 Claude，其他流量不被连带断开。 */
  const strictBaselineReason = (ip) => `固定出口 IP 与已确认基线不同${ip ? `（${ip}）` : ""}，已阻断 Claude 流量；关闭并重新开启严格模式确认新出口后恢复。`;
  /**
   * 出口探到不受支持地区时，先把 Claude 组切回上次验证通过的节点再判定：
   * 网络抖动/内核重启可能让组停在别的节点上，直接升级地区锁会把人卡在必须手动处理的路径。
   */
  async function failbackToVerifiedNode() {
    if (strictEnabled) return false; // 严格模式不允许自动换出口，只能人工确认基线。
    const target = lastVerifiedNode?.name;
    if (!target || !nodes.proxies.some(node => node.name === target)) return false;
    if (await currentGroupNode() === target) return false;
    logger(`[net-core] 出口暂不受支持，回切到上次验证通过的节点 ${target}。`);
    try { await select(target); }
    catch (error) { logger(`[net-core] 回切到 ${target} 失败：${error.message}`); return false; }
    exitEvidence.unsupported = 0;
    return true;
  }
  /**
   * 出口复检：锁定期间 10 秒一次，网络恢复后连续 NETWORK_RECOVERY_STREAK 次通过才自动解除。
   * 单次「无法确认出口」只维持网络锁并继续复检；连续 REGION_ESCALATION_STREAK 次明确探到
   * 不支持地区才升级为地区锁。注意这里不按 tunEnabled 门控：未开 TUN 时 Claude 仍经内核 REJECT。
   */
  async function recheckExit() {
    lastExitCheck = Date.now();
    exitEvidence.lastAt = new Date().toISOString();
    let exit = null, failure = null;
    try { exit = await probeSelectedExit(); } catch (error) { failure = error; }
    if (failure) {
      exitEvidence.failures += 1;
      exitEvidence.supported = 0;
      exitEvidence.unsupported = 0;
      exitEvidence.lastError = failure.message;
      logger(`[net-core] 出口复检失败（第 ${exitEvidence.failures} 次）：${failure.message}`);
      // 无法确认出口 = 不信任当前网络：先阻断 Claude，网络恢复后自动解除。
      if (!regionLock) await lockRegion(null, { type: "network" });
      else noteLockRecheck(null);
      scheduleExitCheck();
      return null;
    }
    exitEvidence.failures = 0;
    exitEvidence.lastError = null;
    if (claudeRegionSupport(exit.countryCode) === "supported") {
      exitEvidence.unsupported = 0;
      // 严格模式的基线出口不允许被自动改掉：IP 不一致时默认只阻断 Claude，等人工确认。
      if (strictEnabled && strictBaselineIp && exit.ip !== strictBaselineIp) {
        if (networkFailurePolicy === "all") {
          await blockSystemTraffic();
          scheduleExitCheck();
          throw new Error("固定出口 IP 已变化，需要关闭严格模式后明确确认新出口。");
        }
        if (!regionLock) await lockRegion(exit, { type: "region", reason: strictBaselineReason(exit.ip) });
        scheduleExitCheck();
        return exit;
      }
      exitEvidence.supported += 1;
      lastVerifiedNode = { name: await currentGroupNode() ?? nodes.selected, ip: exit.ip ?? null, countryCode: exit.countryCode ?? null, at: new Date().toISOString() };
      const lock = noteLockRecheck(exit);
      if (lock?.type === "network" && (lock.recovered ?? 0) >= NETWORK_RECOVERY_STREAK) await unlockRegion(exit);
      else if (lock?.type === "network") logger(`[net-core] 出口已恢复（${lock.recovered}/${NETWORK_RECOVERY_STREAK}），继续确认后自动解除。`);
      // 严格模式因网络变化保持阻断：出口已回到基线，同样连续确认后自动放行。
      else if (strictEnabled && hostGuard?.phase !== "active" && exitEvidence.supported >= NETWORK_RECOVERY_STREAK) await unlockRegion(exit);
      scheduleExitCheck();
      return exit;
    }
    exitEvidence.supported = 0;
    exitEvidence.unsupported += 1;
    // 出口异常时先回切到上次验证通过的节点，不到万不得已不升级成地区锁。
    await failbackToVerifiedNode().catch((error) => logger(`[net-core] 回切验证节点失败：${error.message}`));
    if (!regionLock) await lockRegion(exit, { type: "network", reason: unsupportedExitReason(exit.countryCode, exitEvidence.unsupported) });
    else noteLockRecheck(exit);
    if (regionLock?.type === "network" && exitEvidence.unsupported >= REGION_ESCALATION_STREAK && !inFastRecoveryWindow()) {
      await lockRegion(exit, { type: "region" });
      logger(`[net-core] 连续 ${exitEvidence.unsupported} 次确认出口不受支持，升级为地区锁。`);
    }
    scheduleExitCheck();
    return exit;
  }
  async function checkHealth() {
    if (!healthTimer || !core) return;
    let failureStage = "probe";
    const key = interfacesKey();
    if (networkKey !== key) {
      networkKey = key;
      networkGeneration++;
      exitCountryCache = { code: null, at: 0 };
      lastHealthAt = null;
      lastTunnelCaptured = null;
      lastExitCheck = 0;
      // 网络变了：旧复检证据作废，并立刻重新复检，不等下一个周期。
      resetExitEvidence();
      // 网络接口变化（Wi-Fi/有线切换、断网重连）时先阻断 Claude，验证通过后再自动放行。
      // 默认只阻断 Claude；只有用户显式选择「阻断全部网络」时才启用系统断流（严格模式）。
      if (strictEnabled && networkFailurePolicy === "all") await blockSystemTraffic();
      if (tunEnabled && !regionLock && !unprotectedLock) await lockRegion(null, { type: "network", reason: "网络接口变化，Claude 流量已暂时阻断；网络恢复并复检通过后自动解除。" });
    }
    try {
      if (strictEnabled) {
        await hostAction("guard-status");
        if (hostGuard?.armed === false && hostGuard.phase === "off") {
          // 独立恢复工具已经明确解除保护，不得由健康检查自动重新封网。
          strictEnabled = false; strictBaselineIp = null;
          await persistStrict(false, null);
          changing = true;
          try { await reloadKernel("独立恢复工具已解除严格模式"); }
          finally { changing = false; }
          return;
        }
      }
      // 出口复检对严格模式同样生效：锁定期间节奏更快，验证通过后自动放行；未保护阻断时不叠加。
      if (!unprotectedLock && Date.now() >= nextExitCheckAt) await recheckExit();
      if (strictEnabled && hostGuard?.phase !== "active") { failureStage = "guard"; throw new Error("严格模式保持阻断，等待连接复检。"); }
      // 到这里之后的失败才可能是内核本身的问题；之前的都只是网络/出口探测。
      failureStage = "kernel";
      await core.status();
      failureStage = "tunnel";
      lastTunnelCaptured = tunEnabled ? (await core.tunnelStatus()).active : null;
      if (tunEnabled && !lastTunnelCaptured) {
        // 未保护阻断已开启时不再叠加区域锁：两条规则都拦 Claude，错误原因会互相覆盖。
        if (!unprotectedLock) await lockRegion(null, { type: "network", reason: "隧道接管失效，Claude 流量已阻断，等待恢复。" });
        throw new Error("隧道接管失效。");
      }
      lastHealthAt = new Date().toISOString();
      lastError = null;
      healthFailures = 0;
    } catch (error) {
      // 只有内核接口不可用/进程不在了才算内核坏了；隧道或出口探测失败多半只是网络刚断，
      // 重建内核会断开全部流量而且耗时很长（用户实测：网络断 1 秒也要等半天）。
      const kernelUnhealthy = failureStage === "kernel" || !core?.state().running;
      lastHealthAt = null;
      lastTunnelCaptured = null;
      lastError = `连接检查失败：${error.message}`;
      if (Date.now() < nextRecoveryAt) return;
      healthFailures++;
      // 抢修窗口内每 5 秒重试一次；窗口结束后才按退避重试。
      nextRecoveryAt = Date.now() + (inFastRecoveryWindow() ? FAST_RECHECK_MS : Math.min(60000, 2000 * 2 ** Math.min(healthFailures, 5)));
      logger(`[net-core] ${lastError}，正在恢复（第 ${healthFailures} 次）。`);
      // 网络波动期只继续复检（每 5 秒重试连接），不重建内核；兜底重建只在两种情况下发生：
      // 内核进程/接口真的挂了，或 5 分钟抢修窗口已过而隧道仍未恢复。
      const rebuild = kernelUnhealthy || (failureStage === "tunnel" && !inFastRecoveryWindow());
      if (!rebuild) return;
      changing = true;
      try { await reloadKernel("后台恢复"); }
      finally { changing = false; }
    }
  }
  // 当前内核实际生效的网络声明指纹；保存后与它不同即为「待重启」。
  let appliedNetwork = null;
  // 上一次写进配置的公共 DNS；与重算结果不同即说明出口地区变了。
  let appliedPublicDns = null;
  // 最近一次节点地址解析结果（域名 → 已验证 IP），用于入口归组。
  let nodeHostsCache = {};
  // 订阅域名必须直连：机场普遍按来源 IP 放行，走隧道出去会被 403。
  // 落盘保留，否则重启后第一次导入又会走代理再次 403。
  const directHostsFile = path.join(stateDir, "net-core-direct-hosts.json");
  let directHosts = [];
  try {
    const saved = JSON.parse(await readFile(directHostsFile, "utf8"));
    directHosts = (Array.isArray(saved?.hosts) ? saved.hosts : []).filter((host) => typeof host === "string" && /^[a-z0-9.-]+$/i.test(host));
  } catch { /* 首次运行没有存档 */ }

  async function allowDirectSubscription(input) {
    if (strictEnabled) throw new Error("严格模式不增加订阅直连例外；请先关闭严格模式再导入。");
    let host = "";
    try { host = new URL(String(input)).hostname.toLowerCase(); } catch { return { host: "", changed: false }; }
    if (!host || !/^[a-z0-9.-]+$/.test(host)) return { host: "", changed: false };
    if (directHosts.includes(host)) return { host, changed: false };
    directHosts = [...directHosts, host];
    await writeFile(directHostsFile, JSON.stringify({ hosts: directHosts, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 }).catch(() => {});
    // 内核在跑就立即热加载，让「先开保护、后导入」也能下到订阅。
    if (core && nodes?.state === "ready") {
      await writeConfig();
      await core.reloadFromFile().catch((error) => logger(`[net-core] 订阅直连规则热加载失败：${error.message}`));
    }
    logger(`[net-core] 订阅域名直连：${host}`);
    return { host, changed: true };
  }

  const disabledReason = () => {
    if (env.CHECKCC_NET_CORE === "0") return "已通过 CHECKCC_NET_CORE=0 关闭";
    if (!binary) return "未找到内核二进制，请运行 pnpm kernel:fetch";
    if (nodes.state === "missing") return "尚未配置出口节点";
    if (nodes.state === "empty") return "出口节点列表为空";
    if (nodes.state === "invalid") return `节点配置无效：${nodes.reason ?? "未知错误"}`;
    return null;
  };

  // 公共 DNS 跟着出口地区走：anycast 解析器（1.1.1.1 / 8.8.8.8）会让「解析器位置 ≠ 出口位置」
  // 变成一条自相矛盾的指纹。名字认不出地区时，用节点服务器 IP 实测国别（ipwho.is）。
  // CHECKCC_NET_CORE_DNS 可显式覆盖（逗号分隔）。
  const probeCountry = async (server) => {
    const response = await fetch(`https://ipwho.is/${encodeURIComponent(server)}`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    if (!data || data.success === false) return null;
    return typeof data.country_code === "string" ? data.country_code : null;
  };
  // 节点名/服务器名都不可信：实测 jp-gcp 上放的是 Taiwan 节点、Japan 01 的出口 IP 在香港。
  // 所以优先用「经当前节点实测的出口国家」决定解析器，测不到再退回节点名/服务器探测。
  let exitCountryCache = { code: null, at: 0 };
  const EXIT_COUNTRY_TTL_MS = 5 * 60 * 1000;
  async function probeExitCountry(name) {
    if (!core) return null;
    const now = Date.now();
    if (exitCountryCache.code && exitCountryCache.name === name && now - exitCountryCache.at < EXIT_COUNTRY_TTL_MS) return exitCountryCache.code;
    try {
      // 主内核在跑且探测的就是当前固定出口：直接走固定出口入站，避免再起临时内核
      // （TUN 开启时临时内核会被主 TUN 截获）。否则退回并行探测。
      let data = null;
      if (!strictEnabled && core?.state().running) {
        const proxies = await core.request("/proxies").catch(() => null);
        if (proxies?.proxies?.[DEFAULT_GROUP]?.now === name) data = await probeFixedExitViaKernel({ timeoutMs: 6000 }).catch(() => null);
      }
      // 普通混合入口的 IP 服务会走 AUTO-PROXY；专用入站明确绑定实际节点。
      if (!data) data = (await probeExitsParallel([name]))[name];
      const code = data?.countryCode ?? null;
      if (code) exitCountryCache = { code, at: now, name };
      return code;
    } catch { return null; }
  }
  async function publicDnsForSelection() {
    const raw = env.CHECKCC_NET_CORE_DNS;
    if (typeof raw === "string" && raw.trim()) return raw.split(",").map((item) => item.trim()).filter(Boolean);
    const list = Array.isArray(nodes.proxies) ? nodes.proxies : [];
    // 内核在跑时以「Claude 组当前实际节点」为准：故障转移换过节点后，节点名与选中记录可能已不一致。
    let name = nodes.selected;
    if (core) {
      const proxies = await core.request("/proxies").catch(() => null);
      name = proxies?.proxies?.[DEFAULT_GROUP]?.now ?? name;
    }
    const node = list.find((item) => item?.name === name) ?? list[0];
    // 出口实测优先：节点名说的国家和真实出口不一致时，以实测为准。
    const measured = await probeExitCountry(node?.name);
    if (measured) return publicDnsForCountry(measured);
    return resolvePublicDns({ node, probe: probeCountry });
  }

  async function writeConfig({ forceBlockClaude = false } = {}) {
    const localNetwork = await loadLocalNetworkConfig(stateDir, env);
    appliedNetwork = fingerprintNetwork(localNetwork);
    const publicDns = strictEnabled ? (env.CHECKCC_NET_CORE_DNS?.split(",").filter(Boolean) || ["https://1.1.1.1/dns-query"]) : await publicDnsForSelection();
    appliedPublicDns = publicDns;
    // 节点地址解析：订阅自带的 DNS 优先（与 FlClash 一致），结果验证后持久化，
    // 避免服务商 DoH 抖一次就让所有节点超时。
    const nodeHosts = await loadVerifiedNodeHosts(nodes.proxies, {
      cacheFile: path.join(stateDir, "node-hosts.json"),
      resolve: (list) => resolveNodeHosts(list, { dnsServers: Array.isArray(nodes.proxyServerDns) ? nodes.proxyServerDns : [] }),
    }).catch(() => ({}));
    nodeHostsCache = nodeHosts;
    const config = buildKernelConfig({
      proxies: nodes.proxies,
      hosts: nodeHosts,
      selected: nodes.selected,
      apiPort,
      secret: controllerSecret,
      mixedPort,
      exitProbeHost,
      egressMode,
      localNetwork,
      publicDns,
      proxyServerDns: Array.isArray(nodes.proxyServerDns) && nodes.proxyServerDns.length ? nodes.proxyServerDns : undefined,
      extraRules: [
        ...(Array.isArray(env.CHECKCC_NET_CORE_RULES) ? env.CHECKCC_NET_CORE_RULES : []),
        // 订阅域名直连：机场按来源 IP 放行，走节点会被 403。放在 MATCH 之前即可生效。
        ...directHosts.map((host) => `DOMAIN-SUFFIX,${host},DIRECT`),
      ],
      // 配置里 Claude 域名走守卫组；只有严格模式（或守卫组不可用的兜底）才把 REJECT 写进规则。
      blockClaude: forceBlockClaude || (strictEnabled && claudeBlocked()),
      ipv6: shouldProtectIpv6(),
    });
    // 生成即校验：配置一旦不再满足置顶/select/故障转移的不变量，就在这里拒绝启动，
    // 而不是让内核带着“兜底单节点”跑起来、等节点掉线才暴露成境外全断。
    assertKernelConfig(config, { egressMode, strictRoute: localNetwork.strictRoute ?? true, blockClaude: forceBlockClaude || (strictEnabled && claudeBlocked()) });
    // 开发者默认不接管系统路由；显式设置 CHECKCC_NET_CORE_TUN=1 才启用。
    config.tun.enable = tunEnabled;
    const effective = strictEnabled ? strictKernelConfig(config, { blockClaude: claudeBlocked() }) : config;
    await mkdir(homeDir, { recursive: true });
    await writeFile(configPath, serializeKernelConfig(effective), { mode: 0o600 });
  }

  async function hostAction(action, extra = {}) {
    const response = await (fetchImpl ?? globalThis.fetch)(`${hostUrl}/kernel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-EnvGuardCC-Host-Token": hostToken },
      body: JSON.stringify({ action, configPath, strict: strictEnabled, guardRevision: hostGuard?.releaseId ?? null, ...extra }),
      signal: AbortSignal.timeout(30000),
    });
    const value = await response.json().catch(() => null);
    if (!response.ok || value?.ok === false) throw new Error(value?.reason ?? `宿主返回 ${response.status}`);
    if (value.guard) hostGuard = value.guard;
    return value;
  }
  function beginHeartbeat() {
    if (!hostMode || hostHeartbeat) return;
    hostHeartbeat = setInterval(() => {
      void hostAction("heartbeat").catch(error => { lastError = `宿主心跳失败：${error.message}`; logger(`[net-core] ${lastError}`); });
    }, 5000);
    hostHeartbeat.unref?.();
  }

  // 仅在节点 IPv6 能力未验证时关闭系统 IPv6；双栈配置生效后恢复原设置。
  async function enableIpv6Guard() {
    if (ipv6Guard || !tunEnabled || shouldProtectIpv6()) return;
    let hostFailure = null;
    if (hostMode) {
      try {
        const result = await hostAction("ipv6", { enabled: false });
        if (!result.changed && result.previous !== 'Off' && result.idle !== true) throw new Error('宿主未确认系统 IPv6 已关闭。');
        ipv6Guard = { mode: "host" };
        logger("[net-core] 已通过特权宿主关闭系统 IPv6，避免绕过隧道。");
        return;
      } catch (error) {
        hostFailure = error.message;
        logger(`[net-core] 宿主关闭 IPv6 失败（${error.message}），尝试本机权限。`);
      }
    }
    try {
      const state = await systemIpv6.disable({ platform });
      if (state?.changed || state?.previous === 'Off' || state?.idle === true) { ipv6Guard = { mode: "local", state }; logger(`[net-core] 系统 IPv6 已关闭（${state.service ?? '网卡'}，原 ${state.previous}）。`); }
      else throw new Error(state?.reason ?? '系统 IPv6 关闭未确认成功。');
    } catch (error) {
      ipv6Guard = error.ipv6State ? { mode: 'local', state: error.ipv6State, unconfirmed: true } : null;
      logger(`[net-core] 关闭系统 IPv6 失败：${error.message}`);
      // 权限类失败只把「怎么解决」交给界面；原始 PowerShell 报错（Command failed / System Error 5）
      // 留日志，避免用户看到一屏他自己无法处理的命令输出。
      const denied = /PermissionDenied|Access is denied|拒绝访问|System Error 5|EACCES|EPERM/i.test(String(error?.message ?? ""));
      // 宿主已经可用却失败：它给出的原因最准确（例如某块在用网卡拒绝修改绑定），直接展示。
      if (hostFailure) throw new Error(`特权助手关闭系统 IPv6 失败：${hostFailure}`);
      if (denied && !elevationStatus({ platform }).elevated) {
        throw new Error(hostStale
          ? "特权助手版本过旧，无法关闭系统 IPv6。请重新开启环境防护，并在系统授权窗口里允许更新（仅需一次）。"
          : "关闭系统 IPv6 需要管理员权限。请重新开启环境防护并允许授权安装特权助手（仅需一次）。");
      }
      throw error;
    }
  }
  async function restoreIpv6Guard() {
    const guard = ipv6Guard;
    if (!guard) return;
    try {
      if (guard.mode === "host") await hostAction("ipv6", { enabled: true });
      else if (await systemIpv6.restore(guard.state) === false && guard.state.changed) throw new Error('系统 IPv6 恢复未确认成功。');
      ipv6Guard = null;
      logger("[net-core] 已恢复系统 IPv6。");
    } catch (error) {
      logger(`[net-core] 恢复系统 IPv6 失败：${error.message}`);
      throw error;
    }
  }

  async function confirmIpv6Protection() {
    ipv6Protected = false;
    if (!shouldProtectIpv6()) return;
    const tunnel = await core.tunnelStatus({ waitMs: 4000 });
    const applied = await core.request('/configs');
    if (!tunnel.active || applied?.ipv6 !== true || applied?.tun?.enable !== true || !applied.tun['inet6-address']?.length) throw new Error('IPv6 隧道接管未确认，保留系统 IPv6 原有关闭状态。');
    await restoreIpv6Guard();
    ipv6Protected = true;
  }

  /** 用一个临时内核 + IPv6-only 端点判断当前节点能否承载 IPv6；结果缓存 10 分钟。 */
  async function probeSelectedNodeIpv6() {
    try {
      return await probeSelectedNodeIpv6Inner();
    } catch (error) {
      ipv6Probe = { supported: null, ip: null, node: nodes.selected ?? null, checkedAt: new Date().toISOString(), reason: `探测失败：${error.message}` };
      return ipv6Probe;
    }
  }

  async function probeSelectedNodeIpv6Inner() {
    const list = Array.isArray(nodes.proxies) ? nodes.proxies : [];
    let name = nodes.selected;
    if (core?.state().running) {
      const actual = await core.request("/proxies").catch(() => null);
      name = actual?.proxies?.[DEFAULT_GROUP]?.now ?? name;
    }
    const node = list.find((item) => item?.name === name) ?? list[0];
    if (!node) {
      ipv6Probe = { supported: null, ip: null, node: name ?? null, checkedAt: new Date().toISOString(), reason: "没有可探测的节点" };
      return ipv6Probe;
    }
    const now = Date.now();
    if (ipv6Probe?.supported !== null && ipv6Probe?.node === node.name && now - Date.parse(ipv6Probe.checkedAt) < 10 * 60 * 1000) return ipv6Probe;
    const { buildProbeConfig } = await import("./config.mjs");
    const { pickPortBlock } = await import("./ports.mjs");
    const dir = await mkdtemp(path.join(os.tmpdir(), "checkcc-ipv6-"));
    const basePort = await pickPortBlock(2, { start: 39581 });
    const mixedPort = basePort - 2, probeApiPort = basePort - 1;
    const secret = randomBytes(32).toString("hex");
    const config = buildProbeConfig({ proxies: list, names: [node.name], basePort, mixedPort, secret, hosts: nodeHostsCache, proxyServerDns: Array.isArray(nodes.proxyServerDns) ? nodes.proxyServerDns : [], ipv6: true });
    config.dns.ipv6 = true;
    const configPath = path.join(dir, "probe.yaml");
    await writeFile(configPath, serializeKernelConfig(config), { mode: 0o600 });
    const probeCore = createCore({ binary, homeDir: dir, configPath, apiPort: probeApiPort, secret, manageProcess: true, spawn, fetchImpl, logger });
    let reason = null;
    try {
      await probeCore.start();
      for (const url of ["https://api6.ipify.org", "https://ipv6.icanhazip.com"]) {
        try {
          const body = (await ipv6Fetch(url, { proxy: `http://127.0.0.1:${basePort}`, userAgent: "EnvGuardCC/1.0", timeoutMs: 9000 })).trim();
          if (body.includes(":") && /^[0-9a-f:]+$/i.test(body)) {
            ipv6Probe = { supported: true, ip: body, node: node.name, checkedAt: new Date().toISOString(), reason: null };
            return ipv6Probe;
          }
          reason = "IPv6-only 端点返回的内容不是 IPv6 地址。";
        } catch (error) { reason = error.message; }
      }
      ipv6Probe = { supported: null, ip: null, node: node.name, checkedAt: new Date().toISOString(), reason };
      return ipv6Probe;
    } catch (error) {
      ipv6Probe = { supported: null, ip: null, node: node.name, checkedAt: new Date().toISOString(), reason: `探测内核启动失败：${error.message}` };
      return ipv6Probe;
    } finally {
      await probeCore.stop().catch(() => {});
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function launch() {
    // 每次启动都重新探测宿主：否则「先开应用、后装宿主」的次序会让 TUN 一直被当成未启用。
    const nextHostMode = await detectHost();
    if (nextHostMode !== hostMode) logger(`[net-core] 特权宿主状态变化：${hostMode ? "可用 → 不可用" : "不可用 → 可用"}。`);
    hostMode = nextHostMode;
    tunEnabled = strictEnabled || (tunOverride ?? resolveTunEnabled());
    if (strictEnabled && (!hostMode || platform !== "darwin")) throw new Error("严格模式需要已更新的 macOS 特权宿主；当前平台不能降级开启。");
    if (strictEnabled && hostGuard?.supported !== true) {
      const health = await (fetchImpl ?? globalThis.fetch)(`${hostUrl}/health`, { headers: { "X-EnvGuardCC-Host-Token": hostToken }, signal: AbortSignal.timeout(3000) });
      hostGuard = (await health.json()).guard ?? null;
      if (hostGuard?.supported !== true) throw new Error("严格模式需要升级 macOS 特权宿主，请重新授权安装。");
    }
    // 已知的订阅地址一律直连（重启后也保持）。
    if (nodes?.source?.url) {
      try {
        const known = new URL(nodes.source.url).hostname.toLowerCase();
        if (known && !directHosts.includes(known)) directHosts = [...directHosts, known];
      } catch { /* 来源不是 URL（手工/文件）*/ }
    }
    // TUN 需要提权：先给出可操作的失败原因，而不是等内核起不来才报「解析结果不在 fake-ip 段」。
    if (tunEnabled && !hostMode) {
      const privilege = elevationStatus({ platform });
      if (!privilege.elevated) {
        throw new Error(`TUN 需要更高权限：${privilege.instruction}${hostStale ? "当前特权助手版本过旧，开启环境防护时会请求一次授权更新。" : ""} 如果暂时只需要本机代理，可用 CHECKCC_NET_CORE_TUN=0 启动（代理端口 ${localProxy}）。`);
      }
    }
    if (tunEnabled) {
      await probeSelectedNodeIpv6().catch((error) => logger(`[net-core] IPv6 能力探测失败：${error.message}`));
      await enableIpv6Guard();
    }
    await writeConfig();
    if (hostMode) {
      // 宿主可能还挂着一台它自己认为「没在跑」的遗留内核，先让它收掉再启动。
      await hostAction("stop").catch(() => {});
      if (tunEnabled) await networkTakeover.prepare({ ports: [apiPort, mixedPort], proxyPort: mixedPort });
      await hostAction("start");
      beginHeartbeat();
    } else if (tunEnabled) await networkTakeover.prepare({ ports: [apiPort, mixedPort], proxyPort: mixedPort });
    core = createCore({ binary, homeDir, configPath, apiPort, secret: controllerSecret, verifyTunnel: () => tunEnabled && !strictEnabled && env.CHECKCC_NET_CORE_VERIFY_TUN !== "0", manageProcess: !hostMode, spawn, fetchImpl, lookup, logger });
    await core.start();
    // 内核重启后选择器回到默认第一项（固定出口组）：已有的锁定/未保护阻断必须马上把
    // 守卫组切回 REJECT，否则重启到健康检查之间的几秒内 Claude 会被放出去。
    if (!strictEnabled && (regionLock || unprotectedLock)) await applyClaudeGuard(true);
    await confirmIpv6Protection();
    connectionLog.start();
    // 启动时就检查一次出口地区：配置已经落盘，但出口可能刚被故障转移到封禁地区。
    // 未保护阻断已经覆盖 Claude 时不需要再叠加区域锁。
    resetExitEvidence();
    if (!strictEnabled && !unprotectedLock) {
      const exit = await probeSelectedExit().catch((error) => { logger(`[net-core] 启动后出口复检失败：${error.message}`); return null; });
      lastExitCheck = Date.now();
      if (!exit) await lockRegion(null, { type: "network" });
      else if (claudeRegionSupport(exit.countryCode) !== "supported") {
        // 启动时的一次探测也可能只是抖动：先按网络锁阻断并自动复检，连续确认后才升级为地区锁。
        exitEvidence.unsupported = 1;
        await lockRegion(exit, { type: "network", reason: unsupportedExitReason(exit.countryCode, 1) });
      } else {
        exitEvidence.supported = 1;
        lastVerifiedNode = { name: await currentGroupNode() ?? nodes.selected, ip: exit.ip ?? null, countryCode: exit.countryCode ?? null, at: new Date().toISOString() };
      }
    }
    if (strictEnabled) {
      const exit = await probeSelectedExit();
      const baselineChanged = Boolean(strictBaselineIp) && exit.ip !== strictBaselineIp;
      // 基线只能由用户明确确认；默认只阻断 Claude，不把整台机器的网络断掉。
      if (baselineChanged && networkFailurePolicy === "all") {
        await blockSystemTraffic();
        throw new Error("固定出口 IP 与已确认基线不同，系统保持阻断。请关闭严格模式后明确确认新出口。");
      }
      lastExitCheck = Date.now();
      if (baselineChanged) {
        await lockRegion(exit, { type: "region", reason: strictBaselineReason(exit.ip) });
        // 系统断流仍只放行节点与隧道，Claude 已在配置里 REJECT：其他流量不受影响。
        await hostAction("guard-activate").catch((error) => logger(`[net-core] 放行非 Claude 流量失败：${error.message}`));
      } else {
        strictBaselineIp = exit.ip;
        exitEvidence.supported = 1;
        lastVerifiedNode = { name: await currentGroupNode() ?? nodes.selected, ip: exit.ip ?? null, countryCode: exit.countryCode ?? null, at: new Date().toISOString() };
        await persistStrict();
        await hostAction("guard-activate");
      }
    }
    scheduleExitCheck();
    lastTunnelCaptured = tunEnabled ? await core.tunnelStatus().then(value => value.active).catch(() => null) : null;
    lastHealthAt = new Date().toISOString();
    startHealthMonitor();
    startAutoRefresh();
    startPublicDnsSync();
    beginHeartbeat();
    // 内核可用后，把本进程的出站流量指向我们自己的代理端口；停止时恢复，避免影响其它功能。
    if (!env.CHECKCC_PROXY || strictEnabled || tunEnabled) { env.CHECKCC_PROXY = strictEnabled ? strictProxy : localProxy; ownedProxyEnv = true; }
    await claudeProxy?.apply(strictEnabled ? strictProxy : localProxy);
  }

  async function start() {
    if (disabledReason()) return false;
    try {
      if (!core || !core.state().running) {
        if (core) await stop();
        await launch();
      }
      else {
        await core.start();
        await claudeProxy?.apply(strictEnabled ? strictProxy : localProxy);
      }
      lastError = null;
      return true;
    } catch (error) {
      lastError = error.message;
      try { await stop(); }
      catch (cleanup) { lastError += `；清理失败：${cleanup.message}`; }
      logger(`[net-core] 内核启动失败：${error.message}`);
      return false;
    }
  }

  async function stop() {
    await claudeProxy?.restore();
    ipv6Protected = false;
    lastHealthAt = null;
    lastTunnelCaptured = null;
    // 停止内核即停止接管：未保护阻断随内核一起结束，下次启动由保护服务重新建立。
    unprotectedLock = null;
    claudeGuardBlocked = false;
    clearInterval(hostHeartbeat);
    hostHeartbeat = null;
    stopPublicDnsSync();
    if (ownedProxyEnv) {
      if (originalProxyEnvironment === undefined) delete env.CHECKCC_PROXY;
      else env.CHECKCC_PROXY = originalProxyEnvironment;
      ownedProxyEnv = false;
    }
    if (hostMode) {
      await hostAction("stop");
      // 关掉后确认端口真的释放：没释放就是内核还在跑，TUN 也不会退（实测事故）。
      const still = await findPortOwner(apiPort).catch(() => null);
      if (still) throw new Error(`端口 ${apiPort} 仍被进程 ${still} 占用：内核未真正停止。`);
      core = null;
      await stopConnectionLog();
      await restoreIpv6Guard();
      return;
    }
    if (!core) { await stopConnectionLog(); await restoreIpv6Guard(); return; }
    await core.stop();
    await stopConnectionLog();
    // 停成功后不能继续握着已停止的实例：否则 report() 会去读它的 /version，
    // 把「已停止」误报成「状态不可读」。
    core = null;
    await restoreIpv6Guard();
  }

  /** 把内存状态里的某条来源设为当前：proxies / selected / source 三个派生字段一起换。 */
  function applyActive(id) {
    ipv6Probe = null;
    exitCountryCache = { code: null, at: 0 };
    exitCache.clear();
    delayCache.clear();
    delayInflight.clear();
    const active = pickActive(nodes.sources ?? [], id);
    nodes = {
      ...nodes,
      activeId: active.activeId,
      proxies: active.proxies,
      selected: active.selected,
      source: active.source,
      proxyServerDns: active.proxyServerDns,
      state: active.proxies.length ? "ready" : "empty",
    };
    return active;
  }

  async function persist() {
    await saveNodes(stateDir, { sources: nodes.sources ?? [], activeId: nodes.activeId ?? null, proxyServerDns: nodes.proxyServerDns ?? null });
    nodes.file = nodesFilePath(stateDir);
  }

  /** 重建并重启内核；失败只记录原因，由报告把真实错误带给界面。 */
  async function reloadKernel(reason) {
    const previousUnprotectedLock = unprotectedLock;
    if (core) {
      await stop();
      core = null;
    }
    unprotectedLock = previousUnprotectedLock;
    if (disabledReason()) return;
    try {
      await launch();
      lastError = null;
    } catch (error) {
      lastError = error.message;
      logger(`[net-core] ${reason}后重启失败：${error.message}`);
      throw error;
    }
  }

  async function nodeTransaction(action) {
    if (strictEnabled) throw new Error("严格模式已固定配置；请先关闭严格模式，再修改订阅或节点。");
    const before = structuredClone(nodes);
    const beforeRegionLock = structuredClone(regionLock);
    const beforeUnprotectedLock = structuredClone(unprotectedLock);
    const originalCore = core;
    const hadCore = Boolean(core);
    const file = nodesFilePath(stateDir);
    const original = await readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
    try { return await action(); }
    catch (error) {
      if (core === originalCore && JSON.stringify(nodes) === JSON.stringify(before)) throw error;
      nodes = before;
      regionLock = beforeRegionLock;
      unprotectedLock = beforeUnprotectedLock;
      try {
        if (original === null) await rm(file, { force: true });
        else {
          const temporary = `${file}.${process.pid}.rollback`;
          try { await writeFile(temporary, original, { mode: 0o600 }); await rename(temporary, file); }
          finally { await rm(temporary, { force: true }); }
        }
        if (hadCore) await reloadKernel("回滚配置");
        else if (core) await stop();
      } catch (rollback) {
        lastError = `${error.message}；回滚失败：${rollback.message}`;
        throw new Error(lastError, { cause: error });
      }
      throw error;
    }
  }

  /**
   * 导入节点：校验 → 落盘 → 若内核在用则重建配置并重启。
   * 新增/编辑/本地代理追加都走这里；sourceId 表示编辑已有供应商，activate=false 表示只更新快照不切换。
   */
  async function importNodes(input, { selected = null, source = null, append = false, proxyServerDns = null, sourceId = null, sourceName = null, activate = true } = {}) {
    // append：本地代理这类额外出口是「加一个」而不是「换一批」，不能把已有订阅抹掉。
    const existing = append && nodes?.state === "ready" ? nodes.proxies : [];
    const { proxies, skipped } = normalizeProxies([...existing, ...(Array.isArray(input) ? input : [])]);
    if (!proxies.length) throw new Error("没有可用的节点（全部条目缺少必要字段）。");
    const current = sourceId ? (nodes.sources ?? []).find((item) => item.id === sourceId) : null;
    if (sourceId && !current) throw new Error("找不到要修改的配置。");
    const activeSource = (nodes.sources ?? []).find((item) => item.id === nodes.activeId) ?? null;
    let outcome;
    if (append && activeSource) {
      // 追加场景的 proxies 已经是「原有 + 新增」归一化后的结果，直接整批写回当前供应商。
      outcome = upsertSource(nodes.sources, { ...activeSource, proxies }, { id: activeSource.id });
    } else {
      outcome = upsertSource(nodes.sources ?? [], {
        name: sourceName ?? current?.name,
        mode: append ? "local" : (source?.mode ?? current?.mode ?? "manual"),
        url: source?.url ?? null,
        proxies,
        selected,
        intervalHours: current?.intervalHours,
        proxyServerDns,
      }, { id: current?.id ?? null });
    }
    nodes.sources = outcome.sources;
    if (activate) {
      if (!append && !selected && nodes.activeId !== outcome.source.id) {
        await activateSource(outcome.source.id);
      } else {
        // 节点 DNS 是「当前订阅」的属性：只更新非当前供应商的快照时不能覆盖它。
        applyActive(outcome.source.id);
        await persist();
        await reloadKernel("导入");
      }
    } else {
      await persist();
    }
    return {
      imported: proxies.length,
      skipped,
      selected: activate ? nodes.selected : outcome.source.selected,
      sourceId: outcome.source.id,
      sources: publicSources(nodes.sources, nodes.activeId),
    };
  }

  /** 订阅刷新：可按 id 刷新任意一条订阅；刷新非当前供应商只更新快照，不打断连接。 */
  async function refresh({ force = false, intervalMs = 6 * 60 * 60 * 1000, sourceId = null } = {}) {
    const target = sourceId
      ? (nodes.sources ?? []).find((item) => item.id === sourceId)
      : (nodes.sources ?? []).find((item) => item.id === nodes.activeId);
    if (!target || target.mode !== "url" || !target.url) throw new Error("当前节点不是从订阅链接导入的，无法自动更新。");
    if (!force && target.updatedAt) {
      const due = Date.parse(target.updatedAt) + Number(target.intervalHours ?? intervalMs / 3600000) * 3600000;
      if (Number.isFinite(due) && Date.now() < due) return { skipped: true, reason: "尚未到更新时间", nextAt: new Date(due).toISOString() };
    }
    const parsed = parseSubscription(await fetchSubscription(target.url, download ? { download } : {}));
    if (target.id === nodes.activeId && target.selected && !parsed.proxies.some(node => node.name === target.selected)) {
      throw new Error("订阅已移除当前固定出口，已保留原配置。请手动导入并明确选择新节点。");
    }
    if (target.id === nodes.activeId && target.selected) {
      const previous = target.proxies.find(node => node.name === target.selected);
      const candidate = parsed.proxies.find(node => node.name === target.selected);
      if (fingerprintNetwork(previous) !== fingerprintNetwork(candidate)) throw new Error("订阅修改了当前固定节点的配置，已保留原配置。请手动导入并确认变更。");
    }
    const { skipped: skippedItems, ...result } = await importNodes(parsed.proxies, {
      source: { mode: "url", url: target.url },
      sourceId: target.id,
      sourceName: target.name,
      proxyServerDns: Array.isArray(parsed.proxyServerDns) ? parsed.proxyServerDns : null,
      activate: target.id === nodes.activeId,
    });
    return { skipped: false, ...result, skippedItems };
  }

  /** 当前已保存的供应商列表（不下发整份节点快照）。 */
  function sources() {
    return publicSources(nodes.sources ?? [], nodes.activeId);
  }

  /** 供应商默认出口按订阅顺序筛选，连通性和实测 Claude 地区均通过后才提交。 */
  async function activateSource(id) {
    const target = (nodes.sources ?? []).find((item) => item.id === id);
    if (!target) throw new Error("找不到这条配置。");
    if (nodes.activeId === id) return { activeId: id, changed: false };
    applyActive(id);
    if (disabledReason()) {
      await persist();
      return { activeId: id, changed: true, selected: nodes.selected };
    }
    const deadline = Date.now() + 90000;
    regionLock = { locked: true, type: "network", ip: null, countryCode: null, at: new Date().toISOString(), reason: "正在验证新供应商出口，Claude 流量暂时阻断。", autoRecover: true, recovered: 0, recheckAttempts: 0, recheckAt: null };
    await reloadKernel("切换配置");
    const names = nodes.proxies.map(node => node.name);
    const delays = await collectDelays(names, { force: true });
    for (const name of names) {
      if (Date.now() >= deadline) throw new Error("供应商节点筛选超时，尚未找到可用于 Claude 的节点。");
      if (!Number.isFinite(delays[name]) || delays[name] < 0) continue;
      let exit;
      try {
        await core.selectProxy(DEFAULT_GROUP, name);
        exit = await probeFixedExitViaKernel({ timeoutMs: 3000 });
      } catch { continue; }
      if (!exit?.ip || claudeRegionSupport(exit.countryCode) !== "supported") continue;
      exitCountryCache = { code: exit.countryCode, at: Date.now(), name };
      await select(name);
      await unlockRegion(exit);
      return { activeId: id, changed: true, selected: name };
    }
    throw new Error("供应商没有通过连通性与 Claude 支持地区检测的节点。");
  }

  async function deleteSource(id) {
    if (!(nodes.sources ?? []).some((item) => item.id === id)) throw new Error("找不到这条配置。");
    const wasActive = nodes.activeId === id;
    nodes.sources = removeSource(nodes.sources ?? [], id).sources;
    if (wasActive && nodes.sources.length) {
      const result = await activateSource(nodes.sources[0].id);
      return { ...result, removed: id };
    }
    if (wasActive) applyActive(null);
    await persist();
    if (wasActive) await reloadKernel("删除配置");
    return { activeId: nodes.activeId, removed: id };
  }

  async function renameSourceConfig(id, name) {
    const renamed = renameSource(nodes.sources ?? [], id, name);
    nodes.sources = renamed.sources;
    await persist();
    return { id, name: renamed.source.name };
  }

  let refreshTimer = null;
  let dnsTimer = null;
  function startAutoRefresh({ intervalMs = 6 * 60 * 60 * 1000 } = {}) {
    if (refreshTimer) return false;
    refreshTimer = setInterval(() => { void serialize(() => nodeTransaction(() => refresh({ intervalMs })))().catch((error) => logger(`[net-core] 订阅更新失败：${error.message}`)); }, Math.max(60000, intervalMs));
    refreshTimer.unref?.();
    return true;
  }
  function stopAutoRefresh() { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } }

  async function report() {
    if (hostMode && strictEnabled) {
      try { await hostAction("guard-status"); } catch (error) { lastError = `系统阻断核验失败：${error.message}`; }
    }
    const reason = disabledReason();
    const base = {
      enabled: !reason, demo: nodes?.demo === true, tunEnabled, hostMode, binary, apiPort,
      // 宿主在线但版本过旧：界面据此提示「需要重新授权更新」，而不是报权限错误。
      hostProtocol, hostCapabilities, hostStale: hostStale ? { ...hostStale } : null,
      nodes: Array.isArray(nodes?.proxies) ? nodes.proxies.map((node) => node.name) : [],
      selected: nodes?.selected ?? null,
      publicDns: appliedPublicDns,
      source: nodes?.source ?? null, mode: egressMode,
      // 网络异常时默认只阻断 Claude（claude）；只有 all 才封全部非节点流量。
      networkFailurePolicy,
      // 供应商列表：界面只用来展示名称/节点数/更新时间，节点快照留在本地文件。
      sources: publicSources(nodes.sources, nodes.activeId),
      activeId: nodes.activeId ?? null,
      localProxy,
      connectionLog: await connectionLog.snapshot().catch(() => null),
      networkGeneration, lastHealthAt,
      ipv6: ipv6Probe ? { ...ipv6Probe, protected: false, system: ipv6Guard && !ipv6Guard.unconfirmed ? "disabled" : ipv6Protected ? "unchanged" : "unknown" } : null,
      regionLock: regionLock ? { ...regionLock } : { locked: false },
      claudeBlocked: claudeBlocked(),
      // 守卫组真实选择：blocked=Claude 域名在内核里被切到 REJECT（不重载配置）。
      claudeGuard: claudeGuardBlocked ? "blocked" : "open",
      unprotectedGuard: unprotectedLock ? { ...unprotectedLock } : null,
      strictMode: strictEnabled, guard: hostGuard,
      takeover: networkTakeover.status(),
      capabilities: { independentProxy: true, systemKillSwitch: connectionState().systemKillSwitch, strictTravel: connectionState().strictTravel },
      elevation: hostMode
        ? { elevated: true, platform, instruction: "内核由特权宿主托管。" }
        : elevationStatus({ platform }),
    };
    if (reason) return { ...base, state: "disabled", reason };
    if (changing) {
      // 启动阶段内核还没建起来：这是「启动中」，不能报成「状态不可读」吓人。
      if (!core) return { ...base, state: "starting", reason: "网络内核正在启动，首次启动需要建立隧道并验证出口。" };
      const phase = networkTakeover.status().phase;
      const reason = phase === "quitting" ? "正在退出其他代理客户端，等待网络交接。" : phase === "waiting" ? "正在等待其他代理释放网络资源。" : phase === "checking" ? "正在检查其他 VPN 与端口占用。" : "网络配置正在切换，旧验证结果已失效。";
      return { ...base, state: "unavailable", reason };
    }
    // 启动失败时 core 可能根本没建起来（例如 TUN 没有权限），此时不能当作「已停止」静默掉。
    if (!core) return lastError ? { ...base, state: "error", reason: lastError } : { ...base, state: "idle" };
    if (lastError) return { ...base, state: "error", reason: lastError };
    try {
      const status = await core.status();
      const evidence = routingEvidence(status.connections, { group: DEFAULT_GROUP });
      const group = status.proxies?.proxies?.[DEFAULT_GROUP];
      const autoGroup = status.proxies?.proxies?.[DEFAULT_AUTO_GROUP];
      // tunEnabled 只是「配置里开了」；tunCaptured 才是「网卡真的接管了流量」。两者必须分开显示，
      // 否则「开了但没接管」和「没开」在界面上长得一模一样。
      const tunCaptured = tunEnabled ? await core.tunnelStatus().then((value) => value.active).catch(() => null) : null;
      lastTunnelCaptured = tunCaptured;
      lastHealthAt = new Date().toISOString();
      // 延迟随状态一起返回：先给缓存值（不阻塞轮询），过期项在后台补测。
      const delays = cachedDelays(base.nodes);
      // 入口归组（按已解析 IP）：让界面能提示「这些节点共用同一个入口，故障转移无效」。
      const ingress = ingressSummary(nodes.proxies, { hosts: nodeHostsCache });
      return {
        ...base,
        state: "running",
        version: status.version,
        restarts: status.restarts,
        tunCaptured,
        ipv6: base.ipv6 ? { ...base.ipv6, protected: Boolean(ipv6Protected && tunCaptured && shouldProtectIpv6()) } : null,
        delays,
        ingress,
        selected: group?.now ?? base.selected,
        autoSelected: autoGroup?.now ?? null,
        routing: evidence,
        detail: routingSummary(evidence),
      };
    } catch (error) {
      return { ...base, state: "unavailable", reason: error.message };
    }
  }

  async function verifyConnection() {
    if (strictEnabled && connectionState().state !== "verified") throw new Error("严格模式尚未验证或保持阻断。");
    if (!core?.state().running || !tunEnabled) throw new Error("系统隧道未启用或内核未就绪。");
    const key = interfacesKey();
    await core.status();
    const captured = (await core.tunnelStatus()).active;
    lastTunnelCaptured = captured;
    if (!captured || interfacesKey() !== key) { lastHealthAt = null; throw new Error("隧道未接管或网络已变化，请重试验证。"); }
    lastHealthAt = new Date().toISOString();
    return { state: "running", tunEnabled, tunCaptured: true, networkGeneration, checkedAt: lastHealthAt };
  }

  /** 节点延迟：直接读内核的延迟测试结果，超时/失败按 null 返回，不编造毫秒数。 */
  async function delay(name, timeoutMs = 5000) {
    if (!core) throw new Error("内核未运行，无法测速。");
    const target = encodeURIComponent("http://www.gstatic.com/generate_204");
    const value = await core.request(`/proxies/${encodeURIComponent(name)}/delay?url=${target}&timeout=${timeoutMs}`);
    return Number.isFinite(value?.delay) ? value.delay : null;
  }

  // 节点延迟自动采集：状态报告里直接带延迟，用户不必先点「测速」。
  // 必须并行：串行跑 25 个节点 × 5 秒超时 = 2 分钟，界面会一直卡在「测速中…」（实测事故）。
  const delayCache = new Map();
  const DELAY_TTL_MS = 60000;
  const delayInflight = new Map();

  /** 只读缓存；过期的节点同时发起后台刷新（不阻塞状态轮询）。 */
  function cachedDelays(names) {
    const list = (Array.isArray(names) ? names : []).filter((name) => typeof name === "string" && name);
    const now = Date.now();
    const result = {};
    const stale = [];
    for (const name of list) {
      const hit = delayCache.get(name);
      if (hit && now - hit.at < DELAY_TTL_MS) result[name] = hit.value;
      else stale.push(name);
    }
    if (stale.length) void collectDelays(stale).catch(() => {});
    return result;
  }

  async function collectDelays(names, { force = false } = {}) {
    const list = (Array.isArray(names) ? names : []).filter((name) => typeof name === "string" && name);
    if (!core || !list.length) return {};
    const now = Date.now();
    const result = {};
    await Promise.all(list.map(async (name) => {
      const hit = delayCache.get(name);
      if (!force && hit && now - hit.at < DELAY_TTL_MS) { result[name] = hit.value; return; }
      // 同一节点已在测速中：复用那次结果，不要叠加请求。
      let pending = delayInflight.get(name);
      if (!pending || force) {
        pending = delay(name, 3000).then((value) => {
          if (delayInflight.get(name) === pending) delayCache.set(name, { value, at: Date.now() });
          return value;
        }).catch(() => {
          if (delayInflight.get(name) === pending) delayCache.set(name, { value: null, at: Date.now() });
          return null;
        }).finally(() => { if (delayInflight.get(name) === pending) delayInflight.delete(name); });
        delayInflight.set(name, pending);
      }
      result[name] = await pending;
    }));
    return result;
  }

  /**
   * 并行出口探测：临时拉起一个独立内核实例，给每个节点绑一个入站端口，然后同时问一遍。
   * 好处：不受主内核选中节点影响（出口 IP 不抖动），且 37 个节点同时测只需几秒。
   */
  async function probeExitsParallel(names) {
    const { buildProbeConfig } = await import("./config.mjs");
    const { pickPortBlock } = await import("./ports.mjs");
    const { mkdtemp, writeFile: write, rm: remove } = await import("node:fs/promises");
    const os = await import("node:os");
    const netModule = await import("node:net");
    const wanted = (Array.isArray(names) ? names : []).filter((name) => typeof name === "string" && name);
    if (!wanted.length) return {};
    const dir = await mkdtemp(path.join(os.tmpdir(), "checkcc-probe-"));
    const canConnect = (port) => new Promise((resolve) => {
      const socket = netModule.connect({ host: "127.0.0.1", port });
      socket.setTimeout(1200, () => { socket.destroy(); resolve(false); });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    let lastError = null;
    // 主内核 TUN 开启时，临时内核的节点连接会被主 TUN 再次截获（见 docs/NET-CORE.md），
    // 必然全部失败；只试一次就交给串行回退，不让用户先干等三轮超时。
    const attempts = tunEnabled ? 1 : 3;
    try {
      // 端口段会撞上 Windows 保留区间（实测直接 RST），所以按块申请并在就绪后实测可连。
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const basePort = await pickPortBlock(wanted.length + 2, { start: 39481 + attempt * 200 });
        const mixedPort = basePort - 2;
        const apiPort = basePort - 1;
        const secret = randomBytes(32).toString("hex");
        const config = buildProbeConfig({ proxies: nodes.proxies, names: wanted, basePort, mixedPort, secret, hosts: nodeHostsCache, proxyServerDns: Array.isArray(nodes.proxyServerDns) ? nodes.proxyServerDns : [] });
        const configPath = path.join(dir, "probe-" + attempt + ".yaml");
        await write(configPath, serializeKernelConfig(config), { mode: 0o600 });
        const probeCore = createCore({ binary, homeDir: dir, configPath, apiPort, secret, manageProcess: true, spawn, fetchImpl, logger });
        try {
          await probeCore.start();
          const reachable = await Promise.all(config.listeners.map((listener) => canConnect(listener.port)));
          if (!reachable.some(Boolean)) throw new Error("探测入站端口不可用（段 " + basePort + "）");
          const results = await Promise.all(config.listeners.map(async (listener) => {
            try {
              const text = await fetchTextViaProxy(env.CHECKCC_NET_CORE_EXIT_PROBE_URL || "https://ipwho.is/", { proxy: "http://127.0.0.1:" + listener.port, userAgent: "EnvGuardCC/1.0", timeoutMs: 6000 });
              const data = JSON.parse(text);
              const value = data?.success === false ? null : exitFields(data);
              return [listener.proxy, value];
            } catch { return [listener.proxy, "__retry__"]; }
          }));
          const failed = results.filter(([, value]) => value === "__retry__").length;
          // 全部失败时不能返回全 null 假装探测完成：必须继续，让循环结束后抛出，
          // 调用方才能退回串行探测。大面积失败也可能是端口段被系统占用，换一段再试。
          if (failed && failed === results.length) { lastError = new Error("探测请求全部失败"); continue; }
          return Object.fromEntries(results.map(([name, value]) => [name, value === "__retry__" ? null : value]));
        } catch (error) { lastError = error; } finally { await probeCore.stop().catch(() => {}); }
      }
      throw lastError ?? new Error("出口探测失败。");
    } finally {
      await remove(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  // 逐节点实测出口国家：节点名不可信（实测 Japan 01 出口在香港），只能真的从该节点出去问一次。
  // 必须显式触发：每次切换都会让出口 IP 抖动，属于风控信号，不能自动轮询。
  const exitCache = new Map();
  const EXIT_CACHE_TTL_MS = 10 * 60 * 1000;
  async function probeNodeExits(names) {
    if (!core) throw new Error("内核未运行，无法检测出口。");
    const requested = (Array.isArray(names) ? names : []).filter((name) => typeof name === "string" && name);
    // 并行优先：不切主内核的选中节点，出口 IP 不会抖动，几十个节点几秒完成。
    try {
      const parallel = await probeExitsParallel(requested);
      // 只缓存成功结果：把 null 也缓存 10 分钟会让「重试检测」在缓存期内直接返回旧失败。
      for (const [name, value] of Object.entries(parallel)) if (value?.ip) exitCache.set(name, { value, at: Date.now() });
      return parallel;
    } catch (error) {
      logger(`[net-core] 并行出口探测不可用（${error.message}），退回串行。`);
    }
    // 串行回退会短暂切换主内核的选中节点；严格模式只有一个固定出口，必须用带认证的入口。
    const probeProxy = strictEnabled ? strictProxy : localProxy;
    const wanted = requested;
    const original = await core.request("/proxies").then((value) => value?.proxies?.[DEFAULT_GROUP]?.now ?? nodes.selected).catch(() => nodes.selected);
    const result = {};
    try {
      for (const name of wanted) {
        const hit = exitCache.get(name);
        if (hit?.value?.ip && Date.now() - hit.at < EXIT_CACHE_TTL_MS) { result[name] = hit.value; continue; }
        try {
          await core.selectProxy(DEFAULT_GROUP, name);
          const text = await fetchTextViaProxy(exitProbeUrl, { proxy: probeProxy, userAgent: "EnvGuardCC/1.0", timeoutMs: 5000 });
          const data = JSON.parse(text);
          const value = data?.success === false ? null : exitFields(data);
          if (value?.ip) exitCache.set(name, { value, at: Date.now() });
          result[name] = value;
        } catch (error) {
          logger(`[net-core] 节点 ${name} 出口探测失败：${error.message}`);
          result[name] = null;
        }
      }
    } finally {
      // 测完必须还原，不能把用户的选中节点留在最后一个被探测的节点上。
      if (original) await core.selectProxy(DEFAULT_GROUP, original).catch(() => {});
    }
    return result;
  }

  /** 重新探测特权宿主：应用内装好宿主后立即生效，不必重启应用。 */
  async function refreshHost() {
    const next = await detectHost();
    const changed = next !== hostMode;
    // 切到宿主模式前必须按本机模式停掉手里的内核，否则宿主绑不上 39090。
    if (changed && next && core) await stop();
    hostMode = next;
    tunEnabled = tunOverride ?? resolveTunEnabled();
    return { hostMode, tunEnabled, changed };
  }

  /**
   * 首次开启保护时的一键授权：宿主不存在或版本过旧，就用系统授权弹窗安装一次。
   * Windows 弹 UAC、macOS 弹密码/Touch ID；宿主随后以 SYSTEM/root 常驻并开机自启，
   * 之后每次开启保护都不再需要授权。
   */
  async function ensurePrivilegedHost({ reason = "启动环境防护" } = {}) {
    const decision = hostInstallDecision({
      hostMode, platform,
      elevated: elevationStatus({ platform }).elevated,
      disabled: env.CHECKCC_NET_CORE_NO_HOST_INSTALL === "1",
      failure: hostInstallFailure,
    });
    if (decision.action === "fail") throw new Error(decision.reason);
    if (decision.action !== "install") return { installed: false, hostMode };
    if (hostInstallBusy) throw new Error("特权助手正在安装，请先完成当前的系统授权窗口。");
    hostInstallBusy = true;
    try {
      logger(`[net-core] ${reason}需要系统权限：请求一次授权安装特权助手（仅首次，之后不再提示）。`);
      await installHost();
    } finally {
      hostInstallBusy = false;
    }
    if (!hostMode) {
      // 装成功却探测不到：不能反复弹 UAC，本会话直接给出可读原因。
      hostInstallFailure = "特权助手已安装但当前不可用，请重新打开 EnvGuardCC 后重试；如仍失败，请检查系统计划任务 EnvGuardCC-KernelHost。";
      throw new Error(hostInstallFailure);
    }
    return { installed: true, hostMode: true };
  }

  /**
   * 应用内安装特权宿主：macOS 走系统授权弹窗（密码/Touch ID 不经过应用）。
   * 路径只来自服务端，HTTP 请求无法指定要执行什么。
   */
  async function installHost() {
    if (!binary) throw new Error("未找到内核二进制，请先准备内核。");
    const { installKernelHost } = await import("./host-install.mjs");
    const result = await installKernelHost({ stateDir, binary, platform });
    const host = await refreshHost();
    return { ...result, ...host };
  }

  /**
   * 切换 TUN 接管：
   * - 关闭时内核继续跑（节点仍可测速/切换，本机 39080 仍可当代理用），只是不再接管系统流量；
   * - 开启时如果内核还停在 idle，必须真正把它拉起来，否则界面显示「保护中」而隧道根本没建立。
   */
  async function setTunnel(enabled, { ensureHost = false } = {}) {
    if (typeof enabled !== "boolean") throw new Error("隧道开关必须是布尔值。");
    const next = enabled;
    if (strictEnabled && !next) throw new Error("请先明确关闭严格模式，再关闭系统接管。");
    // 保护关闭时 Claude 已被阻断；直接关 TUN 会绕过阻断，必须先开启保护或退出应用。
    if (unprotectedLock && !next) throw new Error("保护未开启时 Claude 已被阻断；请先开启环境防护，或退出应用后再关闭系统接管。");
    // 应用内刚装好宿主时必须重新探测；否则内核还停在本机模式，TUN 永远建不起来。
    if (next) await refreshHost();
    // 宿主缺失或过旧时，第一次开启保护直接请求系统授权安装一次；
    // 不降级到非提权的本机 PowerShell（Windows 会报 System Error 5，用户完全看不懂）。
    // 只有用户主动开启的入口传 ensureHost:true；后台自动阻断与测试调用不会弹授权。
    if (next && ensureHost) await ensurePrivilegedHost();
    if (next && (!core || !core.state().running)) {
      const reason = disabledReason();
      if (reason) throw new Error(`内核无法启动：${reason}`);
      // 启动失败时把 TUN 意向还原：否则一次「没有权限」的尝试会让后续
      // 「启动内核」也一直带着 TUN=true，用户无法退回仅本机代理。
      const previous = { override: tunOverride, enabled: tunEnabled };
      tunOverride = next;
      tunEnabled = next;
      if (!(await start())) {
        tunOverride = previous.override;
        tunEnabled = previous.enabled;
        throw new Error(lastError ?? "内核启动失败。");
      }
      logger(`[net-core] 保护开启，内核已启动（TUN ${tunEnabled ? "已接管" : "未启用"}）。`);
      return { tunEnabled, changed: true, started: true };
    }
    if (next === tunEnabled && tunOverride !== null) {
      if (next && !(await core.tunnelStatus()).active) throw new Error("隧道未接管，不能复用旧的开启状态。");
      if (next) {
        await probeSelectedNodeIpv6();
        await enableIpv6Guard();
        await writeConfig();
        await core.reloadFromFile();
        await confirmIpv6Protection();
      } else await restoreIpv6Guard();
      lastTunnelCaptured = next ? true : null;
      lastHealthAt = new Date().toISOString();
      return { tunEnabled, changed: false };
    }
    const previous = { override: tunOverride, enabled: tunEnabled };
    // 本机代理已经运行时不重复绑定自己的端口，但仍须先退出其他客户端再启用 TUN。
    if (next && !previous.enabled) await networkTakeover.prepare({ proxyPort: mixedPort });
    tunOverride = next;
    const changed = next !== tunEnabled;
    tunEnabled = next;
    if (core?.state().running && nodes?.state === "ready") {
      const restartKernel = async () => {
        await stop();
        try { await launch(); } catch (error) { lastError = `隧道回滚后重启失败：${error.message}`; }
      };
      try {
        // 开启前先探测节点 IPv6 能力并关系统 IPv6；关闭后等 TUN 退出再恢复。
        if (next) {
          await probeSelectedNodeIpv6();
          await enableIpv6Guard();
        }
        await writeConfig();
        // 热加载而非重启：切换 TUN 不该把节点选择、连接状态全部重置。
        await core.reloadFromFile();
        if (!core.state().running) throw new Error("内核在切换 TUN 后退出。");
        if (next) {
          // 热加载不会因为 TUN 建不起来就失败：mihomo 只打一条 error 继续跑。
          // 不重新核实的话，界面会把「配置里开了」当成「已经接管」。
          const tunnel = await core.tunnelStatus({ waitMs: 4000 }).catch(() => null);
          if (!tunnel?.active) throw new Error(`隧道未接管：${tunnel?.host ?? "claude.ai"} 解析为 ${tunnel?.address || "空"}，不在 fake-ip 段。${elevationStatus({ platform }).instruction} 如果只需要本机代理，请保持 TUN 关闭。`);
        }
        await confirmIpv6Protection();
        lastError = null;
        lastTunnelCaptured = next ? true : null;
        lastHealthAt = new Date().toISOString();
        if (next) { env.CHECKCC_PROXY = localProxy; ownedProxyEnv = true; }
        if (!next) await restoreIpv6Guard();
        logger(`[net-core] TUN ${next ? "已接管" : "已退出"}（内核保持运行）。`);
      } catch (error) {
        // 回滚成进入本次调用前的状态，避免「保护显示开启但流量没进隧道」。
        // 不写 lastError：内核可能仍在以代理模式运行，让 report() 继续如实显示运行状态，
        // 失败原因由接口的 reason 直接返回给这次操作。
        tunOverride = previous.override;
        tunEnabled = previous.enabled;
        if (previous.enabled) await enableIpv6Guard(); else await restoreIpv6Guard();
        await writeConfig().catch(() => {});
        await core?.reloadFromFile().catch(() => {});
        if (!core?.state().running) await restartKernel();
        throw error;
      }
    }
    return { tunEnabled, changed };
  }

  /** 切换出站模式只热加载规则，保留现有内核、隧道及选择器。 */
  async function setMode(mode) {
    if (strictEnabled) throw new Error("严格模式下全部流量使用固定出口；请先关闭严格模式再切换代理范围。");
    if (!["rule", "global", "direct"].includes(mode)) throw new Error(`未知出站模式：${mode}`);
    if (mode === egressMode) return { mode };
    const previous = egressMode;
    const running = Boolean(core);
    const original = await readFile(modeFile, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
    const applyMode = async reason => {
      if (!running) return;
      // 内核确实退出时才走恢复；正常切换不能停掉 TUN 后重新争用自己的端口。
      if (!core?.state().running) return reloadKernel(reason);
      lastHealthAt = null;
      lastTunnelCaptured = null;
      await writeConfig();
      await core.reloadFromFile({ removedSelectors: egressMode === "direct" ? [DEFAULT_AUTO_GROUP] : [] });
      if (!core.state().running) throw new Error("内核在切换代理范围后退出。");
      await core.status();
      if (tunEnabled) {
        const tunnel = await core.tunnelStatus({ waitMs: 4000 });
        if (!tunnel.active) throw new Error("切换代理范围后隧道未接管，请复检连接。");
        lastTunnelCaptured = true;
      }
      lastHealthAt = new Date().toISOString();
      lastError = null;
    };
    try {
      egressMode = mode;
      await applyMode("切换代理范围");
      await mkdir(stateDir, { recursive: true });
      const temporary = `${modeFile}.${process.pid}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ mode, updatedAt: new Date().toISOString() }), { mode: 0o600 });
        await rename(temporary, modeFile);
      } finally { await rm(temporary, { force: true }); }
    } catch (error) {
      egressMode = previous;
      try {
        if (original === null) await rm(modeFile, { force: true });
        else await writeFile(modeFile, original, { mode: 0o600 });
        await applyMode("回滚代理范围");
      } catch (rollback) { lastError = `${error.message}；回滚失败：${rollback.message}`; throw new Error(lastError, { cause: error }); }
      throw error;
    }
    return { mode };
  }

  async function select(name) {
    if (strictEnabled) throw new Error("严格模式下不能切换固定出口，请先关闭严格模式。");
    if (!core) return false;
    const previous = { selected: nodes.selected, probe: ipv6Probe };
    try {
      await core.selectProxy(DEFAULT_GROUP, name);
      nodes.selected = name;
      ipv6Probe = null;
      ipv6Protected = false;
      if (tunEnabled) {
        await probeSelectedNodeIpv6();
        await enableIpv6Guard();
        await writeConfig();
        await core.reloadFromFile();
        await confirmIpv6Protection();
      }
    } catch (error) {
      nodes.selected = previous.selected;
      ipv6Probe = previous.probe;
      try {
        await core.selectProxy(DEFAULT_GROUP, previous.selected);
        await writeConfig();
        await core.reloadFromFile();
        await confirmIpv6Protection();
      } catch (rollback) {
        ipv6Protected = false;
        lastError = `${error.message}；恢复原节点失败：${rollback.message}`;
        throw new Error(lastError, { cause: error });
      }
      throw error;
    }
    exitCountryCache = { code: null, at: 0 };
    // 用户/自动切换节点后旧证据不再适用：立即按新节点重新复检。
    lastVerifiedNode = null;
    resetExitEvidence();
    // 记住当前供应商选的节点：切换供应商再切回来时恢复，而不是回到第一个节点。
    nodes.sources = (nodes.sources ?? []).map((source) => source.id === nodes.activeId ? { ...source, selected: name } : source);
    await persist().catch((error) => logger(`[net-core] 保存节点选择失败：${error.message}`));
    // 换节点可能就是换国家：立即重算公共 DNS，不要等到下次启动。
    await syncPublicDns().catch((error) => logger(`[net-core] 切换后同步公共 DNS 失败：${error.message}`));
    return true;
  }

  /** 统一解析 IP 情报端点；字段缺失就返回 null，调用方负责报错。 */
  function exitFields(data) {
    const connection = data?.connection ?? {};
    const value = {
      ip: typeof data?.ip === "string" ? data.ip : null,
      countryCode: typeof data?.country_code === "string" ? data.country_code : (typeof data?.countryCode === "string" ? data.countryCode : null),
      country: typeof data?.country === "string" ? data.country : null,
      city: typeof data?.city === "string" ? data.city : null,
      timezone: typeof data?.timezone === "string" ? data.timezone : (typeof data?.timezone?.id === "string" ? data.timezone.id : null),
      asn: Number.isInteger(connection.asn) ? connection.asn : null,
      org: typeof connection.org === "string" ? connection.org : null,
      isp: typeof connection.isp === "string" ? connection.isp : null,
      domain: typeof connection.domain === "string" ? connection.domain : null,
    };
    return { ...value, hosting: isHostingExit(value) };
  }

  function parseExitPayload(text) {
    const data = JSON.parse(text);
    if (data?.success === false) return null;
    return exitFields(data);
  }

  /**
   * 经主内核的混合入口探测：配置里已有 `exitProbeHost → CLAUDE-PIN` 的规则，
   * 出站由主内核完成（TUN 模式下已绑定物理网卡），因此不会被自己的 TUN 截获。
   */
  async function probeFixedExitViaKernel({ timeoutMs = 8000 } = {}) {
    const text = await exitFetch(exitProbeUrl, {
      proxy: localProxy,
      userAgent: "EnvGuardCC/1.0",
      timeoutMs,
    });
    return parseExitPayload(text);
  }

  async function probeSelectedExit() {
    if (!core?.state().running) throw new Error("内核未运行，无法检测固定出口。");
    const actual = await core.request("/proxies");
    const name = actual?.proxies?.[DEFAULT_GROUP]?.now;
    if (!nodes.proxies.some(node => node.name === name)) throw new Error("固定出口组没有可验证的实际节点。");
    // 第三方节点常抖：单次握手失败不代表出口不可用，重试一次再判定。
    let result = null;
    let failure = null;
    for (let attempt = 0; attempt < 2 && !result; attempt += 1) {
      try {
        if (strictEnabled) {
          // 严格配置的所有规则只引用一个固定组；回环混合入口也明确使用该节点。
          result = parseExitPayload(await fetchTextViaProxy(env.CHECKCC_NET_CORE_EXIT_PROBE_URL || "https://ipwho.is/", { proxy: strictProxy, timeoutMs: 8000 }));
        } else result = await probeFixedExitViaKernel();
      } catch (error) {
        failure = error;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    if (!result?.ip || !result.countryCode) {
      throw new Error(`固定出口探测失败，未使用普通流量组的出口代替。${failure ? `原因：${failure.message}` : ""}`);
    }
    return result;
  }

  /** 区域锁定/恢复时给一个系统级提示；失败静默，不阻塞网络逻辑。 */
  function notifyClaude(title, message) {
    if (platform !== "darwin") return;
    const quote = (value) => String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ");
    execFile("/usr/bin/osascript", ["-e", `display notification "${quote(message)}" with title "${quote(title)}"`], () => {});
  }

  /** 只断开已建立的 Claude 连接：区域锁定不碰其他流量。 */
  async function closeClaudeConnections() {
    if (!core) return 0;
    const payload = await core.request("/connections").catch(() => null);
    let closed = 0;
    for (const connection of listConnections(payload)) {
      const metadata = connection?.metadata ?? {};
      if (!isClaudeHost(metadata.host ?? metadata.destinationIP ?? "")) continue;
      if (!connection.id) continue;
      await core.request(`/connections/${encodeURIComponent(connection.id)}`, { method: "DELETE" }).catch(() => {});
      closed += 1;
    }
    return closed;
  }

  /**
   * 区域锁定（只在本次运行内）：出口落回 Claude 不支持地区，或网络波动导致无法确认出口时，
   * 立即把 Claude 域名 REJECT 掉。网络锁会自动复检，连续验证通过后自动解除；
   * 只有连续多次确认出口确实不受支持时才升级为地区锁，地区锁需要用户显式复检解除。
   */
  async function lockRegion(exit, { type = "region", reason = "" } = {}) {
    const code = typeof exit?.countryCode === "string" ? exit.countryCode.toUpperCase() : null;
    const defaultReason = type === "network"
      ? "网络中断或波动，暂时无法确认固定出口；已阻断 Claude 流量，正在自动复检，恢复后自动解除。"
      : `固定出口${code ? ` ${code}` : ""} 不在 Claude 支持地区，已阻断 Claude 流量；请切换节点后复检解除。`;
    if (regionLock) {
      // 网络锁遇到明确的不支持地区时升级为地区锁，需要用户显式解除。
      if (type === "region" && regionLock.type !== "region") {
        regionLock = {
          ...regionLock, type: "region", autoRecover: false, ip: exit?.ip ?? regionLock.ip, countryCode: code,
          reason: reason || defaultReason, recovered: 0, recheckAt: new Date().toISOString(),
        };
        // 升级只需保持守卫组在 REJECT，不重载配置。
        await applyClaudeGuard(true);
        logger(`[net-core] ${regionLock.reason}`);
        notifyClaude("EnvGuardCC：Claude 已阻断", regionLock.reason);
      }
      return regionLock;
    }
    regionLock = {
      locked: true,
      type,
      ip: exit?.ip ?? null,
      countryCode: code,
      at: new Date().toISOString(),
      reason: reason || defaultReason,
      // 网络锁自动复检，并把进度带给界面；地区锁只能人工解除。
      autoRecover: type === "network",
      recovered: 0,
      recheckAttempts: 0,
      recheckAt: null,
    };
    if (core) {
      if (strictEnabled) {
        // 严格模式：REJECT 必须写进规则，它本来就要断掉全部非节点流量。
        try {
          await writeConfig();
          await core.reloadFromFile();
          // 已建立的 Claude 连接也要断掉；只断 Claude，不动其他连接。
          await closeClaudeConnections();
        } catch (error) {
          logger(`[net-core] 锁定配置热加载失败：${error.message}`);
        }
      } else {
        // 默认路径：只把 Claude 守卫组切到 REJECT。不重载配置、不重建内核，
        // 除 Claude 以外的流量和已建立的连接完全不受影响（force 重载会全断）。
        const blocked = await applyClaudeGuard(true);
        await closeClaudeConnections().catch((error) => logger(`[net-core] 关闭 Claude 连接失败：${error.message}`));
        if (!blocked) {
          // 守卫组切换失败时才退回旧路径：写 REJECT 规则并重载，宁可短暂断开也要保证 Claude 被阻断。
          try { await writeConfig({ forceBlockClaude: true }); await core.reloadFromFile(); }
          catch (error) { logger(`[net-core] 锁定配置热加载失败：${error.message}`); }
        }
      }
    }
    logger(`[net-core] ${regionLock.reason}`);
    notifyClaude("EnvGuardCC：Claude 已阻断", regionLock.reason);
    return regionLock;
  }

  /**
   * 复检出口：只有当前出口回到 Claude 支持地区才允许解除锁定。
   * 严格模式下同时把系统阻断重新放行（基线出口不允许被自动改掉）。
   */
  async function unlockRegion(exit = null) {
    const strictBlocked = strictEnabled && hostGuard?.phase !== "active";
    if (!regionLock && !strictBlocked) return { locked: false, regionLock: null, exit: null };
    const measured = exit ?? await probeSelectedExit();
    assertClaudeSupportedExit(measured);
    if (strictEnabled && strictBaselineIp && measured.ip && measured.ip !== strictBaselineIp) {
      throw new Error("固定出口 IP 与已确认基线不同，系统保持阻断。请关闭严格模式后明确确认新出口。");
    }
    const hadLock = Boolean(regionLock);
    regionLock = null;
    // 解除即视为已验证：保持连续通过计数，不让紧接着的下一次探测把刚放行的连接又锁回去。
    exitEvidence = { supported: NETWORK_RECOVERY_STREAK, unsupported: 0, failures: 0, lastAt: new Date().toISOString(), lastError: null };
    lastVerifiedNode = { name: await currentGroupNode() ?? nodes.selected, ip: measured.ip ?? null, countryCode: measured.countryCode ?? null, at: new Date().toISOString() };
    if (core) {
      if (strictEnabled) {
        await writeConfig();
        await core.reloadFromFile();
      } else {
        // 放行只需要把守卫组切回固定出口组：不重载配置，已建立的连接不会被重置。
        const released = await applyClaudeGuard(false);
        if (!released) {
          await writeConfig();
          await core.reloadFromFile();
        }
      }
    }
    // 严格模式：出口与基线一致且已验证，才自动放行系统阻断。
    if (strictEnabled && hostGuard?.phase !== "active") await hostAction("guard-activate");
    if (hadLock) {
      logger("[net-core] 固定出口已回到 Claude 支持地区，区域锁定解除。");
      notifyClaude("EnvGuardCC：Claude 已恢复", `固定出口 ${measured.countryCode ?? ""} 已通过复检，Claude 流量恢复。`);
    }
    scheduleExitCheck();
    return { locked: false, regionLock: null, exit: measured };
  }

  /**
   * 网络异常时的处置：claude（默认）只阻断 Claude 域名，其他流量照常；
   * all 才启用系统断流（封全部非节点流量）。设置落盘，重启后保持。
   */
  async function setNetworkFailurePolicy(policy) {
    if (policy !== "claude" && policy !== "all") throw new Error("网络异常处置只能是 claude 或 all。");
    if (policy === networkFailurePolicy) return { networkFailure: policy };
    const previous = networkFailurePolicy;
    networkFailurePolicy = policy;
    try {
      await mkdir(stateDir, { recursive: true });
      const temporary = `${GUARD_POLICY_FILE}.${process.pid}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ networkFailure: policy, updatedAt: new Date().toISOString() }), { mode: 0o600 });
        await rename(temporary, GUARD_POLICY_FILE);
      } finally { await rm(temporary, { force: true }); }
    } catch (error) {
      networkFailurePolicy = previous;
      throw error;
    }
    // 从「封全部」切回「仅 Claude」时，已建立的系统阻断要尽力放行；出口未验证则保持阻断。
    if (policy === "claude" && strictEnabled && hostGuard?.phase !== "active" && (!regionLock || regionLock.type === "network")) {
      await unlockRegion().catch((error) => logger(`[net-core] 切换为仅阻断 Claude 后未能放行系统阻断：${error.message}`));
    }
    return { networkFailure: policy };
  }

  /**
   * 未保护阻断：保护关闭时保持 TUN 接管，只对 Claude 域名 REJECT。
   * 关闭保护不再退回直连；要恢复 Claude 必须先开启保护。失败必须抛出，不能假装已阻断。
   */
  async function setUnprotectedGuard(enabled) {
    if (typeof enabled !== "boolean") throw new Error("未保护阻断开关必须是布尔值。");
    if (enabled) {
      const previousTunnel = tunEnabled;
      const reason = "保护未开启：Claude 已被阻断，开启环境防护后才能继续使用 Claude。";
      unprotectedLock = { active: true, at: new Date().toISOString(), reason };
      try {
        // 没有真实的系统接管时，配置里的 REJECT 不会作用于系统流量。
        // 这里不请求授权安装：用户是在关闭保护，弹 UAC 只会让人困惑。
        await setTunnel(true, { ensureHost: false });
        if (!core) throw new Error("网络内核未运行，Claude 阻断未生效。");
        await writeConfig();
        await core.reloadFromFile();
        // 非严格模式不把 REJECT 写进规则，改用守卫组切换：只断 Claude，不影响其他流量。
        if (!strictEnabled && !(await setClaudeGuard(true))) throw new Error("Claude 守卫组切换失败，Claude 阻断未生效。");
        await closeClaudeConnections();
        lastTunnelCaptured = await core.tunnelStatus().then(value => value.active).catch(() => null);
        if (lastTunnelCaptured !== true) throw new Error("系统流量接管未建立，Claude 阻断未生效。");
        lastHealthAt = new Date().toISOString();
      } catch (error) {
        unprotectedLock = null;
        // 本次为了阻断才打开的 TUN 要退回原状态，避免留下「没拦 Claude 却接管了流量」。
        try { if (tunEnabled !== previousTunnel) await setTunnel(previousTunnel); }
        catch { /* 回滚失败由 report 的隧道状态如实反映 */ }
        try { await writeConfig(); await core?.reloadFromFile(); } catch { /* 保留原始错误 */ }
        throw error;
      }
      logger("[net-core] 未开启保护，已阻断 Claude 域名");
      notifyClaude("EnvGuardCC：Claude 已阻断", reason);
      return report();
    }
    if (!unprotectedLock) return report();
    unprotectedLock = null;
    // 放行 Claude 只需要把守卫组切回固定出口组，不需要重载配置。
    await applyClaudeGuard(false);
    logger("[net-core] 未保护阻断已解除");
    return report();
  }

  /**
   * 出口地区变了（手动切节点 / 自动故障转移 / 订阅换节点）就把公共 DNS 换成新地区的，
   * 热加载生效，不重启内核、不断连接。
   */
  async function syncPublicDns() {
    if (strictEnabled) return { changed: false, dns: appliedPublicDns };
    if (!core || nodes?.state !== "ready") return { changed: false, dns: appliedPublicDns };
    const next = await publicDnsForSelection();
    if (appliedPublicDns && next.join() === appliedPublicDns.join()) return { changed: false, dns: next };
    const previous = appliedPublicDns;
    await writeConfig();
    await core.reloadFromFile();
    lastError = null;
    logger(`[net-core] 出口地区变化：公共 DNS ${(previous ?? []).join(", ") || "（未设置）"} → ${next.join(", ")}`);
    return { changed: true, dns: next, previous };
  }

  function startPublicDnsSync({ intervalMs = 60000 } = {}) {
    if (dnsTimer) return false;
    dnsTimer = setInterval(() => {
      void serialize(syncPublicDns)().catch((error) => logger(`[net-core] 公共 DNS 同步失败：${error.message}`));
    }, Math.max(15000, intervalMs));
    dnsTimer.unref?.();
    return true;
  }

  function stopPublicDnsSync() {
    if (!dnsTimer) return false;
    clearInterval(dnsTimer);
    dnsTimer = null;
    return true;
  }

  /**
   * 读取用户网络声明 + 它当前的真实产物。
   * 文件损坏时不抛错：界面需要能靠重新保存覆盖坏文件，而不是卡在只读错误上。
   */
  async function network() {
    const base = {
      path: networkConfigPath(stateDir, env),
      config: null,
      effective: null,
      problem: null,
      interfaces: listNetworkInterfaces(),
      pendingRestart: false,
      canRestart: Boolean(core) && nodes?.state === "ready",
    };
    let config;
    try { config = await loadLocalNetworkConfig(stateDir, env); }
    catch (error) { return { ...base, problem: error.message }; }
    try {
      return {
        ...base,
        config,
        effective: describeNetworkConfig(config, { proxies: nodes?.state === "ready" ? nodes.proxies : null }),
        pendingRestart: appliedNetwork !== null && appliedNetwork !== fingerprintNetwork(config),
      };
    } catch (error) {
      // 字段本身不合法（例如手改了坏 IP）：照样把原文件回给界面，并说明启动会失败。
      return { ...base, config, problem: error.message };
    }
  }

  /** 保存用户网络声明；restart=true 时重建配置并重启内核，让改动立即生效。 */
  async function saveNetwork(config, { restart = false } = {}) {
    if (strictEnabled) throw new Error("严格模式不允许修改内网或路由例外。");
    validateNetworkConfig(config, { proxies: nodes?.state === "ready" ? nodes.proxies : null });
    if (restart && !core) throw new Error("内核未运行；请先启动内核，或只保存配置。");
    const file = networkConfigPath(stateDir, env);
    const original = await readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
    try {
      await saveLocalNetworkConfig(stateDir, config, env);
      if (restart) await reloadKernel("更新内网配置");
    } catch (error) {
      try {
        if (original === null) await rm(file, { force: true });
        else await saveLocalNetworkConfig(stateDir, JSON.parse(original), env);
        if (restart) await reloadKernel("回滚内网配置");
      } catch (rollback) { lastError = `${error.message}；回滚失败：${rollback.message}`; throw new Error(lastError, { cause: error }); }
      throw error;
    }
    return network();
  }

  /**
   * 用内核真实解析一次域名：这是唯一可信的判定——普通进程直接查内网 DNS 会被 strict-route 拦住（实测 ETIMEOUT）。
   * 有未生效的改动时先落盘并重建，否则测的是旧策略，结论会骗人。
   */
  async function verifyDomain(config, name) {
    const domain = String(name ?? "").trim().toLowerCase();
    if (!/^[a-z0-9.-]{1,253}$/.test(domain) || domain.startsWith(".") || domain.endsWith(".")) throw new Error("请填写有效的域名（不含 http:// 或端口）。");
    validateNetworkConfig(config, { proxies: nodes?.state === "ready" ? nodes.proxies : null });
    if (!core) throw new Error("内核未运行，无法测试解析；请先启动保护。");
    const saved = await loadLocalNetworkConfig(stateDir, env).catch(() => ({}));
    let restarted = false;
    if (appliedNetwork !== fingerprintNetwork(config) || fingerprintNetwork(saved) !== fingerprintNetwork(config)) {
      await saveNetwork(config, { restart: true });
      restarted = true;
    }
    const started = Date.now();
    const answer = await core.request(`/dns/query?name=${encodeURIComponent(domain)}&type=A`);
    return summarizeDnsAnswer(answer, { name: domain, restarted, elapsedMs: Date.now() - started });
  }

  if (disabledReason()) await claudeProxy?.restore();
  return {
    enabled: !disabledReason(), reason: disabledReason(),
    start: serialize(start),
    connectionLog,
    stop: serialize(async () => { stopHealthMonitor(); stopAutoRefresh(); stopPublicDnsSync(); await stop(); }),
    report, connectionState, verifyConnection: serialize(verifyConnection, false), select: serialize(select), delay, setMode: serialize(setMode), network,
    saveNetwork: serialize(saveNetwork), verifyDomain: serialize(verifyDomain), importNodes: serialize((...args) => nodeTransaction(() => importNodes(...args))),
    refresh: serialize((...args) => nodeTransaction(() => refresh(...args))), sources,
    activateSource: serialize((...args) => nodeTransaction(() => activateSource(...args))),
    deleteSource: serialize((...args) => nodeTransaction(() => deleteSource(...args))),
    renameSource: serialize((...args) => nodeTransaction(() => renameSourceConfig(...args))), startAutoRefresh, stopAutoRefresh,
    syncPublicDns: serialize(syncPublicDns), startPublicDnsSync, stopPublicDnsSync,
    allowDirectSubscription: serialize(allowDirectSubscription), collectDelays,
    setTunnel: serialize(async (enabled, options) => {
      const previous = tunEnabled;
      const result = await setTunnel(enabled, options);
      const temporary = `${connectionFile}.${process.pid}.tmp`;
      try {
        await mkdir(stateDir, { recursive: true });
        await writeFile(temporary, JSON.stringify({ tunEnabled: enabled }), { mode: 0o600 });
        await rename(temporary, connectionFile);
        savedTunnel = enabled;
      } catch (error) {
        try { await setTunnel(previous); }
        catch (rollback) { lastError = `${error.message}；隧道回滚失败：${rollback.message}`; }
        throw error;
      } finally { await rm(temporary, { force: true }); }
      return result;
    }),
    probeNodeExits: serialize(probeNodeExits), probeSelectedExit: serialize(probeSelectedExit), unlockRegion: serialize(unlockRegion), setNetworkFailurePolicy: serialize(setNetworkFailurePolicy), setUnprotectedGuard: serialize(setUnprotectedGuard), refreshHost: serialize(refreshHost), installHost: serialize(installHost),
    setStrictMode: serialize(async enabled => {
      if (typeof enabled !== "boolean") throw new Error("严格模式开关必须是布尔值。");
      await refreshHost();
      if (!hostMode || platform !== "darwin") throw new Error("严格模式需要已更新的 macOS 特权宿主；当前平台不能降级开启。");
      if (enabled) {
        const health = await (fetchImpl ?? globalThis.fetch)(`${hostUrl}/health`, { headers: { "X-EnvGuardCC-Host-Token": hostToken }, signal: AbortSignal.timeout(3000) });
        hostGuard = (await health.json()).guard ?? null;
        if (hostGuard?.supported !== true || hostGuard.provider !== "macos-pf") throw new Error("严格模式需要升级 macOS 特权宿主，请重新授权安装。");
        await hostAction("guard-status");
        if (disabledReason()) throw new Error(disabledReason());
        const wasStrict = strictEnabled, wasRunning = Boolean(core);
        strictEnabled = true;
        await persistStrict();
        try { await reloadKernel("开启严格模式"); }
        catch (error) {
          try {
            const health = await (fetchImpl ?? globalThis.fetch)(`${hostUrl}/health`, { headers: { "X-EnvGuardCC-Host-Token": hostToken }, signal: AbortSignal.timeout(3000) });
            hostGuard = (await health.json()).guard ?? null;
          } catch { /* 未知时保持严格意愿，不假定阻断已经解除 */ }
          if (hostGuard?.armed === false && !wasStrict) {
            strictEnabled = false; await persistStrict();
            if (wasRunning) {
              try { await reloadKernel("严格模式未建立，恢复普通代理"); }
              catch (rollback) { lastError = `${error.message}；普通代理恢复失败：${rollback.message}`; }
            }
          }
          throw error;
        }
      } else {
        await persistStrict(false, null);
        try { await hostAction("guard-release"); }
        catch (error) { await persistStrict(); throw error; }
        strictEnabled = false; strictBaselineIp = null;
        if (core) await reloadKernel("关闭严格模式");
      }
      return { strictMode: strictEnabled, guard: hostGuard };
    }),
  };
}
