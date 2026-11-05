// 内核运行时封装：把"是否启用、用哪个二进制、用哪些节点、当前路由证据"收敛成一个对象。
// 供 scripts/dev.mjs、desktop/backend.mjs 与网关导入接口共用。
//
// 规则：
//   - 没有二进制、没有节点、环境变量显式关闭，都返回可读原因，而不是假装可用；
//   - 导入节点后必须重建配置并重启内核，否则界面会显示旧节点；
//   - 导入失败不覆盖已有节点配置。

import { access, mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_AUTO_GROUP, DEFAULT_FAKE_IP_RANGE, DEFAULT_GROUP, DEFAULT_ROUTE_EXCLUSIONS, LOCAL_DIRECT_PROXY, assertKernelConfig, buildKernelConfig, ingressSummary, inIpv4Range, serializeKernelConfig } from "./config.mjs";
import { routingEvidence, routingSummary } from "./routes.mjs";
import { publicDnsForCountry, resolvePublicDns } from "./public-dns.mjs";
import { fetchSubscription, fetchTextViaProxy, normalizeProxies, parseSubscription } from "./subscription.mjs";
import { elevationStatus } from "./privilege.mjs";
import { findPortOwner } from "./ports.mjs";
import { loadVerifiedNodeHosts, resolveNodeHosts } from "./node-dns.mjs";
import { createNetCore } from "../net-core.mjs";

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

/** 节点配置文件：{ proxies: [...], selected?: string } */
export async function loadNodes(stateDir) {
  const file = nodesFilePath(stateDir);
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(raw?.proxies) || !raw.proxies.length) return { state: "empty", file };
    return { state: "ready", file, proxies: raw.proxies, selected: raw.selected, source: raw.source ?? null, proxyServerDns: Array.isArray(raw.proxyServerDns) ? raw.proxyServerDns : null };
  } catch (error) {
    if (error.code === "ENOENT") return { state: "missing", file };
    return { state: "invalid", file, reason: error.message };
  }
}

