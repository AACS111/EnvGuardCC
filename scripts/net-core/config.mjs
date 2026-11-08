// EnvGuardCC 网络内核配置生成器：把"Claude 环境画像"翻译成 mihomo 配置。
// 设计约束（回归测试会断言）：
//   1. Claude 家族域名规则必须置顶，且优先于任何订阅规则；
//   2. Claude 出口组固定为 select，禁止 url-test 自动切节点（IP 漂移本身就是风控信号）；
//   3. tun.strict-route 默认开启；公司 VPN 的 Windows DNS 兼容需用户显式关闭；
//   4. IPv6 关闭，避免双栈旁路；DNS 使用 fake-ip 且 respect-rules，查询也走隧道；
//      境外域名的解析器必须与出口地区一致（anycast 会被 GeoIP 标成别的国家），见 public-dns.mjs；
//   5. 最后一条规则必须是 MATCH，否则内核拒绝启动；
//   6. 非 Claude 流量的兜底出口是带健康检查的故障转移组（fallback / url-test），
//      不允许绑定单个节点：单节点抖动会让全部境外流量 fail-closed 中断（FlClash 同样用组兜底）。

import { isIP } from "node:net";
import { ANYCAST_DOH } from "./public-dns.mjs";

export const CLAUDE_DOMAINS = [
  "anthropic.com",
  "claude.ai",
  "claude.com",
  "claudeusercontent.com",
  // 网页登录所依赖的人机验证通道，属于 Claude 生态，缺它会导致登录态异常。
  "challenges.cloudflare.com",
];

export const DEFAULT_GROUP = "CLAUDE-PIN";
// 非 Claude 流量的兜底组：必须能自动故障转移，绝不能是只含一个节点的 select。
export const DEFAULT_AUTO_GROUP = "AUTO-PROXY";
export const DEFAULT_AUTO_GROUP_TYPE = "fallback";
export const AUTO_GROUP_TYPES = new Set(["fallback", "url-test"]);
// 与 FlClash 一致：用 204 探针定时体检，节点连续失败后由组自动换到下一个可用节点。
// fallback 只在失败时切换（不因延迟抖动换出口），url-test 才使用 tolerance。
export const DEFAULT_HEALTH_CHECK = { url: "https://www.gstatic.com/generate_204", interval: 300, tolerance: 50, lazy: false };
// 网络可观测面：TLS 握手指纹要与声明面一致，STUN/UDP 不洩漏。
// （字体/Emoji 属于系统事实，内核无法伪造，不在这里假装能做到。）
export const DEFAULT_CLIENT_FINGERPRINT = "chrome";
export const TLS_PROXY_TYPES = new Set(["vless", "vmess", "trojan", "hysteria", "hysteria2", "tuic", "anytls"]);
export const STUN_PORTS = [3478, 5349, 19302, 19303];
export const LOCAL_DNS_PROXY = "ENVGUARD-LOCAL-DNS";
export const LOCAL_DIRECT_PROXY = "ENVGUARD-LOCAL-DIRECT";
export const DEFAULT_FAKE_IP_RANGE = "198.18.0.1/16";
export const DEFAULT_FINAL_RULE = "MATCH,DIRECT";
export const EGRESS_MODES = ["rule", "global", "direct"];

/**
 * 入口归组：节点可能共用同一个入口服务器（实测：37 个节点 = 1 个入口 IP + 22 个端口）。
 * 共享入口时「故障转移」是空转——入口挂了所有节点一起挂，换的只是端口。
 */
export function ingressSummary(proxies, { hosts = {} } = {}) {
  const map = new Map();
  for (const node of Array.isArray(proxies) ? proxies : []) {
    const server = typeof node?.server === "string" ? node.server.trim().toLowerCase() : "";
    if (!server) continue;
    // 关键：多个入口域名可能解析到同一个 IP —— 那才是真正的共享入口。
    const resolved = Array.isArray(hosts?.[node?.server]) ? hosts[node.server][0] : null;
    const key = resolved ?? server;
    map.set(key, [...(map.get(key) ?? []), node?.name]);
  }
  const groups = [...map].map(([server, names]) => ({ server, count: names.length, nodes: names }));
  return { total: Array.isArray(proxies) ? proxies.length : 0, entries: groups.length, shared: groups.length === 1 && groups[0].count > 1, groups };
}