/** 原子写入节点配置：先写临时文件再 rename，避免中途失败留下半个文件。 */
export async function saveNodes(stateDir, { proxies, selected = null, source = null, proxyServerDns = null }) {
  const file = nodesFilePath(stateDir);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const content = `${JSON.stringify({ proxies, selected, source, proxyServerDns, updatedAt: new Date().toISOString() }, null, 2)}\n`;
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
export async function createKernelRuntime({ stateDir, env = process.env, root, logger = () => {}, spawn, fetchImpl, lookup, download, platform = process.platform } = {}) {
  const binary = await resolveKernelBinary({ stateDir, env, platform, root });
  // 特权宿主模式：优先用显式环境变量；否则尝试读取安装器写入的令牌并探测宿主健康。
  // 探测失败就回退本机 spawn，避免"装了但没跑起来"时整个网络面板不可用。
  let hostUrl = env.CHECKCC_NET_CORE_HOST || null;
  let hostToken = env.CHECKCC_NET_CORE_HOST_TOKEN || null;
  /** 重新探测特权宿主：装宿主与启动应用有先后关系，不能在构造时探一次就定终身。 */
  async function detectHost() {
    if (env.CHECKCC_NET_CORE_HOST && env.CHECKCC_NET_CORE_HOST_TOKEN) {
      hostUrl = env.CHECKCC_NET_CORE_HOST;
      hostToken = env.CHECKCC_NET_CORE_HOST_TOKEN;
      return true;
    }
    try {
      const token = (await readFile(path.join(stateDir, "host-token"), "utf8")).trim();
      const candidate = hostUrl || "http://127.0.0.1:39091";
      const health = await (fetchImpl ?? globalThis.fetch)(`${candidate}/health`, { headers: { "X-EnvGuardCC-Host-Token": token }, signal: AbortSignal.timeout(1500) });
      if (!health.ok) return false;
      hostUrl = candidate;
      hostToken = token;
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

  const apiPort = Number(env.CHECKCC_NET_CORE_API_PORT || DEFAULT_API_PORT);
  // 本机代理端口：内核启动后对外提供 HTTP/SOCKS 混合代理，不再依赖 FlClash 之类的系统代理。
  // 出站模式：rule=海外走节点（默认），global=全部走节点，claude=只代理 Claude，direct=全直连。
  const modeFile = path.join(stateDir, "net-core-mode.json");
  let egressMode = env.CHECKCC_NET_CORE_MODE || null;
  if (!egressMode) {
    try { egressMode = JSON.parse(await readFile(modeFile, "utf8"))?.mode ?? null; } catch { /* 首次运行没有存档 */ }
  }
  egressMode = ["claude", "rule", "global", "direct"].includes(egressMode) ? egressMode : "rule";
  const mixedPort = Number(env.CHECKCC_NET_CORE_MIXED_PORT || 39080);
  const localProxy = `http://127.0.0.1:${mixedPort}`;
  let ownedProxyEnv = false;
  // 宿主模式默认接管 TUN（装宿主就是为了建网卡）；本机直连模式需显式开启。
  // 不能写成 const：launch() 会重新探测宿主后重算，否则「先启动应用、后装宿主」会让 TUN 永久写死成关闭。
  const resolveTunEnabled = () => (hostMode ? env.CHECKCC_NET_CORE_TUN !== "0" : env.CHECKCC_NET_CORE_TUN === "1");
  let tunEnabled = resolveTunEnabled();
  // 关闭保护只关 TUN（内核继续跑，节点延迟/切换仍然可用）；显式 null 表示跟随默认。
  let tunOverride = null;
  const configPath = path.join(stateDir, "net-core", "config.yaml");
  const homeDir = path.join(stateDir, "net-core");
  let core = null;
  let lastError = null;
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
  async function probeExitCountry() {
    if (!core) return null;
    const now = Date.now();
    if (exitCountryCache.code && now - exitCountryCache.at < EXIT_COUNTRY_TTL_MS) return exitCountryCache.code;
    try {
      // 必须经内核的混合端口走出去：TUN 关闭时（保护暂停）普通请求会走直连，测到的是家里 IP。
      const text = await fetchTextViaProxy("https://ipwho.is/", { proxy: localProxy, userAgent: "EnvGuardCC/1.0", timeoutMs: 4000 });
      const data = JSON.parse(text);
      const code = data?.success === false ? null : (typeof data?.country_code === "string" ? data.country_code : null);
      if (code) exitCountryCache = { code, at: now };
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
    const measured = await probeExitCountry();
    if (measured) return publicDnsForCountry(measured);
    return resolvePublicDns({ node, probe: probeCountry });
  }

  async function writeConfig() {
    const localNetwork = await loadLocalNetworkConfig(stateDir, env);
    appliedNetwork = fingerprintNetwork(localNetwork);
    const publicDns = await publicDnsForSelection();
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
      mixedPort,
      egressMode,
      localNetwork,
      publicDns,
      proxyServerDns: Array.isArray(nodes.proxyServerDns) && nodes.proxyServerDns.length ? nodes.proxyServerDns : undefined,
      extraRules: [
        ...(Array.isArray(env.CHECKCC_NET_CORE_RULES) ? env.CHECKCC_NET_CORE_RULES : []),
        // 订阅域名直连：机场按来源 IP 放行，走节点会被 403。放在 MATCH 之前即可生效。
        ...directHosts.map((host) => `DOMAIN-SUFFIX,${host},DIRECT`),
      ],
    });
    // 生成即校验：配置一旦不再满足置顶/select/故障转移的不变量，就在这里拒绝启动，
    // 而不是让内核带着“兜底单节点”跑起来、等节点掉线才暴露成境外全断。
    assertKernelConfig(config, { egressMode, strictRoute: localNetwork.strictRoute ?? true });
    // 开发者默认不接管系统路由；显式设置 CHECKCC_NET_CORE_TUN=1 才启用。
    config.tun.enable = tunEnabled;
    await mkdir(homeDir, { recursive: true });
    await writeFile(configPath, serializeKernelConfig(config), { mode: 0o600 });
  }

  async function hostAction(action) {
    const response = await (fetchImpl ?? globalThis.fetch)(`${hostUrl}/kernel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-EnvGuardCC-Host-Token": hostToken },
      body: JSON.stringify({ action, configPath }),
      signal: AbortSignal.timeout(30000),
    });
    const value = await response.json().catch(() => null);
    if (!response.ok || value?.ok === false) throw new Error(value?.reason ?? `宿主返回 ${response.status}`);
    return value;
  }

  async function launch() {
    // 每次启动都重新探测宿主：否则「先开应用、后装宿主」的次序会让 TUN 一直被当成未启用。
    const nextHostMode = await detectHost();
    if (nextHostMode !== hostMode) logger(`[net-core] 特权宿主状态变化：${hostMode ? "可用 → 不可用" : "不可用 → 可用"}。`);
    hostMode = nextHostMode;
    tunEnabled = tunOverride ?? resolveTunEnabled();
    // 已知的订阅地址一律直连（重启后也保持）。
    if (nodes?.source?.url) {
      try {
        const known = new URL(nodes.source.url).hostname.toLowerCase();
        if (known && !directHosts.includes(known)) directHosts = [...directHosts, known];
      } catch { /* 来源不是 URL（手工/文件）*/ }
    }
    await writeConfig();
    if (hostMode) {
      // 宿主可能还挂着一台它自己认为「没在跑」的遗留内核，先让它收掉再启动。
      await hostAction("stop").catch(() => {});
      await hostAction("start");
    }
    core = createNetCore({ binary, homeDir, configPath, apiPort, verifyTunnel: () => tunEnabled && env.CHECKCC_NET_CORE_VERIFY_TUN !== "0", manageProcess: !hostMode, spawn, fetchImpl, lookup, logger });
    await core.start();
    // 内核可用后，把本进程的出站流量指向我们自己的代理端口；停止时恢复，避免影响其它功能。
    if (!env.CHECKCC_PROXY) { env.CHECKCC_PROXY = localProxy; ownedProxyEnv = true; }
  }

  async function start() {
    if (disabledReason()) return false;
    try {
      if (!core || !core.state().running) await launch();
      else await core.start();
      lastError = null;
      return true;
    } catch (error) {
      lastError = error.message;
      logger(`[net-core] 内核启动失败：${error.message}`);
      return false;
    }
  }

  async function stop() {
    stopPublicDnsSync();
    if (ownedProxyEnv) { delete env.CHECKCC_PROXY; ownedProxyEnv = false; }
    if (hostMode) {
      try { await hostAction("stop"); }
      catch (error) { logger(`[net-core] 宿主停止失败：${error.message}（遗留内核可能仍在接管流量）`); }
      core = null;
      // 关掉后确认端口真的释放：没释放就是内核还在跑，TUN 也不会退（实测事故）。
      const still = await findPortOwner(apiPort).catch(() => null);
      if (still) logger(`[net-core] 端口 ${apiPort} 仍被进程 ${still} 占用：内核未真正停止。`);
      return;
    }
    if (!core) return;
    try { await core.stop(); }
    catch (error) { logger(`[net-core] 内核停止失败：${error.message}`); }
  }

  /**
   * 导入节点：校验 → 落盘 → 若内核在用则重建配置并重启。
   * 解析阶段已经失败的内容不会走到这里，因此不会覆盖已有配置。
   */
  async function importNodes(input, { selected = null, source = null, append = false, proxyServerDns = null } = {}) {
    // append：本地代理这类额外出口是「加一个」而不是「换一批」，不能把已有订阅抹掉。
    const existing = append && nodes?.state === "ready" ? nodes.proxies : [];
    const { proxies, skipped } = normalizeProxies([...existing, ...(Array.isArray(input) ? input : [])]);
    if (!proxies.length) throw new Error("没有可用的节点（全部条目缺少必要字段）。");
    const chosen = selected && proxies.some((node) => node.name === selected) ? selected : (nodes?.selected && proxies.some((node) => node.name === nodes.selected) ? nodes.selected : proxies[0].name);
    // 显式传 null 表示"手工/粘贴导入"，必须清掉旧的订阅来源，否则自动更新会用旧订阅覆盖手工节点。
    const nextSource = source === undefined ? (nodes?.source ?? null) : source;
    // 本地代理没有订阅 DNS 概念：保留原值，别把有用的解析器覆盖成 null。
    const nextProxyDns = proxyServerDns ?? nodes?.proxyServerDns ?? null;
    await saveNodes(stateDir, { proxies, selected: chosen, source: nextSource, proxyServerDns: nextProxyDns });
    nodes = { state: "ready", proxies, selected: chosen, source: nextSource, proxyServerDns: nextProxyDns, file: nodesFilePath(stateDir) };
    const wasRunning = Boolean(core);
    if (wasRunning) {
      await stop();
      core = null;
      try { await launch(); }
      catch (error) { lastError = error.message; logger(`[net-core] 导入后重启失败：${error.message}`); }
    }
    return { imported: proxies.length, skipped, selected: chosen };
  }

  /** 订阅刷新：仅支持从链接导入的节点；失败保留现有配置。 */
  async function refresh({ force = false, intervalMs = 6 * 60 * 60 * 1000 } = {}) {
    const source = nodes?.source;
    if (!source || source.mode !== "url" || !source.url) throw new Error("当前节点不是从订阅链接导入的，无法自动更新。");
    if (!force && source.updatedAt) {
      const due = Date.parse(source.updatedAt) + Number(source.intervalHours ?? intervalMs / 3600000) * 3600000;
      if (Number.isFinite(due) && Date.now() < due) return { skipped: true, reason: "尚未到更新时间", nextAt: new Date(due).toISOString() };
    }
    const parsed = parseSubscription(await fetchSubscription(source.url, download ? { download } : {}));
    const { skipped: skippedItems, ...result } = await importNodes(parsed.proxies, { source: { ...source, updatedAt: new Date().toISOString() }, proxyServerDns: Array.isArray(parsed.proxyServerDns) ? parsed.proxyServerDns : null });
    return { skipped: false, ...result, skippedItems };
  }

  let refreshTimer = null;
  let dnsTimer = null;
  function startAutoRefresh({ intervalMs = 6 * 60 * 60 * 1000 } = {}) {
    if (refreshTimer) return false;
    refreshTimer = setInterval(() => { void refresh({ intervalMs }).catch((error) => logger(`[net-core] 订阅更新失败：${error.message}`)); }, Math.max(60000, intervalMs));
    refreshTimer.unref?.();
    return true;
  }
  function stopAutoRefresh() { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } }

  async function report() {
    const reason = disabledReason();
    const base = {
      enabled: !reason, demo: nodes?.demo === true, tunEnabled, hostMode, binary, apiPort,
      nodes: Array.isArray(nodes?.proxies) ? nodes.proxies.map((node) => node.name) : [],
      selected: nodes?.selected ?? null,
      publicDns: appliedPublicDns,
      source: nodes?.source ?? null, mode: egressMode,
      localProxy,
      elevation: hostMode
        ? { elevated: true, platform, instruction: "内核由特权宿主托管。" }
        : elevationStatus({ platform }),
    };
    if (reason) return { ...base, state: "disabled", reason };
    if (!core) return { ...base, state: "idle" };
    if (lastError) return { ...base, state: "error", reason: lastError };
    try {
      const status = await core.status();
      const evidence = routingEvidence(status.connections, { group: DEFAULT_GROUP });
      const group = status.proxies?.proxies?.[DEFAULT_GROUP];
      const autoGroup = status.proxies?.proxies?.[DEFAULT_AUTO_GROUP];
      // tunEnabled 只是「配置里开了」；tunCaptured 才是「网卡真的接管了流量」。两者必须分开显示，
      // 否则「开了但没接管」和「没开」在界面上长得一模一样。
      const tunCaptured = tunEnabled ? await core.tunnelStatus().then((value) => value.active).catch(() => null) : null;
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
        pending = delay(name, 3000).then((value) => { delayCache.set(name, { value, at: Date.now() }); return value; })
          .catch(() => { delayCache.set(name, { value: null, at: Date.now() }); return null; })
          .finally(() => { delayInflight.delete(name); });
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
    try {
      // 端口段会撞上 Windows 保留区间（实测直接 RST），所以按块申请并在就绪后实测可连。
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const basePort = await pickPortBlock(wanted.length + 2, { start: 39481 + attempt * 200 });
        const mixedPort = basePort - 2;
        const apiPort = basePort - 1;
        const config = buildProbeConfig({ proxies: nodes.proxies, names: wanted, basePort, mixedPort, hosts: nodeHostsCache, proxyServerDns: Array.isArray(nodes.proxyServerDns) ? nodes.proxyServerDns : [] });
        const configPath = path.join(dir, "probe-" + attempt + ".yaml");
        await write(configPath, serializeKernelConfig(config), { mode: 0o600 });
        const probeCore = createNetCore({ binary, homeDir: dir, configPath, apiPort, manageProcess: true, spawn, fetchImpl, logger });
        try {
          await probeCore.start();
          const reachable = await Promise.all(config.listeners.map((listener) => canConnect(listener.port)));
          if (!reachable.some(Boolean)) throw new Error("探测入站端口不可用（段 " + basePort + "）");
          const results = await Promise.all(config.listeners.map(async (listener) => {
            try {
              const text = await fetchTextViaProxy("https://ipwho.is/", { proxy: "http://127.0.0.1:" + listener.port, userAgent: "EnvGuardCC/1.0", timeoutMs: 6000 });
              const data = JSON.parse(text);
              const value = data?.success === false ? null : { countryCode: typeof data?.country_code === "string" ? data.country_code : null, country: typeof data?.country === "string" ? data.country : null, ip: typeof data?.ip === "string" ? data.ip : null };
              return [listener.proxy, value];
            } catch { return [listener.proxy, "__retry__"]; }
          }));
          const failed = results.filter(([, value]) => value === "__retry__").length;
          // 大面积失败通常不是节点问题而是端口段被系统占用：换一段再试。
          if (failed && failed === results.length && attempt < 2) { lastError = new Error("探测请求全部失败"); continue; }
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
      for (const [name, value] of Object.entries(parallel)) exitCache.set(name, { value, at: Date.now() });
      return parallel;
    } catch (error) {
      logger(`[net-core] 并行出口探测不可用（${error.message}），退回串行。`);
    }
    const wanted = requested;
    const original = await core.request("/proxies").then((value) => value?.proxies?.[DEFAULT_GROUP]?.now ?? nodes.selected).catch(() => nodes.selected);
    const result = {};
    try {
      for (const name of wanted) {
        const hit = exitCache.get(name);
        if (hit && Date.now() - hit.at < EXIT_CACHE_TTL_MS) { result[name] = hit.value; continue; }
        try {
          await core.selectProxy(DEFAULT_GROUP, name);
          const text = await fetchTextViaProxy("https://ipwho.is/", { proxy: localProxy, userAgent: "EnvGuardCC/1.0", timeoutMs: 5000 });
          const data = JSON.parse(text);
          const value = data?.success === false ? null : { countryCode: typeof data?.country_code === "string" ? data.country_code : null, country: typeof data?.country === "string" ? data.country : null, ip: typeof data?.ip === "string" ? data.ip : null };
          exitCache.set(name, { value, at: Date.now() });
          result[name] = value;
        } catch {
          exitCache.set(name, { value: null, at: Date.now() });
          result[name] = null;
        }
      }
    } finally {
      // 测完必须还原，不能把用户的选中节点留在最后一个被探测的节点上。
      if (original) await core.selectProxy(DEFAULT_GROUP, original).catch(() => {});
    }
    return result;
  }
  /**
   * 只切换 TUN 接管，不动内核进程：
   * 关闭保护时内核继续跑（节点仍可测速/切换，本机 39080 仍可当代理用），只是不再接管系统流量。
   */
  async function setTunnel(enabled) {
    const next = Boolean(enabled);
    if (next === tunEnabled && tunOverride !== null) return { tunEnabled, changed: false };
    tunOverride = next;
    const changed = next !== tunEnabled;
    tunEnabled = next;
    if (core && nodes?.state === "ready") {
      await writeConfig();
      // 热加载而非重启：切换 TUN 不该把节点选择、连接状态全部重置。
      await core.reloadFromFile();
      lastError = null;
      logger(`[net-core] TUN ${next ? "已接管" : "已退出"}（内核保持运行）。`);
    }
    return { tunEnabled, changed };
  }

  /** 切换出站模式：写盘后重建配置；内核在跑时重启使其生效。 */
  async function setMode(mode) {
    if (!["claude", "rule", "global", "direct"].includes(mode)) throw new Error(`未知出站模式：${mode}`);
    egressMode = mode;
    await writeFile(modeFile, JSON.stringify({ mode, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    if (core) {
      await stop();
      await launch();
    }
    return { mode };
  }

  async function select(name) {
    if (!core) return false;
    await core.selectProxy(DEFAULT_GROUP, name);
    nodes.selected = name;
    // 换节点可能就是换国家：立即重算公共 DNS，不要等到下次启动。
    await syncPublicDns().catch((error) => logger(`[net-core] 切换后同步公共 DNS 失败：${error.message}`));
    return true;
  }

  /**
   * 出口地区变了（手动切节点 / 自动故障转移 / 订阅换节点）就把公共 DNS 换成新地区的，
   * 热加载生效，不重启内核、不断连接。
   */
  async function syncPublicDns() {
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
      void syncPublicDns().catch((error) => logger(`[net-core] 公共 DNS 同步失败：${error.message}`));
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
    validateNetworkConfig(config, { proxies: nodes?.state === "ready" ? nodes.proxies : null });
    await saveLocalNetworkConfig(stateDir, config, env);
    if (restart) {
      if (!core) throw new Error("内核未运行；配置已保存，启动内核后生效。");
      await stop();
      await launch();
      lastError = null;
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
      await saveLocalNetworkConfig(stateDir, config, env);
      await stop();
      await launch();
      lastError = null;
      restarted = true;
    }
    const started = Date.now();
    const answer = await core.request(`/dns/query?name=${encodeURIComponent(domain)}&type=A`);
    return summarizeDnsAnswer(answer, { name: domain, restarted, elapsedMs: Date.now() - started });
  }

  return { enabled: !disabledReason(), reason: disabledReason(), start, stop, report, select, delay, setMode, network, saveNetwork, verifyDomain, importNodes, refresh, startAutoRefresh, stopAutoRefresh, syncPublicDns, startPublicDnsSync, stopPublicDnsSync, allowDirectSubscription, collectDelays, setTunnel, probeNodeExits };
}