// 内置的国内域名直连清单：不依赖 GeoSite/GeoIP 数据文件，离线也能工作。
// 未收录的国内站点会走节点（更慢但不会泄漏），可通过 extraRules 或 Geo 数据增强。
export const CN_DIRECT_DOMAINS = [
  "cn", "gov.cn", "edu.cn", "baidu.com", "bdimg.com", "bdstatic.com", "qq.com", "qpic.cn", "gtimg.cn", "tencent.com",
  "weixin.qq.com", "wechat.com", "alicdn.com", "aliyun.com", "alipay.com", "taobao.com", "tmall.com", "alibaba.com",
  "jd.com", "360buyimg.com", "pinduoduo.com", "yangkeduo.com", "meituan.com", "dianping.com", "ele.me", "ctrip.com",
  "ly.com", "12306.cn", "bilibili.com", "hdslb.com", "iqiyi.com", "youku.com", "douyin.com", "kuaishou.com",
  "weibo.com", "sina.com.cn", "sinaimg.cn", "zhihu.com", "zhimg.com", "douban.com", "xueqiu.com", "sohu.com",
  "163.com", "126.net", "netease.com", "xiaomi.com", "mi.com", "huawei.com", "oppo.com", "vivo.com",
  "bytedance.com", "toutiao.com", "csdn.net", "cnblogs.com", "gitee.com", "oschina.net", "jianshu.com",
  "ithome.com", "cnbeta.com", "zol.com.cn", "pconline.com.cn", "eastmoney.com", "10jqka.com.cn", "hexun.com",
  "qcloud.com", "myqcloud.com", "aliyuncs.com", "jdcloud.com", "volces.com", "bytecdn.cn",
];


// 私网保留原网卡/VPN 路由，避免 TUN 劫持公司 DNS 与内网服务。
const PRIVATE_CIDRS = ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"];
// 对外暴露默认排除项：界面用它标注「已由默认私网规则覆盖」的冗余地址。
export const DEFAULT_ROUTE_EXCLUSIONS = PRIVATE_CIDRS;
const PRIVATE_RULES = PRIVATE_CIDRS.map((cidr) => `IP-CIDR,${cidr},DIRECT`);
// 内网域名必须同时处理 DNS、Fake-IP 与出站；仅加 DIRECT 仍会被公共 DNS 解析失败。
const INTERNAL_DOMAINS = ["localhost", "lan", "local", "home.arpa"];

const RESERVED_GROUP_TYPES = new Set(["select"]);

function assertProxy(proxy) {
  if (!proxy || typeof proxy !== "object") throw new Error("节点必须是对象。");
  if (typeof proxy.name !== "string" || !proxy.name.trim()) throw new Error("节点缺少名称。");
  if (typeof proxy.type !== "string" || !proxy.type.trim()) throw new Error(`节点 ${proxy.name} 缺少类型。`);
  if (typeof proxy.server !== "string" || !proxy.server.trim()) throw new Error(`节点 ${proxy.name} 缺少服务器地址。`);
  if (!Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535) throw new Error(`节点 ${proxy.name} 端口无效。`);
  return { ...proxy };
}

function normalizeDomains(domains) {
  const unique = [...new Set(domains.map((domain) => String(domain).trim().toLowerCase()).filter(Boolean))];
  for (const domain of unique) {
    if (!/^[a-z0-9.-]+$/.test(domain) || domain.startsWith(".") || domain.endsWith(".")) throw new Error(`无效域名：${domain}`);
  }
  return unique;
}

function normalizeRouteExclusions(addresses) {
  if (!Array.isArray(addresses)) throw new Error("routeExcludeAddresses 必须是 IP/CIDR 字符串数组。");
  return [...new Set(addresses.map((value) => {
    if (typeof value !== "string") throw new Error("routeExcludeAddresses 必须是 IP/CIDR 字符串数组。");
    const [address, rawBits = "32", ...rest] = value.trim().split("/");
    if (isIP(address) !== 4 || rest.length || !/^(0|[1-9]\d?)$/.test(rawBits) || Number(rawBits) > 32) throw new Error(`无效 IPv4 地址或 CIDR：${value}（当前内核关闭 IPv6）。`);
    const bits = Number(rawBits);
    const numeric = address.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    const network = (numeric & mask) >>> 0;
    const normalized = [24, 16, 8, 0].map((shift) => (network >>> shift) & 255).join(".");
    const cidr = `${normalized}/${bits}`;
    // 排除 Fake-IP 网段会使所有以假地址接入的域名绕过 TUN，必须拒绝。
    if (inIpv4Range(normalized, DEFAULT_FAKE_IP_RANGE) || inIpv4Range(DEFAULT_FAKE_IP_RANGE.split("/")[0], cidr)) throw new Error(`routeExcludeAddresses 不得覆盖 Fake-IP 网段 ${DEFAULT_FAKE_IP_RANGE}。`);
    return cidr;
  }))];
}

/**
 * 生成内核配置对象。
 * @param {object} options
 * @param {Array<object>} options.proxies 可用出口节点
 * @param {string} [options.selected] 默认选中的节点，必须是 proxies 中的名字
 * @param {string} [options.groupName] Claude 专用出口组名
 * @param {number} [options.apiPort] 外部控制器端口
 * @param {string} [options.secret] 外部控制器访问密钥
 * @param {Array<string>} [options.extraRules] 追加在置顶规则之后的规则（订阅来源）
 * @param {string} [options.finalRule] 最后一条 MATCH 规则
 * @param {object} [options.localNetwork] 用户本地配置：directDomains、dnsServers、directInterface、dnsInterface、strictRoute、routeExcludeAddresses
 */
export function buildKernelConfig({
  proxies,
  selected,
  groupName = DEFAULT_GROUP,
  apiPort = 9090,
  secret = "",
  domains = CLAUDE_DOMAINS,
  extraRules = [],
  finalRule = DEFAULT_FINAL_RULE,
  egressMode = "rule",
  dns = {},
  // 境外域名的公共 DNS：必须与出口地区一致（见 public-dns.mjs）。不传时退回 anycast DoH。
  publicDns = ANYCAST_DOH,
  // 解析「代理服务器域名」用的 DNS。订阅常常用服务商私有域名，公共 DNS 解析不出来。
  proxyServerDns = ["223.5.5.5", "1.1.1.1"],
  // 已验证可达的节点地址 → 写进内核 hosts，节点拨号不再依赖 DNS 实时可用。
  hosts = {},
  localNetwork = {},
  logLevel = "warning",
  mixedPort,
  // 固定出口探测主机：主内核里给这个主机加一条钉死 Claude 专用组的路由，
  // 探测请求走已有的混合入口即可由主内核拨号（TUN 模式下已绑定物理网卡），
  // 不需要新增入站——特权宿主的配置字段白名单不允许 listeners。
  exitProbeHost = "",
  autoGroupName = DEFAULT_AUTO_GROUP,
  autoGroupType = DEFAULT_AUTO_GROUP_TYPE,
  healthCheck = {},
  clientFingerprint = DEFAULT_CLIENT_FINGERPRINT,
  sniffer = true,
  blockStun = true,
  // 区域锁定：出口落回 Claude 不支持地区时，直接把 Claude 域名的 TCP 连接拒绝掉。
  blockClaude = false,
} = {}) {
  const nodes = (proxies ?? []).map(assertProxy).map((node) => {
    // 只给真做 TLS 握手的节点补指纹；用户显式写的值优先。
    if (!clientFingerprint) return node;
    if (Object.hasOwn(node, "client-fingerprint")) return node;
    if (!TLS_PROXY_TYPES.has(node.type) || node.tls === false) return node;
    return { ...node, "client-fingerprint": clientFingerprint };
  });
  if (!nodes.length) throw new Error("没有可用的出口节点；未配置节点时不得启动内核。");
  const pinned = normalizeDomains(domains);
  if (!pinned.length) throw new Error("Claude 域名列表为空，置顶路由没有意义。");
  if (!localNetwork || typeof localNetwork !== "object" || Array.isArray(localNetwork)) throw new Error("localNetwork 必须是对象。");
  const { directDomains = [], dnsServers = ["system"], directInterface = "", dnsInterface = directInterface, strictRoute = true, routeExcludeAddresses = [] } = localNetwork;
  if (typeof directInterface !== "string" || (directInterface && !directInterface.trim())) throw new Error("directInterface 必须是有效网卡名称字符串。");
  if (typeof dnsInterface !== "string" || (dnsInterface && !dnsInterface.trim())) throw new Error("dnsInterface 必须是有效网卡名称字符串。");
  const customExcludedRoutes = normalizeRouteExclusions(routeExcludeAddresses);
  const excludedRoutes = [...new Set([...PRIVATE_CIDRS, ...customExcludedRoutes])];
  if (typeof strictRoute !== "boolean") throw new Error("strictRoute 必须是布尔值。");
  if (!Array.isArray(directDomains) || directDomains.some((domain) => typeof domain !== "string" || !domain.trim())) throw new Error("directDomains 必须是非空域名字符串组成的数组。");
  if (!Array.isArray(dnsServers) || !dnsServers.length || dnsServers.some((server) => typeof server !== "string" || !server.trim())) throw new Error("dnsServers 必须是非空 DNS 地址字符串组成的数组。");
  if (dnsInterface && dnsServers.some((server) => server.trim() === "system" || server.includes("#"))) throw new Error("dnsInterface 需要显式 DNS 地址，且不能同时指定 # 路由参数。");
  // 严格模式只允许内核代转 DNS；显式解析器须直连，不能被 global 模式的兜底规则送往节点。
  const directDnsServers = dnsServers.map((value) => {
    const server = value.trim();
    return server === "system" || server.includes("#") ? server : `${server}#${dnsInterface ? LOCAL_DNS_PROXY : "DIRECT"}`;
  });
  const internalDomains = normalizeDomains([...INTERNAL_DOMAINS, ...directDomains]);
  // 引导域名：代理服务器域名 + 订阅自带 DoH 的主机名。它们必须先能被解析，否则节点全死。
  const normalizedProxyDns = (Array.isArray(proxyServerDns) ? proxyServerDns : []).map((item) => String(item).trim()).filter(Boolean);
  const nodeServerHosts = new Set();
  const dohHosts = new Set();
  for (const node of nodes) {
    if (typeof node?.server === "string" && node.server && !isIP(node.server)) nodeServerHosts.add(node.server.toLowerCase());
  }
  for (const entry of normalizedProxyDns) {
    try { const host = new URL(entry).hostname.toLowerCase(); if (host && !isIP(host)) dohHosts.add(host); } catch { /* IP 解析器无需引导 */ }
  }
  const directBootstrapServer = "223.5.5.5";
  // 节点域名只能用服务商自己的 DNS 解析（公共 DNS 实测给出连不上的地址），且钉成直连避免环路。
  const nodeDomainResolver = `${normalizedProxyDns[0] ?? directBootstrapServer}#DIRECT`;
  if (internalDomains.some((domain) => pinned.some((target) => domain === target || domain.endsWith(`.${target}`) || target.endsWith(`.${domain}`)))) throw new Error("内网直连域名不得覆盖或包含 Claude 置顶域名。");

  const names = nodes.map((node) => node.name);
  if (dnsInterface && (names.includes(LOCAL_DNS_PROXY) || groupName === LOCAL_DNS_PROXY)) throw new Error(`节点或出口组不得使用内网 DNS 保留名称 ${LOCAL_DNS_PROXY}。`);
  if (directInterface && (names.includes(LOCAL_DIRECT_PROXY) || groupName === LOCAL_DIRECT_PROXY)) throw new Error(`节点或出口组不得使用内网直连保留名称 ${LOCAL_DIRECT_PROXY}。`);
  if (new Set(names).size !== names.length) throw new Error("节点名称重复。");
  const initial = selected ?? names[0];
  if (!names.includes(initial)) throw new Error(`选中的节点 ${initial} 不在节点列表中。`);
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) throw new Error("外部控制器端口无效。");
  const probeHost = typeof exitProbeHost === "string" ? exitProbeHost.trim().toLowerCase() : "";
  if (probeHost) {
    const version = isIP(probeHost);
    if (!version && !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(probeHost)) {
      throw new Error("固定出口探测主机必须是域名或 IP。");
    }
  }
  if (typeof autoGroupName !== "string" || !autoGroupName.trim()) throw new Error("自动出口组名称必须是非空字符串。");
  if (autoGroupName === groupName) throw new Error("自动出口组不能与 Claude 专用出口组同名。");
  if (!AUTO_GROUP_TYPES.has(autoGroupType)) throw new Error(`自动出口组类型必须是 fallback 或 url-test（当前 ${autoGroupType}）；固定出口无法在节点故障时转移，会让境外流量整体中断。`);
  if (names.includes(autoGroupName) || autoGroupName === LOCAL_DNS_PROXY || autoGroupName === LOCAL_DIRECT_PROXY) throw new Error(`自动出口组名称 ${autoGroupName} 与节点或保留名称冲突。`);
  const check = { ...DEFAULT_HEALTH_CHECK, ...healthCheck };
  if (!/^https?:\/\/\S+$/.test(String(check.url))) throw new Error("健康检查 url 必须是 http/https 地址。");
  if (!Number.isInteger(check.interval) || check.interval < 30 || check.interval > 3600) throw new Error("健康检查 interval 必须是 30 到 3600 秒之间的整数。");
  if (!Number.isInteger(check.tolerance) || check.tolerance < 0) throw new Error("健康检查 tolerance 必须是非负整数。");
  if (typeof check.lazy !== "boolean") throw new Error("健康检查 lazy 必须是布尔值。");

  // 置顶规则在前，订阅规则在后：mihomo 按顺序匹配，先命中的生效。
  const pinnedRules = pinned.map((domain) => `DOMAIN-SUFFIX,${domain},${groupName}`);
  // 区域锁定：Claude 域名的 TCP 也直接拒绝，必须排在置顶代理规则之前。
  const claudeBlockRules = blockClaude ? pinned.map((domain) => `DOMAIN-SUFFIX,${domain},REJECT`) : [];
  // 出口探测：把探测主机钉死到 Claude 专用组，探测走已有混合入口即可复用主内核的
  // dialer（TUN 下已绑定物理网卡），不需要新增入站（特权宿主的字段白名单也不允许）。
  const probeRules = !probeHost
    ? []
    : isIP(probeHost) === 6
      ? [`IP-CIDR6,${probeHost}/128,${groupName}`]
      : isIP(probeHost)
        ? [`IP-CIDR,${probeHost}/32,${groupName}`]
        : [`DOMAIN-SUFFIX,${probeHost},${groupName}`];
  // QUIC（UDP/443）绕开 TCP 代理路径，且 UDP 出口常与隧道不一致；Claude 域名一律拒绝，逼回 TCP。
  const quicRules = pinned.map((domain) => `AND,((NETWORK,udp),(DST-PORT,443),(DOMAIN-SUFFIX,${domain})),REJECT`);
  // STUN/TURN（UDP）在网口层丢掉：即使渲染页补丁被绕过，也拿不到真实的公网候选地址。
  // direct 模式不阻断（那就是“什么都不接管”）。
  const stunRules = blockStun && egressMode !== "direct" ? STUN_PORTS.map((port) => `AND,((NETWORK,udp),(DST-PORT,${port})),REJECT`) : [];
  if (!EGRESS_MODES.includes(egressMode)) throw new Error(`未知出站模式：${egressMode}`);
  // 出站模式：rule=海外走节点；global=全部走节点；direct=除固定 Claude 出口外全部直连。
  // 规则模式：局域网 + 国内域名直连，其余（海外）统一走节点。
  // 不依赖 Geo 数据，避免首次启动卡在下 GeoSite.dat。
  const modeRules = egressMode === "rule"
    ? [...PRIVATE_RULES, ...CN_DIRECT_DOMAINS.map((domain) => "DOMAIN-SUFFIX," + domain + ",DIRECT")]
    : [];
  // 显式 finalRule 仍可覆盖模式默认值（测试与特殊部署用）。
  // 兜底不直接绑 Claude 专用组：rt 类流量需要故障转移，否则单节点掉线即全断。
  const finalFromMode = egressMode === "direct" ? "MATCH,DIRECT" : "MATCH," + autoGroupName;
  const modeFinal = finalRule && finalRule !== DEFAULT_FINAL_RULE ? finalRule : finalFromMode;
  // 只有兜底规则真的引用自动组时才生成它，避免 direct 模式下多出无用的健康检查。
  const usesAutoGroup = modeFinal === "MATCH," + autoGroupName;
  // 共享入口时故障转移是空转：入口挂了全部节点一起挂，切端口没有任何冗余价值。
  const ingress = ingressSummary(nodes, { hosts });
  const effectiveAutoType = ingress.shared && autoGroupType === DEFAULT_AUTO_GROUP_TYPE ? "select" : autoGroupType;
  const localTarget = directInterface ? LOCAL_DIRECT_PROXY : "DIRECT";
  const customDomains = new Set(normalizeDomains(directDomains));
  const internalRules = internalDomains.map((domain) => `DOMAIN-SUFFIX,${domain},${customDomains.has(domain) ? localTarget : "DIRECT"}`);
  // 显式 HTTP/SOCKS 代理也需按配置的 IP 直连；TUN 路由排除本身不处理这类连接。
  const customIpRules = customExcludedRoutes.filter((cidr) => localTarget !== "DIRECT" || !modeRules.includes(`IP-CIDR,${cidr},DIRECT`)).map((cidr) => `IP-CIDR,${cidr},${localTarget}`);
  // mihomo 按首条匹配执行：UDP 拒绝必须先于同域名的通用代理规则。
  const rules = [...quicRules, ...claudeBlockRules, ...pinnedRules, ...probeRules, ...stunRules, ...internalRules, ...customIpRules, ...modeRules, ...extraRules.map(String), modeFinal];

  return {
    mode: "rule",
    "log-level": logLevel,

    ipv6: false,
    ...(hosts && Object.keys(hosts).length ? { hosts } : {}),
    ...(sniffer ? {
      sniffer: {
        enable: true,
        "parse-pure-ip": true,
        "override-destination": true,
        sniff: {
          HTTP: { ports: [80, 8080] },
          TLS: { ports: [443, 8443] },
          QUIC: { ports: [443, 8443] },
        },
      },
    } : {}),
    ...(Number.isInteger(mixedPort) ? { "mixed-port": mixedPort } : {}),
    "external-controller": `127.0.0.1:${apiPort}`,
    ...(secret ? { secret } : {}),
    tun: {
      enable: true,
      stack: "gvisor",
      "auto-route": true,
      "auto-detect-interface": true,
      "strict-route": strictRoute,
      "route-exclude-address": excludedRoutes,
      "dns-hijack": ["any:53"],
      "mtu": 9000,
    },
    dns: {
      enable: true,
      ipv6: false,
      "enhanced-mode": "fake-ip",
      "fake-ip-range": DEFAULT_FAKE_IP_RANGE,
      "fake-ip-filter": [...internalDomains.map((domain) => `+.${domain}`), "+.msftconnecttest.com", "+.msftncsi.com"],
      "default-nameserver": ["223.5.5.5", "1.1.1.1"],
      "proxy-server-nameserver": (Array.isArray(proxyServerDns) && proxyServerDns.length ? proxyServerDns : ["223.5.5.5", "1.1.1.1"]).map((item) => item.trim()),
      nameserver: Array.isArray(publicDns) && publicDns.length ? [...publicDns] : [...ANYCAST_DOH],
      // respect-rules 会让 DNS 查询也走节点，而解析「代理服务器域名 / DoH 引导域名」又必须先有 DNS ——
      // 不把这两类域名钉死在直连解析上就会互相等待（实测：全部节点超时、/dns/query 超时）。
      "nameserver-policy": Object.fromEntries([
        ...internalDomains.map((domain) => [`+.${domain}`, [...directDnsServers]]),
        ...[...nodeServerHosts].map((host) => [`+.${host}`, [nodeDomainResolver]]),
        ...[...dohHosts].map((host) => [`+.${host}`, [`${directBootstrapServer}#DIRECT`]]),
      ]),
      "direct-nameserver": [...directDnsServers],
      "direct-nameserver-follow-policy": true,
      "respect-rules": true,
      "use-hosts": true,
      "use-system-hosts": true,
      ...dns,
    },
    proxies: [...nodes, ...(dnsInterface ? [{ name: LOCAL_DNS_PROXY, type: "direct", "interface-name": dnsInterface.trim() }] : []), ...(directInterface ? [{ name: LOCAL_DIRECT_PROXY, type: "direct", "interface-name": directInterface.trim() }] : [])],
    "proxy-groups": [
      {
        name: groupName,
        type: "select",
        proxies: [initial, ...names.filter((name) => name !== initial)],
      },
      ...(usesAutoGroup ? [{
        name: autoGroupName,
        type: effectiveAutoType,
        // 成员顺序即 fallback 优先级；全部节点都必须在内，否则等于主动放弃冗余。
        proxies: [...names],
        ...(effectiveAutoType === "select" ? {} : {
          url: check.url,
          interval: check.interval,
          lazy: check.lazy,
          ...(effectiveAutoType === "url-test" ? { tolerance: check.tolerance } : {}),
        }),
      }] : []),
    ],
    rules,
  };
}

/** 结构级校验：任何一条不满足都说明配置会削弱环境一致性，必须拒绝启动。 */
/**
 * 出口探测专用配置：给每个节点开一个独立入站端口（listeners.proxy 直接绑定节点）。
 * 好处是探测能全并行，而且完全不碰主内核的选中节点——不会让出口 IP 抖动。
 */
export function buildProbeConfig({ proxies, names, basePort = 39381, mixedPort = 39380, ipv6 = false, hosts = {}, proxyServerDns = [], secret = "" } = {}) {
  const wanted = new Set(Array.isArray(names) ? names : []);
  const nodes = (Array.isArray(proxies) ? proxies : []).filter((node) => wanted.has(node?.name));
  if (!nodes.length) throw new Error("没有可探测的节点。");
  const listeners = nodes.map((node, index) => ({
    name: "probe-" + index,
    // 用明确的 http 类型：mixed 在 listeners 里实测会直接 RST。
    type: "http",
    port: basePort + index,
    listen: "127.0.0.1",
    proxy: node.name,
  }));
  return {
    "mixed-port": mixedPort,
    mode: "direct",
    "log-level": "silent",
    ipv6,
    "external-controller": "127.0.0.1:0",
    ...(secret ? { secret } : {}),
    // 临时内核不能再次进入主 TUN；即使不创建 TUN，也要让内核跟踪物理出口网卡。
    tun: { enable: false, "auto-detect-interface": true },
    ...(hosts && Object.keys(hosts).length ? { hosts } : {}),
    dns: {
      enable: true,
      ipv6: false,
      "enhanced-mode": "normal",
      "default-nameserver": ["223.5.5.5", "1.1.1.1"],
      "proxy-server-nameserver": (Array.isArray(proxyServerDns) && proxyServerDns.length ? proxyServerDns : ["223.5.5.5", "1.1.1.1"]).map((item) => String(item).trim()),
      nameserver: ["https://223.5.5.5/dns-query"],
    },
    listeners,
    proxies: nodes,
  };
}

/** 严格会话不接受分流/直连例外，全部出站固定到同一节点。 */
export function strictKernelConfig(config, { blockClaude = false } = {}) {
  const candidate = structuredClone(config);
  if (typeof candidate.secret !== "string" || candidate.secret.length < 32) throw new Error("严格模式需要有效的控制器及本机代理认证。");
  candidate.authentication = [`egcc:${candidate.secret}`];
  const group = candidate["proxy-groups"]?.find(item => item.name === DEFAULT_GROUP && item.type === "select");
  if (!group?.proxies?.length) throw new Error("严格模式缺少固定出口。");
  group.proxies = [group.proxies[0]];
  candidate["proxy-groups"] = [group];
  candidate.rules = [
    ...(blockClaude ? CLAUDE_DOMAINS.map(domain => `DOMAIN-SUFFIX,${domain},REJECT`) : []),
    ...CLAUDE_DOMAINS.map(domain => `AND,((NETWORK,udp),(DST-PORT,443),(DOMAIN-SUFFIX,${domain})),REJECT`),
    ...CLAUDE_DOMAINS.map(domain => `DOMAIN-SUFFIX,${domain},${DEFAULT_GROUP}`),
    ...STUN_PORTS.map(port => `AND,((NETWORK,udp),(DST-PORT,${port})),REJECT`),
    `MATCH,${DEFAULT_GROUP}`,
  ];
  candidate.tun = { ...candidate.tun, enable: true, device: "utun90", "strict-route": true, "route-exclude-address": [] };
  // 只保留节点的 hosts 引导；不能把系统解析器或内网 DNS 当作严格模式降级出口。
  candidate.dns["nameserver-policy"] = {};
  candidate.dns["fake-ip-filter"] = [];
  return assertStrictKernelConfig(candidate);
}

export function assertStrictKernelConfig(config) {
  const group = config?.["proxy-groups"]?.find(item => item.name === DEFAULT_GROUP);
  if (config?.authentication?.length !== 1 || config.authentication[0] !== `egcc:${config.secret}`) throw new Error("严格模式必须启用私有本机代理认证。");
  if (config?.tun?.device !== "utun90" || config.tun.enable !== true || config.tun["strict-route"] !== true || config.ipv6 !== false) throw new Error("严格模式必须使用独立网卡、严格路由并关闭内核 IPv6。");
  if (config["proxy-groups"].length !== 1 || group?.type !== "select" || group.proxies?.length !== 1) throw new Error("严格模式只能使用一个固定出口。");
  if (config.rules?.at(-1) !== `MATCH,${DEFAULT_GROUP}` || config.rules.some(rule => !rule.endsWith(`,${DEFAULT_GROUP}`) && !rule.endsWith(",REJECT"))) throw new Error("严格模式不得包含直连、兜底或额外出口。");
  if (config.tun["route-exclude-address"]?.length) throw new Error("严格模式不得排除物理路由。");
  // 严格模式只留带认证的混合入口；额外入站会把固定出口暴露给本机任意进程。
  if (config.listeners?.length) throw new Error("严格模式不得暴露额外的本机入站。");
  return config;
}
export function assertKernelConfig(config, { groupName = DEFAULT_GROUP, domains = CLAUDE_DOMAINS, strictRoute = true, egressMode, autoGroupName = DEFAULT_AUTO_GROUP, sniffer = true, blockStun = true, requireTlsFingerprint = true, blockClaude = false } = {}) {
  if (!config || typeof config !== "object") throw new Error("内核配置为空。");
  if (config.ipv6 !== false) throw new Error("必须关闭 IPv6，否则双栈旁路会绕过隧道。");
  if (sniffer) {
    if (config.sniffer?.enable !== true) throw new Error("必须启用 sniffer：否则纯 IP 连接无法按域名分流，QUIC/SNI 也读不到。");
    if (config.sniffer?.["override-destination"] !== true) throw new Error("sniffer 必须 override-destination，否则分流仍然按 IP 而不是域名。");
  }
  for (const node of (requireTlsFingerprint ? config.proxies ?? [] : [])) {
    // TLS 握手指纹必须与声明面一致；没有指纹的节点会把真实客户端特征漏给服务端。
    if (!TLS_PROXY_TYPES.has(node?.type) || node.tls === false) continue;
    if (typeof node["client-fingerprint"] !== "string" || !node["client-fingerprint"]) throw new Error(`节点 ${node.name ?? "未知"} 缺少 client-fingerprint，TLS 指纹会与声明面不一致。`);
  }
  if (config.tun?.enable !== true) throw new Error("必须启用 TUN，否则无法保证 Claude 流量走隧道。");
  if (typeof strictRoute !== "boolean" || config.tun?.["strict-route"] !== strictRoute) throw new Error("strict-route 必须与用户声明的策略一致；默认要求开启。");
  if (config.dns?.["enhanced-mode"] !== "fake-ip") throw new Error("DNS 必须使用 fake-ip，避免明文解析泄漏。");
  if (config.dns?.["respect-rules"] !== true) throw new Error("DNS 必须 respect-rules，解析本身也要走隧道。");

  const groups = config["proxy-groups"] ?? [];
  const group = groups.find((item) => item?.name === groupName);
  if (!group) throw new Error(`缺少出口组 ${groupName}。`);
  if (!RESERVED_GROUP_TYPES.has(group.type)) throw new Error(`出口组必须固定为 select（当前 ${group.type}）；自动测速切换会让出口 IP 漂移。`);
  const names = new Set((config.proxies ?? []).map((node) => node?.name));
  if (!group.proxies?.length) throw new Error("出口组没有节点。");
  for (const name of group.proxies) if (!names.has(name)) throw new Error(`出口组引用了不存在的节点 ${name}。`);

  const rules = config.rules ?? [];
  if (!rules.length) throw new Error("规则列表为空。");
  const pinnedDomains = normalizeDomains(domains);
  const pinned = pinnedDomains.map((domain) => `DOMAIN-SUFFIX,${domain},${groupName}`);
  for (const domain of pinnedDomains) {
    const rule = `DOMAIN-SUFFIX,${domain},${groupName}`;
    if (!rules.includes(rule)) throw new Error(`缺少置顶规则 ${rule}。`);
    const quic = `AND,((NETWORK,udp),(DST-PORT,443),(DOMAIN-SUFFIX,${domain})),REJECT`;
    if (!rules.includes(quic)) throw new Error(`缺少 QUIC 阻断规则 ${quic}。`);
  }
  const quic = pinnedDomains.map((domain) => `AND,((NETWORK,udp),(DST-PORT,443),(DOMAIN-SUFFIX,${domain})),REJECT`);
  const blockRules = blockClaude ? pinnedDomains.map((domain) => `DOMAIN-SUFFIX,${domain},REJECT`) : [];
  for (const domain of blockClaude ? pinnedDomains : []) {
    if (!rules.includes(`DOMAIN-SUFFIX,${domain},REJECT`)) throw new Error(`区域锁定缺少 Claude 阻断规则：${domain}。`);
  }
  const protectedRules = [...quic, ...blockRules, ...pinned];
  if (protectedRules.some((rule, index) => rules[index] !== rule)) throw new Error("Claude 置顶规则必须先阻断 QUIC，再代理域名，且位于所有其他规则之前。");
  const last = rules[rules.length - 1];
  if (!String(last).startsWith("MATCH,")) throw new Error("最后一条规则必须是 MATCH。");
  if (blockStun && egressMode && egressMode !== "direct") {
    for (const port of STUN_PORTS) {
      const rule = `AND,((NETWORK,udp),(DST-PORT,${port})),REJECT`;
      if (!rules.includes(rule)) throw new Error(`缺少 STUN 阻断规则 ${rule}；WebRTC 可能泄漏真实出口。`);
    }
  }

  // 兜底出口组：必须是可自动故障转移的组，且覆盖全部节点。
  const autoGroup = groups.find((item) => item?.name === autoGroupName);
  const nodeNames = (config.proxies ?? []).map((node) => node?.name).filter((name) => name !== LOCAL_DNS_PROXY && name !== LOCAL_DIRECT_PROXY);
  const sharedIngress = ingressSummary(config.proxies, { hosts: config.hosts ?? {} }).shared;
  if (autoGroup) {
    // 共享入口时 select 是正确形态：切换端口不产生任何冗余，fallback 的健康检查只是噪音。
    if (!AUTO_GROUP_TYPES.has(autoGroup.type) && !(sharedIngress && autoGroup.type === "select")) throw new Error(`自动出口组 ${autoGroupName} 必须是 fallback 或 url-test（当前 ${autoGroup.type}）；固定出口无法在节点故障时转移。`);
    if (autoGroup.type !== "select" && (!autoGroup.url || !Number.isInteger(autoGroup.interval))) throw new Error(`自动出口组 ${autoGroupName} 缺少健康检查配置，节点故障后无法自动转移。`);
    const members = new Set(autoGroup.proxies ?? []);
    if (!members.size) throw new Error(`自动出口组 ${autoGroupName} 没有节点。`);
    for (const name of members) if (!names.has(name)) throw new Error(`自动出口组引用了不存在的节点 ${name}。`);
    for (const name of nodeNames) if (!members.has(name)) throw new Error(`自动出口组必须包含全部节点，缺少 ${name}。`);
  }
  if (egressMode === "rule" || egressMode === "global") {
    if (last !== `MATCH,${autoGroupName}`) throw new Error(`${egressMode} 模式的兜底规则必须是 MATCH,${autoGroupName}，不能绑定单个节点或 Claude 专用组。`);
    if (!autoGroup) throw new Error(`缺少自动出口组 ${autoGroupName}。`);
  }
  if (egressMode === "direct" && last !== "MATCH,DIRECT") throw new Error(`${egressMode} 模式的兜底规则必须是 MATCH,DIRECT。`);
  const seen = new Set();
  for (const rule of rules) {
    if (seen.has(rule)) throw new Error(`重复规则：${rule}`);
    seen.add(rule);
  }
  return config;
}

function scalar(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  // YAML 双引号语法与 JSON 字符串转义兼容；统一用引号避免逗号、冒号、通配符破坏结构。
  return JSON.stringify(String(value));
}

function key(name) {
  return /^[A-Za-z0-9_.-]+$/.test(name) ? name : JSON.stringify(name);
}

function emitObject(value, indent, lines) {
  const pad = "  ".repeat(indent);
  for (const [name, item] of Object.entries(value)) {
    if (item === undefined) continue;
    if (Array.isArray(item)) {
      if (!item.length) { lines.push(`${pad}${key(name)}: []`); continue; }
      lines.push(`${pad}${key(name)}:`);
      emitArray(item, indent + 1, lines);
      continue;
    }
    if (item && typeof item === "object") {
      lines.push(`${pad}${key(name)}:`);
      emitObject(item, indent + 1, lines);
      continue;
    }
    lines.push(`${pad}${key(name)}: ${scalar(item)}`);
  }
}

function emitArray(items, indent, lines) {
  const pad = "  ".repeat(indent);
  for (const item of items) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const nested = [];
      emitObject(item, indent + 1, nested);
      const [first, ...rest] = nested;
      lines.push(`${pad}- ${first.trimStart()}`);
      lines.push(...rest);
      continue;
    }
    lines.push(`${pad}- ${scalar(item)}`);
  }
}

/** 输出可直接写入 config.yaml 的文本。头部注释提示该文件由程序生成。 */
export function serializeKernelConfig(config, { comment = "由 EnvGuardCC 生成，请勿手工编辑；改动请通过界面或 API。" } = {}) {
  const lines = [];
  emitObject(config, 0, lines);
  return `${comment.startsWith("#") ? comment : `# ${comment}`}\n${lines.join("\n")}\n`;
}

/** IPv4 是否落在指定 CIDR 内（用于判定 DNS 是否被 fake-ip 接管）。 */
export function inIpv4Range(address, cidr = DEFAULT_FAKE_IP_RANGE) {
  const [base, bitsRaw] = String(cidr).split("/");
  const bits = Number(bitsRaw);
  const toNumber = (value) => value.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
  const parts = String(address ?? "").trim().split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(base) || !Number.isInteger(bits) || bits < 0 || bits > 32) throw new Error(`无效 CIDR：${cidr}`);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toNumber(address) & mask) === (toNumber(base) & mask);
}
