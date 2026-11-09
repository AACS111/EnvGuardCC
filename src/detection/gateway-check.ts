// EnvGuardCC 的 Claude 网关实测模块，用于把网关直连诊断映射为与浏览器侧同构的信号结果。
// 同一项 id 在两侧都存在，便于逐项对比“拦截迷惑层是否起作用”。
import type { LocaleCode } from "@/i18n/messages";
import type { ExitGeo, ExitTarget } from "./exit-geo";
import { countryDisplayName, cityDisplayName } from "./exit-geo";
import { gatewayUrl } from "./local-helper";
import { detectionConfig } from "./config";
import { detectorLocaleText } from "./locale";
import type { SignalResult } from "./types";
import * as rules from "./signal-rules";
import { RISK_COUNTRIES } from "./browser-probes";
import { signalTestKind } from "./signal-policy";
import { exitNetworkType } from "./network-type";

type Probe = { status: number | null; error?: string; elapsedMs: number; tls?: { authorized: boolean; protocol: string | null } | null };
type GeoSource = { source: string; ip: string; countryCode: string; city: string | null; regionName: string | null; timezone: string | null; asn: string | null; org: string | null };

export type CloakState = {
  enabled: boolean;
  updatedAt: string | null;
  target: { language: string; locale: string; timezone: string | null; countryName: string | null; updatedAt?: string | null } | null;
};

export type NetCoreRouting = {
  state: "verified" | "violation" | "unknown";
  total: number; claude: number; pinned: number; direct: number;
  sampledAt?: string; group?: string;
  /** 非 Claude 的当前连接，按内核真实代理链分类；不推断目的地国家。 */
  traffic?: { proxied: number; direct: number; blocked: number; unknown: number };
  /** 路径图按真实路由合并所有连接（含 Claude）。 */
  paths?: { proxied: number; direct: number; blocked: number; unknown: number };
  violations: Array<{ host: string; chains: string[]; rule?: string | null; rulePayload?: string | null }>;
  pinnedHosts?: string[]; groups?: string[];
};

export type NetCoreIngress = { total: number; entries: number; shared: boolean; groups: Array<{ server: string; count: number; nodes: string[] }> };

/** 供应商（配置来源）：一条来源保存一份节点快照，切换时整批替换。 */
export type NetCoreSource = {
  id: string;
  name: string;
  mode: "url" | "manual" | "content" | "local" | string;
  url: string | null;
  nodeCount: number;
  selected: string | null;
  updatedAt: string;
  intervalHours: number;
  active: boolean;
};

export type NetCoreExit = {
  countryCode: string | null;
  country: string | null;
  ip: string | null;
  asn?: number | null;
  org?: string | null;
  isp?: string | null;
  domain?: string | null;
  hosting?: boolean;
};

export type NetCoreReport = {
  /** 节点延迟：随状态一起下发（内核真实测速，缺失为 null）。 */
  delays?: Record<string, number | null> | null;
  /** 入口归组：多个节点共用同一入口时，故障转移是空转。 */
  ingress?: NetCoreIngress | null;
  enabled?: boolean;
  state: "disabled" | "idle" | "running" | "error" | "unavailable" | string;
  reason?: string | null; detail?: string;
  tunEnabled?: boolean; tunCaptured?: boolean | null; hostMode?: boolean; demo?: boolean;
  networkGeneration?: number; lastHealthAt?: string | null;
  capabilities?: { independentProxy: boolean; systemKillSwitch: boolean; strictTravel: boolean };
  strictMode?: boolean;
  /** 节点 IPv6 能力探测：supported=false 时应用会关闭系统 IPv6，避免绕过 IPv4 TUN。 */
  ipv6?: { supported: boolean | null; ip?: string | null; node: string | null; checkedAt: string | null; reason: string | null; protected?: boolean; system?: string } | null;
  /** 区域锁定：固定出口在 Claude 不支持地区时，内核直接 REJECT Claude 域名。 */
  regionLock?: {
    locked: boolean; type?: "region" | "network"; reason?: string | null; countryCode?: string | null; ip?: string | null; at?: string;
    /** 网络锁：自动复检，连续验证通过后自行解除；地区锁为 false/缺省，必须人工解除。 */
    autoRecover?: boolean; recovered?: number; recheckAttempts?: number; recheckAt?: string | null;
    /** 最近一次自动复检看到的出口（仅网络锁期间）。 */
    recheckProbe?: { ip?: string | null; countryCode?: string | null } | null;
  } | null;
  /** 未保护阻断：保护关闭时仍保持 TUN 接管并拒绝 Claude 域名。 */
  unprotectedGuard?: { active: boolean; at?: string | null; reason?: string | null } | null;
  claudeBlocked?: boolean;
  takeover?: { phase: "idle" | "checking" | "quitting" | "waiting" | "ready" | "blocked"; closed: string[]; reason: string | null; checkedAt: string | null };
  guard?: { provider: string | null; supported: boolean; armed: boolean; phase: string; checkedAt: string | null; reason: string | null } | null;
  binary?: string; apiPort?: number;
  nodes?: string[]; selected?: string | null;
  sources?: NetCoreSource[];
  activeId?: string | null;
  version?: string; restarts?: number;
  routing?: NetCoreRouting;
  connectionLog?: ConnectionLogSnapshot | null;
  source?: { mode: "url" | "content" | "manual"; url?: string; updatedAt?: string; intervalHours?: number } | null;
  localProxy?: string | null;
  mode?: "rule" | "global" | "direct";
  /** 网络异常时的处置：claude=只阻断 Claude（默认）；all=严格断流，封全部非节点流量。 */
  networkFailurePolicy?: "claude" | "all";
  elevation?: { elevated: boolean; platform: string; instruction: string };
};

export type ConnectionRecord = {
  kind?: "connection" | "request";
  id: string; host: string; ip: string | null; port: number | null;
  chains: string[]; rule: string; rulePayload: string; upload: number; download: number;
  startedAt: string; endedAt: string | null; isClaude: boolean;
  route: "proxied" | "direct" | "blocked" | "unknown"; viaExit: boolean | null;
  method?: string; endpoint?: string; status?: number | null; elapsedMs?: number | null; error?: string | null;
};
export type ConnectionLogSnapshot = { available: boolean; sampledAt: string | null; active: ConnectionRecord[]; activeTotal: number; scope: "all" | "claude" };
export type ConnectionsResult = {
  ok: boolean; available: boolean; storageError: boolean; retentionHours: number;
  stats: { active: number; ended: number; total: number }; total: number; offset: number; limit: number;
  items: ConnectionRecord[]; recent: ConnectionRecord[];
  sampledAt?: string | null; active?: ConnectionRecord[]; activeTotal?: number; scope?: "all" | "claude";
  detailId?: string | null; selected?: ConnectionRecord | null; at?: string | null;
};
export type ConnectionRouteFilter = "all" | "proxied" | "direct" | "blocked" | "unknown";
export type ConnectionStateFilter = "all" | "active" | "ended";
export type ConnectionsQuery = { host?: string; claude?: boolean; viaExit?: boolean | null; offset?: number; limit?: number; kind?: "all" | "connection" | "request"; at?: string | null; detailId?: string; route?: ConnectionRouteFilter; state?: ConnectionStateFilter };

function connectionParams(query: ConnectionsQuery) {
  const params = new URLSearchParams();
  for (const key of ['host', 'kind', 'at', 'detailId', 'route', 'state'] as const) if (query[key]) params.set(key, query[key]!);
  if (query.claude) params.set("claude", "true");
  if (typeof query.viaExit === "boolean") params.set("viaExit", String(query.viaExit));
  params.set("offset", String(query.offset ?? 0));
  params.set("limit", String(query.limit ?? 50));
  return params;
}

export async function readConnections(query: ConnectionsQuery = {}, signal?: AbortSignal): Promise<ConnectionsResult> {
  const params = connectionParams(query);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 6000);
  try {
    const response = await fetch(`${gatewayUrl}/__checkcc/net-core/connections?${params}`, {
      headers: { "X-CheckCC-Client": "gateway-ui" }, cache: "no-store", signal: controller.signal,
    });
    const value = await response.json();
    if (!response.ok || !value.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
    return value as ConnectionsResult;
  } finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
}

export async function clearConnections(): Promise<ConnectionsResult> {
  const response = await fetch(`${gatewayUrl}/__checkcc/net-core/connections`, {
    method: "POST", headers: { "X-CheckCC-Client": "gateway-ui", "Content-Type": "application/json" },
    body: JSON.stringify({ action: "clear" }), cache: "no-store", signal: AbortSignal.timeout(6000),
  });
  const value = await response.json();
  if (!response.ok || !value.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value as ConnectionsResult;
}

export async function exportConnections(query: ConnectionsQuery, format: "json" | "csv"): Promise<Blob> {
  const params = connectionParams(query); params.set("format", format);
  const response = await fetch(`${gatewayUrl}/__checkcc/net-core/connections?${params}`, { headers: { "X-CheckCC-Client": "gateway-ui" }, cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.blob();
}

export async function connectionLogSettings(scope?: "all" | "claude"): Promise<{ scope: "all" | "claude" }> {
  const response = await fetch(`${gatewayUrl}/__checkcc/net-core/connections${scope ? '' : '?view=settings'}`, {
    method: scope ? "POST" : "GET", headers: { "X-CheckCC-Client": "gateway-ui", "Content-Type": "application/json" },
    ...(scope ? { body: JSON.stringify({ action: "settings", scope }) } : {}), cache: "no-store", signal: AbortSignal.timeout(6000),
  });
  const value = await response.json();
  if (!response.ok || !value.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

export type GatewayReport = {
  version: 1; upstream: string; platform: string; profileError: string | null;
  profile: { language: string; locale: string; timezone: string | null; countryName: string | null; city: string | null; updatedAt: string | null } | null;
  proxy?: { mode: "direct" | "http-connect"; source: string; address: string | null };
  transport: string; proxyEnvironmentDetected: boolean; rewrites: number; previewHeaders: Record<string, string>;
  lastRequest: { startedAt: string; headers: Record<string, string>; intentHeaders?: Record<string, string>; originalHeaders?: Record<string, string>; profileUpdatedAt: string | null; status: number | null; elapsedMs: number | null; tls: Probe["tls"] } | null;
  lastFailure: { at: string; error: string } | null;
  checkedAt?: string;
  testedSignals?: string[];
  probes?: { claude: Probe; anthropic: Probe; api: Probe };
  dns?: { hostname: string; addresses: Array<{ address: string; family: number }>; resolvers: string[]; error: string | null;
    mode?: "proxy" | "system"; localLookupSkipped?: boolean; routeStatus?: number | null;
    references?: Array<{ source: string; answers: string[]; error: string | null }>; referenceAgreement?: boolean | null };
  exit?: { sources: GeoSource[]; primary: GeoSource | null; ipv4: string | null; ipv6: string | null; consistentCountry: boolean | null; ipv4Error: string | null; ipv6Error: string | null };
  clues?: { headers: Record<string, string>; clientHintBrands: string | null; clientHintPlatform: string | null; secFetch: string | null; sdk: string | null; app: string | null; uaLooksBrowser: boolean } | null;
  edge?: { colo: string | null; loc: string | null; city: string | null; http: number | null; error: string | null } | null;
  // 拦截迷惑层：只重写“向 Claude 声明的语言/区域”类头，不改本机系统、不伪造 IP。
  cloak?: CloakState | null;
  // 网络内核（TUN/分流/DNS）状态；未接入时为 disabled。
  netCore?: NetCoreReport | null;
};

export type GatewayCheck = { signals: SignalResult[]; geo: ExitGeo | null; report: GatewayReport | null; error: string | null; verifiedRequest: boolean; cloak: CloakState | null };

const labels: Record<string, [string, string]> = {
  timezone: ["Claude 环境时区（不转发）", "Claude environment timezone (not forwarded)"],
  language: ["Claude 出站语言头", "Claude outbound Accept-Language"],
  languageVariant: ["出站语言文字特征", "Outbound language variant"],
  locale: ["网关区域声明头", "Gateway locale declaration"],
  country: ["Claude 网络出口", "Claude network exit"], proxyCountry: ["Claude 出口国家交叉核对", "Claude exit country cross-check"],
  ipv4: ["Claude 出口 IPv4", "Claude exit IPv4"], browserIpLocation: ["Claude 出口 IP 位置", "Claude exit IP location"],
  browserIpOrg: ["Claude 出口网络组织", "Claude exit network organization"], os: ["网关运行系统", "Gateway host OS"],
  claudeReachability: ["claude.ai 出口侧可达性", "claude.ai egress reachability"],
  anthropicReachability: ["Anthropic API 侧可达性", "Anthropic API-side reachability"],
  apiReachability: ["Anthropic API 鉴权前可达性", "Anthropic API pre-auth reachability"],
  claudeTrigger: ["Claude 真实触发状态", "Claude actual request status"],
  claudeLatency: ["Claude 响应头延迟", "Claude time to response headers"],
  webrtcSupport: ["WebRTC 支持状态", "WebRTC support"], webrtcCandidates: ["WebRTC UDP 候选地址", "WebRTC UDP candidates"],
  webrtcLeak: ["WebRTC 公网 IP 泄漏", "WebRTC public IP leak"], webrtcLeakCount: ["WebRTC 泄漏 IP 数", "WebRTC leaked IP count"],
  webrtcFirstIp: ["首个 WebRTC 泄漏 IP", "First WebRTC leaked IP"], webrtcRegion: ["WebRTC 泄漏地区风险", "WebRTC leak region risk"],
  webrtcConsistency: ["WebRTC 与网络出口一致性", "WebRTC / exit consistency"],
  dnsMode: ["DNS 检测模式", "DNS diagnostic mode"], dnsReview: ["DNS 解析路径验证", "DNS resolution path verification"],
  dnsConsistency: ["DNS 多源参考核对", "DNS reference cross-check"], gatewayProfile: ["网关出口目标配置", "Gateway exit target profile"],
  deviceLineage: ["Claude 客户端设备线索", "Claude client device signals"],
  edgeCountry: ["边缘访问国家", "Edge country"], edgeColo: ["Cloudflare 边缘机房", "Cloudflare edge colo"], edgeCity: ["边缘访问城市", "Edge city"],
  edgeAsn: ["边缘 ASN", "Edge ASN"], edgeOrg: ["边缘网络组织", "Edge network organization"],
  requestHeaders: ["请求头完整性", "Request header integrity"], httpLanguage: ["HTTP 语言偏好", "HTTP language preference"],
  secFetch: ["Sec-Fetch 访问画像", "Sec-Fetch fingerprint"], clientHints: ["Client Hints 画像", "Client Hints fingerprint"],
  exitType: ["网络出口类型", "Network exit type"], multiSourceConsistency: ["多源 IP 情报一致性", "Multi-source IP consistency"],
  ipSourceCount: ["IP 情报源数量", "IP intelligence sources"], countrySet: ["多源国家集合", "Multi-source country set"],
  ipCountryRisk: ["IP 风险国家", "IP risk country"], claudeAccessRisk: ["Claude 访问风险", "Claude access risk"],
  asn: ["出口 ASN", "Exit ASN"],
};

export function gatewaySignalLabel(id: string, locale: LocaleCode, fallback = id) {
  return labels[detectionConfig.signals[id]?.labelKey ?? id]?.[locale.startsWith("zh") ? 0 : 1] ?? fallback;
}

export async function readGateway(path = "/__checkcc/diagnostics"): Promise<GatewayReport> {
  const response = await fetch(`${gatewayUrl}${path}`, {
    headers: { "X-CheckCC-Client": "gateway-ui" }, cache: "no-store", signal: AbortSignal.timeout(11000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const value = await response.json();
  if (value.version !== 1 || typeof value.upstream !== "string" || typeof value.transport !== "string") throw new Error("INCOMPATIBLE_GATEWAY");
  return value as GatewayReport;
}

// 拦截迷惑层开关：写入网关，影响后续真实转发的语言/区域声明头，不改本机设置。
export async function setGatewayCloak(enabled: boolean, target?: ExitTarget | CloakState["target"]): Promise<CloakState | null> {
  const response = await fetch(`${gatewayUrl}/__checkcc/cloak`, {
    method: "POST",
    headers: { "X-CheckCC-Client": "gateway-ui", "Content-Type": "application/json" },
    body: JSON.stringify({ enabled, ...(enabled && target ? { target } : {}) }),
    cache: "no-store", signal: AbortSignal.timeout(6000),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  if (typeof value?.cloak?.enabled !== "boolean") throw new Error("INCOMPATIBLE_GATEWAY");
  return value.cloak as CloakState;
}

export function gatewayExitGeo(report: GatewayReport, locale: LocaleCode): ExitGeo | null {
  const geo = report.exit?.primary;
  if (!geo) return null;
  return {
    ...geo, countryName: countryDisplayName(geo.countryCode, locale), cityRaw: geo.city,
    city: cityDisplayName(geo.city, locale), source: `Claude gateway / ${geo.source}`,
  };
}

const BROWSER_ONLY = ["timezone", "chineseFonts", "vendorFonts", "domesticBrowser", "domesticDevice", "timezoneOffset", "emojiStyle", "webrtcSupport", "webrtcCandidates", "webrtcLeak", "webrtcLeakCount", "webrtcFirstIp", "webrtcRegion", "webrtcConsistency", "browser", "device"];

export function buildGatewayCheck(report: GatewayReport | null, locale: LocaleCode, error: string | null = null): GatewayCheck {
  const zh = locale.startsWith("zh");
  const tr = (cn: string, en: string) => zh ? cn : en;
  const missing = tr("未测得", "Not measured");
  const offline = tr("网关未连接：在项目目录运行 npm run gateway，再重新检测。", "Gateway unavailable: run npm run gateway in the project, then recheck.");
  const observations = new Map<string, SignalResult>();
  const put = (id: string, value: string, assessment: NonNullable<SignalResult["assessment"]>, detail: string, score = 0, cloaked = false, observation?: SignalResult["observation"]) => {
    const config = detectionConfig.signals[id];
    const weight = config?.weight ?? 0;
    observations.set(id, {
      id, label: gatewaySignalLabel(id, locale, detectorLocaleText[locale].signalLabels[id] ?? config?.labelKey ?? id),
      value, assessment, observation, detail, source: "gateway", score, weight,
      contribution: Math.round(score * weight), environment: "claude", cloaked,
    });
  };
  const na = tr("不适用 · Claude 网关", "Not applicable · Claude gateway");
  const browserOnlyDetail = tr("此项由浏览器实测（字体/WebRTC/品牌特征），API 网关既不采集也不转发，Claude 侧不纳入评分；不适用不代表浏览器环境已修复。", "This signal is measured in the browser (fonts/WebRTC/brand traits). The API gateway neither collects nor forwards it, so it is excluded from Claude-side scoring; not applicable does not mean the browser is repaired.");
  for (const id of BROWSER_ONLY) put(id, na, "not_applicable", browserOnlyDetail);

  if (!report) {
    for (const [id, config] of Object.entries(detectionConfig.signals)) {
      if (config.enabled && config.environment !== "browser" && !observations.has(id)) put(id, missing, "unknown", `${offline}${error ? ` (${error})` : ""}`);
    }
    put("claudeReachability", tr("未连接网关", "Gateway disconnected"), "unknown", offline);
    return { signals: sortSignals(observations), geo: null, report: null, error: offline, verifiedRequest: false, cloak: null };
  }

  const cloak = report.cloak ?? null;
  const cloakOn = cloak?.enabled === true;
  const cloakNote = cloakOn
    ? tr("拦截迷惑层已开启：网关会把语言与区域声明改写为出口目标值。", "Cloak layer enabled: the gateway rewrites language and locale declarations to the exit target.")
    : tr("拦截迷惑层已关闭：网关原样转发客户端声明，可直接对比未改写状态。", "Cloak layer disabled: client declarations pass through unchanged for direct comparison.");
  const headerDetail = tr("仅对真实转发记录计分。预览值不是 Claude 已收到的值；网关改写区域时只用标准 Accept-Language，自定义 x-checkcc-* 标记永不上行。", "Only observed forwarded headers are scored. Previews are not observed Claude values; locale rewrites use only standard Accept-Language, and x-checkcc-* markers are never sent upstream.");

  const current = report.lastRequest && report.lastRequest.profileUpdatedAt === (report.profile?.updatedAt ?? null) ? report.lastRequest : null;
  const successful = Boolean(current?.status && current.status >= 200 && current.status < 300);
  const headers = current?.headers;
  // 区域声明只存在于本地改写意图中，从不上行；旧版报告没有该字段时回退到 headers。
  const intent = current?.intentHeaders ?? headers;
  const original = current?.originalHeaders ?? null;
  const language = headers?.["accept-language"];
  const outboundLocale = intent?.["x-checkcc-target-locale"];
  const langs = language?.split(",").map((value) => value.trim().split(";")[0]) ?? [];
  const rewritten = Boolean(original && (original["accept-language"] !== language || (original["x-checkcc-target-locale"] ?? null) !== (outboundLocale ?? null)));

  put("gatewayProfile", report.profileError ? tr("配置无效", "Invalid profile") : report.profile ? `${report.profile.language} / ${report.profile.locale}` : tr("未配置 · 原样转发", "No profile · passthrough"), report.profileError ? "error" : report.profile ? "ok" : "warning", tr("配置在每次转发前重新读取。配置值和预览不能证明 Claude 客户端已使用网关。", "The profile reloads before each forwarded request. Configuration and previews do not prove client integration."));
  put("timezone", report.profile?.timezone ?? missing, "not_applicable", tr("仅作为出口配置参考；网关没有改写系统时区，也没有向 Claude 转发时区。", "Reference only: the gateway neither changes the system timezone nor forwards a timezone to Claude."));
  for (const [id, value, score] of [
    ["language", language, rules.languageScore(langs)],
    ["languageVariant", language, rules.variantScore(langs)],
    ["locale", outboundLocale, rules.localeScore(outboundLocale ?? "")],
  ] as const) {
    put(id, value ?? (current ? tr("未发送此头", "Header not sent") : tr("等待真实 Claude 请求", "Awaiting a real Claude request")), value ? score > 0 ? "warning" : "ok" : "unknown", `${headerDetail} ${cloakNote}`, value ? score : 0, Boolean(value && original && cloakOn && (id === "locale" ? original["x-checkcc-target-locale"] !== value : original["accept-language"] !== value)));
  }
  for (const id of ["language", "languageVariant", "locale"]) {
    const sample = observations.get(id);
    if (sample?.cloaked) sample.originalValue = original?.[id === "locale" ? "x-checkcc-target-locale" : "accept-language"];
  }
  const preview = JSON.stringify(report.previewHeaders);
  const headersMatch = Boolean(current && report.profile && language === report.previewHeaders["accept-language"] && outboundLocale === report.previewHeaders["x-checkcc-target-locale"]);
  put("os", report.platform, "ok", tr("这是 Node 网关所在系统，不是浏览器操作系统；不转发为 Claude 用户设备信息。", "The Node gateway host OS, not the browser OS; not forwarded as the Claude user's device."));

  const geo = gatewayExitGeo(report, locale);
  const networkDetail = tr("由网关进程通过同一 Node 原生网络栈访问 IP 服务实测。按域名分流时，IP 服务出口可能与 Claude 不同；此结果不证明 Claude 边缘看到相同 IP。", "Measured by the gateway using the same native Node transport. Domain-based routing can give IP services and Claude different exits; this does not prove the IP seen by Claude's edge.");
  const exit = report.exit;
  const sources = exit?.sources ?? [];
  const countries = [...new Set(sources.map((source) => source.countryCode))];
  const riskyCountries = countries.filter((code) => RISK_COUNTRIES.includes(code));
  if (geo) {
    const risky = Boolean(geo.countryCode && RISK_COUNTRIES.includes(geo.countryCode));
    put("country", geo.countryName, risky ? "warning" : "ok", networkDetail, risky ? 1 : 0);
    put("browserIpLocation", [geo.countryName, geo.regionName, geo.city].filter(Boolean).join(" / "), "ok", networkDetail);
    put("browserIpOrg", [geo.asn, geo.org].filter(Boolean).join(" · ") || missing, geo.org || geo.asn ? "ok" : "unknown", networkDetail);
  }
  if (exit) {
    put("proxyCountry", sources.map((source) => `${source.source}: ${source.countryCode}`).join(" / ") || missing, exit.consistentCountry === true ? "ok" : exit.consistentCountry === false ? "warning" : sources.length ? "not_applicable" : "unknown", tr("至少两家 IP 情报源同意国家才标为核对通过；单源结果无法验证一致性。", "A country cross-check needs at least two agreeing providers. One provider cannot verify consistency."));
    put("ipv4", exit.ipv4 ?? missing, exit.ipv4 ? "ok" : "unknown", `${networkDetail} IPv4: ${exit.ipv4Error ?? "OK"}; IPv6: ${exit.ipv6Error ?? "OK"}`);
  }
  for (const [id, probe] of [["claudeReachability", report.probes?.claude], ["anthropicReachability", report.probes?.anthropic]] as const) {
    if (!probe) { put(id, missing, "unknown", offline); continue; }
    const status = probe.status;
    const value = status ? `HTTP ${status} · ${probe.elapsedMs} ms${status >= 300 && status < 400 ? tr(" · 已收到响应，网络可达", " · response received, network reachable") : status === 401 ? tr(" · 未验证授权", " · authorization not verified") : ""}` : probe.error ?? missing;
    put(id, value, !status ? "error" : status >= 400 ? "warning" : "ok", tr("网关直出探测，不携带 API Key、不创建消息、不验证账号或模型权限。收到 HTTP 响应表示网络已连通，3xx 按网络可达计分；401/403/429 不等于账号可用。重定向未跟随，未验证最终页面。", "Gateway egress probe without API keys or message creation. An HTTP response proves network reachability; 3xx counts as reachable. 401/403/429 do not verify account access. Redirects are not followed and the final page is not verified."), id === "claudeReachability" && !status ? 1 : 0);
  }
  put("claudeTrigger", report.lastFailure ? tr(`上游失败：${report.lastFailure.error}`, `Upstream failure: ${report.lastFailure.error}`) : current?.status ? `HTTP ${current.status} · ${current.startedAt}` : tr("等待真实 Claude 请求", "Awaiting a real Claude request"), report.lastFailure ? "error" : current?.status ? successful ? "ok" : "warning" : "unknown", `${tr("仅记录经此网关转发后收到的真实上游响应，自动诊断请求不计入。保存配置后需要再发起一次 Claude 请求。", "Only actual forwarded upstream responses count; diagnostic probes do not. Send a new Claude request after changing the profile.")} ${cloakNote}`);
  put("claudeLatency", current?.elapsedMs != null ? `${current.elapsedMs} ms` : missing, current?.elapsedMs != null ? "ok" : "unknown", tr("从收到真实请求至上游返回响应头的耗时，不是完整生成耗时或首 token 延迟。", "Time from actual inbound request to upstream response headers, not generation completion or first-token latency."));

  const httpLanguageObserved = original?.["accept-language"] ?? language ?? null;
  put("httpLanguage", httpLanguageObserved ?? missing, httpLanguageObserved ? "ok" : "unknown", httpLanguageObserved ? tr(`客户端原始 HTTP 语言偏好 ${httpLanguageObserved}（改写前观测值）。`, `Original client HTTP language ${httpLanguageObserved} (pre-rewrite observation).`) : missing, 0, Boolean(httpLanguageObserved && rewritten && cloakOn));
  const clues = report.clues ?? null;
  const httpSample = observations.get("httpLanguage");
  if (httpSample?.cloaked) { httpSample.originalValue = httpLanguageObserved ?? undefined; httpSample.value = language ?? httpSample.value; }
  if (clues) {
    const keys = Object.keys(clues.headers);
    put("requestHeaders", tr(`${keys.length} 个关键头`, `${keys.length} key headers`), keys.length >= 4 ? "ok" : "unknown", tr(`实际转发头：${keys.join(", ") || missing}。配置预览：${preview}；实际头与预览${headersMatch ? "一致" : "不一致"}。只记录语言/UA/指纹类字段，不记录凭证。`, `Forwarded headers: ${keys.join(", ") || missing}. Profile preview: ${preview}; observed headers ${headersMatch ? "match" : "do not match"} the preview. Only language/UA/fingerprint fields are recorded; credentials are never sampled.`));
    put("secFetch", clues.secFetch ?? missing, clues.secFetch ? "ok" : "not_applicable", clues.secFetch ? tr(`Sec-Fetch ${clues.secFetch}；浏览器请求与服务端直连的指纹不同。`, `Sec-Fetch ${clues.secFetch}; browser requests and server-side clients differ.`) : tr("该客户端未发送 Sec-Fetch 头（CLI/SDK 常见）。", "This client sent no Sec-Fetch headers (common for CLI/SDK)."));
    put("clientHints", clues.clientHintBrands ?? clues.clientHintPlatform ?? missing, clues.clientHintBrands ? "ok" : "not_applicable", clues.clientHintBrands ? tr(`Client Hints ${clues.clientHintBrands}${clues.clientHintPlatform ? ` · ${clues.clientHintPlatform}` : ""}。`, `Client Hints ${clues.clientHintBrands}${clues.clientHintPlatform ? ` · ${clues.clientHintPlatform}` : ""}.`) : tr("未发送 Client Hints；服务端客户端的 UA 与浏览器差异属于正常情况。", "No Client Hints sent; a server-side client's UA differing from a browser is expected."));
    put("deviceLineage", clues.sdk ?? missing, clues.sdk ? "ok" : "not_applicable", tr(`Stainless/客户端线索：${clues.sdk ?? missing}${clues.app ? ` · app ${clues.app}` : ""}。该信息说明请求方是 SDK 而非浏览器。`, `Stainless/client signals: ${clues.sdk ?? missing}${clues.app ? ` · app ${clues.app}` : ""}. This shows the caller is an SDK, not a browser.`));
  } else {
    for (const id of ["requestHeaders", "secFetch", "clientHints", "deviceLineage"]) put(id, missing, "unknown", tr("尚无真实 Claude 请求经过网关；接入后复检才能读到客户端线索。", "No real Claude request has passed through the gateway yet; recheck after integration to read client clues."));
  }

  const edge = report.edge ?? null;
  if (edge) {
    const ok = edge.http === 200 && edge.colo;
    put("edgeCountry", edge.loc ? countryDisplayName(edge.loc, locale) : missing, edge.loc ? "ok" : ok ? "unknown" : "error", ok ? tr(`边缘 trace 返回 ${edge.loc}（仅供参考，不代表 Claude 处理节点）。`, `Edge trace returned ${edge.loc} (reference only, not the Claude processing node).`) : (edge.error ?? missing));
    put("edgeCity", edge.city ?? tr("Cloudflare trace 不提供城市字段", "Cloudflare trace does not provide a city"), edge.city ? "ok" : ok ? "not_applicable" : "error", ok ? tr("trace 自报城市；Cloudflare 的 trace 响应不提供城市字段，本项不适用。", "City reported by trace; the Cloudflare trace response does not provide a city field, so this item is not applicable.") : (edge.error ?? missing), 0, false, undefined);
    put("edgeColo", edge.colo ?? missing, ok ? "ok" : "error", ok ? tr(`Cloudflare 边缘机房 ${edge.colo}（cdn-cgi/trace 实测）。`, `Cloudflare edge colo ${edge.colo} (measured via cdn-cgi/trace).`) : (edge.error ?? missing));
  } else {
    for (const id of ["edgeCountry", "edgeCity", "edgeColo"]) put(id, missing, "unknown", offline);
  }
  const asn = exit?.primary?.asn ?? null;
  const org = exit?.primary?.org ?? null;
  put("edgeAsn", asn ?? missing, asn ? "ok" : "unknown", asn ? tr("出口 ASN，与边缘机房不保证同一网络。", "Exit ASN; not guaranteed to be the edge network.") : missing);
  put("edgeAsnSecondary", asn ?? missing, asn ? "ok" : "unknown", asn ? tr("同一出口 ASN 的第二处展示（报告末行卡片）。", "Same exit ASN shown again in the last row card.") : missing);
  put("edgeOrg", org ?? missing, org ? "ok" : "unknown", org ? tr("出口网络组织，用于判断机房/云厂商特征。", "Exit network organization, used to infer datacenter/cloud traits.") : missing);

  const networkType = exitNetworkType(org, locale, asn);
  put("exitType", networkType.label, networkType.kind === "datacenter" ? "warning" : "unknown", networkType.detail, networkType.kind === "datacenter" ? 1 : 0);
  put("ipSourceCount", `${sources.length} / ${tr("目标 4 源", "target 4 sources")}`, sources.length ? "ok" : "unknown", sources.length ? tr(`成功返回出口情报的源：${sources.map((item) => item.source).join(", ")}。源多不代表结论更准，仅用于交叉核对。`, `Sources that returned exit intel: ${sources.map((item) => item.source).join(", ")}. More sources do not imply a stronger conclusion; they are used for cross-checking.`) : missing);
  const consistent = exit?.consistentCountry ?? (sources.length > 1 ? countries.length === 1 : null);
  put("multiSourceConsistency", consistent === null ? tr("源不足，无法交叉核对", "Not enough sources to cross-check") : consistent ? tr(`多源一致（${countries.join("/")}）`, `Consistent (${countries.join("/")})`) : tr(`多源不一致（${countries.join("/")}）`, `Inconsistent (${countries.join("/")})`), consistent === null ? (sources.length ? "not_applicable" : "unknown") : consistent ? "ok" : "error", tr("多源出口国家不一致时，实际出口可能不稳定或分流，建议复核代理规则。", "Conflicting exit countries suggest unstable or split routing; review proxy rules."), consistent === false ? 1 : 0);
  put("countrySet", countries.join(" / ") || missing, countries.length > 1 ? "warning" : countries.length ? "ok" : "unknown", tr("各情报源分别报告的国家；仅作核对集合，不单独判断。", "Countries reported by each provider; a cross-check set only."));
  put("ipCountryRisk", riskyCountries.length ? riskyCountries.join(" / ") : (countries.length ? tr("中低风险国家", "Lower-risk countries") : missing), riskyCountries.length ? "error" : countries.length ? "ok" : "unknown", riskyCountries.length ? tr("出口命中本项目高风险国家名单（CN/RU/IR/KP/SY/CU）。该项为规则命中，不是账号处罚概率。", "Exit matches this project's high-risk country list (CN/RU/IR/KP/SY/CU). This is a rule hit, not an account-penalty probability.") : tr("出口不在高风险国家名单内。", "Exit is outside the high-risk country list."), riskyCountries.length ? 1 : 0);
  const reachFailure = Boolean(report.probes?.claude && !report.probes.claude.status);
  const accessRisk = riskyCountries.length > 0 || reachFailure;
  const completeAccess = countries.length > 0 && Boolean(report.probes?.claude?.status);
  const accessSampled = Boolean(report.probes?.claude || sources.length);
  put("claudeAccessRisk", accessRisk ? (riskyCountries.length ? tr("当前网络出口命中目标风险地区", "Current exit hits a target risk region") : tr("claude.ai 出口侧不可达", "claude.ai unreachable from egress")) : completeAccess ? tr("未命中访问风险规则", "No access-risk rule hit") : accessSampled ? tr("访问风险证据不足：需出口国家及连通性结果", "Insufficient access-risk evidence: exit country and connectivity required") : missing, accessRisk ? "error" : completeAccess ? "ok" : "unknown", tr("综合实际出口国家与已执行的出口侧探测得出的启发式结论。缺少探测不能推断不可达，缺少国家不能判断低风险；不证明账号是否可用。", "Heuristic using observed exit countries and executed egress probes. Missing probes do not imply unreachability; missing countries cannot establish low risk. This does not verify account access."), accessRisk ? 1 : 0, false, !accessRisk && !completeAccess && accessSampled ? "inconclusive" : undefined);
  put("gatewayAsn", asn ?? missing, asn ? "ok" : "unknown", asn ? tr("出口 ASN（末行卡片）。", "Exit ASN (last-row card).") : missing);

  if (report.dns) {
    const dns = report.dns;
    const delegated = dns.mode === "proxy" && dns.localLookupSkipped === true;
    const verified = delegated && Boolean(dns.routeStatus) && !dns.error;
    const detail = tr("本项验证本程序的目标域名解析路径：检测到 HTTP 代理时，消息与诊断均把目标域名交给 CONNECT，本程序跳过本机目标域名查询。两家 DoH 通过相同传输查询作参考。此结果不证明代理内部的 DNS 出口或整台电脑无泄漏；系统范围需在所用代理软件中核对 TUN、DNS 及分流配置。", "Checks this application's target resolution path: with an HTTP proxy, messages and diagnostics delegate the hostname via CONNECT and skip local target lookup. Two DoH references use the same transport. This does not verify the proxy's internal DNS egress or system-wide leaks; check your proxy software’s TUN, DNS and routing configuration.");
    put("dnsMode", delegated ? tr("代理解析 · 跳过本机目标域名查询", "Proxy resolution · local target lookup skipped") : tr("系统 DNS · 本机目标域名查询", "System DNS · local target lookup"), dns.error ? "error" : "ok", detail);
    put("dnsReview", dns.error ?? (verified ? tr("代理解析已验证 · 本程序未做本机目标查询", "Proxy resolution verified · no local target lookup by this app") : tr("系统解析已完成 · 未验证代理内部 DNS", "System lookup complete · proxy DNS unverified")), dns.error ? "error" : verified ? "ok" : "unknown", detail, dns.error ? 1 : 0, verified, !dns.error && !verified ? "inconclusive" : undefined);
    const agreement = dns.referenceAgreement;
    const referenceDetail = `${detail} ${(dns.references ?? []).map((item) => `${item.source}: ${item.answers.join(", ") || item.error}`).join("; ")}`;
    put("dnsConsistency", dns.error ?? (agreement === true ? tr("两源 DNS 参考答案交叉核对通过", "Two DNS reference answer sets overlap") : agreement === false ? tr("DNS 参考答案不同 · CDN 差异无法判为泄漏", "DNS reference answers differ · CDN variation is not proof of leakage") : tr("DNS 参考源未提供足够数据", "DNS references returned insufficient data")), dns.error ? "error" : agreement === true ? "ok" : "unknown", referenceDetail, dns.error ? 1 : 0, false, !dns.error && agreement !== true ? "inconclusive" : undefined);
  } else {
    put("dnsMode", missing, "unknown", offline);
  }

  // 补齐没有写入观测值的网关侧信号，避免任何一项停留在空卡片。
  for (const [id, config] of Object.entries(detectionConfig.signals)) {
    if (config.enabled && config.environment !== "browser" && !observations.has(id)) put(id, missing, "unknown", tr("此项尚无实测证据。", "No measured evidence for this signal."));
  }

  for (const id of report.testedSignals ?? []) {
    const signal = observations.get(id);
    if (signal) {
      signal.testedAt = report.checkedAt ?? new Date().toISOString();
      if (signal.assessment === "unknown" && !signal.observation) signal.observation = signal.value === missing ? "unavailable" : "inconclusive";
    }
  }
  // Values derived from the current report are measurements too: gateway profile,
  // observed headers and client clues otherwise stay "untested" forever.
  for (const signal of observations.values()) {
    if (signal.environment === "browser" || signal.testedAt) continue;
    if (!signal.value || signal.value === missing || signal.assessment === "unknown" || signal.assessment === "not_applicable") continue;
    signal.testedAt = report.checkedAt ?? new Date().toISOString();
  }
  return { signals: sortSignals(observations), geo, report, error: null, verifiedRequest: successful && !report.lastFailure, cloak };
}

function sortSignals(observations: Map<string, SignalResult>) {
  return Object.entries(detectionConfig.signals)
    .filter(([, config]) => config.enabled)
    .sort(([, a], [, b]) => a.order - b.order)
    .map(([id]) => observations.get(id))
    .filter((signal): signal is SignalResult => Boolean(signal));
}

export async function checkGateway(locale: LocaleCode, signalId?: string): Promise<GatewayCheck> {
  try { return buildGatewayCheck(await readGateway(signalId ? `/__checkcc/diagnostics?signal=${encodeURIComponent(signalId)}` : "/__checkcc/diagnostics"), locale); }
  catch (error) {
    const reason = error instanceof Error ? error.message : "NETWORK_ERROR";
    const result = buildGatewayCheck(null, locale, reason);
    const testedAt = new Date().toISOString();
    result.signals = result.signals.map((signal) => detectionConfig.signals[signal.id]?.environment !== "browser" && signalTestKind(signal.id) === "native" && (!signalId || signalId === signal.id)
      ? { ...signal, value: reason, assessment: "error", testedAt } : signal);
    return result;
  }
}

// 内核状态只读：GET 不触发网络探测，页面轮询用它。
export type ExitHistory = { windowHours: number; samples: number; changes: number; stable: boolean; current: string | null; ips: string[]; firstAt: string | null; lastAt: string | null };

export async function readNetCore(): Promise<{ netCore: NetCoreReport | null; exitHistory: ExitHistory | null }> {
  const response = await fetch(`${gatewayUrl}/__checkcc/net-core`, {
    headers: { "X-CheckCC-Client": "gateway-ui" }, cache: "no-store", signal: AbortSignal.timeout(6000),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(value?.error ?? `HTTP ${response.status}`);
  return { netCore: (value?.netCore ?? null) as NetCoreReport | null, exitHistory: (value?.exitHistory ?? null) as ExitHistory | null };
}

export type NetCoreAction = "start" | "stop" | "restart" | "select" | "tunnel" | "strict" | "unlock-region";

// 内核动作：白名单由网关二次校验；失败原因原样返回，不做兜底美化。
export async function controlNetCore(action: NetCoreAction, node?: string, options: { enabled?: boolean } = {}): Promise<{ ok: boolean; reason: string | null; netCore: NetCoreReport | null }> {
  const response = await fetch(`${gatewayUrl}/__checkcc/net-core`, {
    method: "POST",
    headers: { "X-CheckCC-Client": "gateway-ui", "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...(node ? { node } : {}), ...(["tunnel", "strict"].includes(action) ? { enabled: options.enabled !== false } : {}) }),
    cache: "no-store", signal: AbortSignal.timeout(["strict", "tunnel", "start", "restart", "select"].includes(action) ? 180000 : 30000),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(value?.error ?? `HTTP ${response.status}`);
  return { ok: value?.ok === true, reason: typeof value?.reason === "string" ? value.reason : null, netCore: (value?.netCore ?? null) as NetCoreReport | null };
}

export type HostInstallResult = { ok: boolean; reason: string | null; hostMode: boolean };

/**
 * 通过系统授权弹窗安装特权宿主（macOS）。
 * 只发送固定动作，安装路径与命令由服务端决定；密码/Touch ID 在系统窗口完成。
 */
export async function installKernelHost(): Promise<HostInstallResult> {
  const response = await fetch(`${gatewayUrl}/__checkcc/net-core/host`, {
    method: "POST",
    headers: { "X-CheckCC-Client": "gateway-ui", "Content-Type": "application/json" },
    body: JSON.stringify({ action: "install" }),
    cache: "no-store", signal: AbortSignal.timeout(180000),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, reason: value?.error ?? `HTTP ${response.status}`, hostMode: false };
  return { ok: value?.ok === true, reason: typeof value?.reason === "string" ? value.reason : null, hostMode: value?.hostMode === true };
}

export type NetCoreImportPayload = (
  | { mode: "url"; url: string; selected?: string }
  | { mode: "content"; content: string; selected?: string }
  | { mode: "manual"; proxies: unknown[]; selected?: string }
  | { mode: "local-proxy"; port: number; protocol: string; name?: string }
) & {
  /** 编辑已有供应商：只更新这一条，不新建。 */
  sourceId?: string;
  /** 供应商名称；不传时由后端按域名/来源生成。 */
  name?: string;
};

export type LocalProxyEntry = { port: number; pid: number; process: string; tool: string; protocol: string };

/** 扫描本机已装的代理客户端（FlClash / Clash Verge 等）可借用的端口。只读，不改它们的配置。 */
export async function scanLocalProxies(): Promise<{ items: LocalProxyEntry[]; summary: string }> {
  const response = await fetch(`${gatewayUrl}/__checkcc/net-core/local-proxies`, {
    method: "GET",
    headers: { "X-CheckCC-Client": "gateway-ui" },
    cache: "no-store", signal: AbortSignal.timeout(20000),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok || !value?.ok) throw new Error(value?.error ?? `HTTP ${response.status}`);
  return { items: Array.isArray(value.items) ? value.items : [], summary: String(value.summary ?? "") };
}

export type NetCoreImportResult = {
  ok: boolean;
  imported?: number;
  skipped?: Array<{ index?: number; reason: string; link?: string }>;
  selected?: string;
  reason?: string;
  netCore?: NetCoreReport | null;
};

// 导入节点：解析与落盘都在后端完成；界面只展示真实结果，不猜测成功。
export async function importNetCore(payload: NetCoreImportPayload): Promise<NetCoreImportResult> {
  const response = await fetch(`${gatewayUrl}/__checkcc/net-core/import`, {
    method: "POST",
    headers: { "X-CheckCC-Client": "gateway-ui", "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store", signal: AbortSignal.timeout(60000),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, reason: value?.error ?? `HTTP ${response.status}` };
  return value as NetCoreImportResult;
}

export type NetCoreRefreshResult = { ok: boolean; reason?: string; skipped?: boolean; skippedItems?: Array<{ reason: string }>; imported?: number; selected?: string; netCore?: NetCoreReport | null };

export type NetCoreSourceAction = "activate" | "delete" | "rename" | "refresh";

export type NetCoreSourceResult = { ok: boolean; reason?: string; activeId?: string | null; name?: string; sources?: NetCoreSource[]; netCore?: NetCoreReport | null };

/** 供应商操作：切换 / 删除 / 重命名 / 刷新单条订阅。写操作统一走后端，失败保留原状态。 */
export async function netCoreSourceAction(action: NetCoreSourceAction, id: string, name = ""): Promise<NetCoreSourceResult> {
  const response = await fetch(`${gatewayUrl}/__checkcc/net-core/sources`, {
    method: "POST",
    headers: { "X-CheckCC-Client": "gateway-ui", "Content-Type": "application/json" },
    body: JSON.stringify({ action, id, name }),
    cache: "no-store", signal: AbortSignal.timeout(180000),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, reason: value?.reason ?? value?.error ?? `HTTP ${response.status}`, netCore: value?.netCore ?? null };
  return { ok: value?.ok !== false, reason: value?.reason, ...value } as NetCoreSourceResult;
}

// 订阅刷新：强制拉取订阅并替换节点；失败保留现有配置。
export async function refreshNetCore(force = true): Promise<NetCoreRefreshResult> {
  const response = await fetch(`${gatewayUrl}/__checkcc/net-core/refresh`, {
    method: "POST",
    headers: { "X-CheckCC-Client": "gateway-ui", "Content-Type": "application/json" },
    body: JSON.stringify({ force }),
    cache: "no-store", signal: AbortSignal.timeout(60000),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, reason: value?.reason ?? value?.error ?? `HTTP ${response.status}`, netCore: value?.netCore ?? null };
  return value as NetCoreRefreshResult;
}

export type NetCoreDelayResult = { ok: boolean; delays: Record<string, number | null>; reason?: string; netCore?: NetCoreReport | null };

// 节点延迟：后端并行读取内核测速结果；失败节点为 null，界面不得显示成 0ms。
// force=true 绕过缓存，用于用户主动点「测速」。
export async function measureNetCoreDelay(names: string[], { force = false } = {}): Promise<NetCoreDelayResult> {
  const response = await fetch(`${gatewayUrl}/__checkcc/net-core/delay`, {
    method: "POST",
    headers: { "X-CheckCC-Client": "gateway-ui", "Content-Type": "application/json" },
    body: JSON.stringify(force ? { names, force: true } : { names }),
    cache: "no-store", signal: AbortSignal.timeout(60000),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, delays: {}, reason: value?.error ?? `HTTP ${response.status}` };
  return value as NetCoreDelayResult;
}

export type NetCoreEgressMode = "rule" | "global" | "direct";

// 切换出站模式：rule=海外走节点，global=全部走节点，direct=除固定 Claude 出口外全直连。
export async function setNetCoreMode(mode: NetCoreEgressMode): Promise<{ ok: boolean; reason?: string; mode?: NetCoreEgressMode; netCore?: NetCoreReport | null }> {
  const response = await fetch(`${gatewayUrl}/__checkcc/net-core/mode`, {
    method: "POST",
    headers: { "X-CheckCC-Client": "gateway-ui", "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
    cache: "no-store", signal: AbortSignal.timeout(60000),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, reason: value?.reason ?? value?.error ?? `HTTP ${response.status}`, netCore: value?.netCore ?? null };
  return value;
}

// 网络异常时的处置：claude（默认）只阻断 Claude 域名，其他流量照常；all 才启用严格断流。
export type NetCoreNetworkFailure = "claude" | "all";

export async function setNetCoreNetworkFailure(policy: NetCoreNetworkFailure): Promise<{ ok: boolean; reason?: string; networkFailure?: NetCoreNetworkFailure; netCore?: NetCoreReport | null }> {
  const response = await fetch(`${gatewayUrl}/__checkcc/net-core/network-failure`, {
    method: "POST",
    headers: { "X-CheckCC-Client": "gateway-ui", "Content-Type": "application/json" },
    body: JSON.stringify({ policy }),
    cache: "no-store", signal: AbortSignal.timeout(60000),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, reason: value?.reason ?? value?.error ?? `HTTP ${response.status}`, netCore: value?.netCore ?? null };
  return value;
}

// 用户网络声明（内网域名 / 豁免 IP / DNS / 网卡）：文件仍是唯一真相，界面只是编辑器。
export type NetCoreNetworkConfig = {
  directDomains?: string[];
  dnsServers?: string[];
  directInterface?: string;
  dnsInterface?: string;
  strictRoute?: boolean;
  routeExcludeAddresses?: string[];
};

export type NetCoreNetworkEffective = {
  target: string;
  domainRules: string[];
  ipRules: string[];
  nameserverPolicy: Record<string, string[]>;
  fakeIpFilter: string[];
  dnsServers: string[];
  defaultExclusions: string[];
  redundantAddresses: Array<{ value: string; coveredBy: string }>;
};

export type NetCoreNetworkState = {
  ok: boolean;
  path: string;
  config: NetCoreNetworkConfig | null;
  effective: NetCoreNetworkEffective | null;
  problem: string | null;
  interfaces: Array<{ name: string; address: string }>;
  pendingRestart: boolean;
  canRestart: boolean;
  reason?: string;
  netCore?: NetCoreReport | null;
};

// 只读：文件损坏时后端也返回 problem，而不是让界面卡在报错上。
export async function readNetCoreNetwork(): Promise<NetCoreNetworkState> {
  const response = await fetch(`${gatewayUrl}/__checkcc/net-core/network`, {
    headers: { "X-CheckCC-Client": "gateway-ui" }, cache: "no-store", signal: AbortSignal.timeout(10000),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(value?.error ?? value?.reason ?? `HTTP ${response.status}`);
  return value as NetCoreNetworkState;
}

// 保存：后端用 buildKernelConfig + assertKernelConfig 试算，非法值在这里被拒且不写盘。
export async function saveNetCoreNetwork(config: NetCoreNetworkConfig, restart = false): Promise<NetCoreNetworkState> {
  const response = await fetch(`${gatewayUrl}/__checkcc/net-core/network`, {
    method: "POST",
    headers: { "X-CheckCC-Client": "gateway-ui", "Content-Type": "application/json" },
    body: JSON.stringify({ config, restart }),
    cache: "no-store", signal: AbortSignal.timeout(90000),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok || value?.ok === false) {
    return { ...(value ?? {}), ok: false, reason: value?.reason ?? value?.error ?? `HTTP ${response.status}` } as NetCoreNetworkState;
  }
  return value as NetCoreNetworkState;
}

// 解析测试：由内核代查（普通进程直接查内网 DNS 会被 strict-route 拦住），结论才可信。
export type NetCoreDomainCheck = {
  name: string;
  status: number;
  addresses: string[];
  fakeIp: boolean;
  restarted: boolean;
  elapsedMs: number;
};

export async function verifyNetCoreDomain(config: NetCoreNetworkConfig, name: string): Promise<NetCoreDomainCheck & NetCoreNetworkState & { reason?: string }> {
  const response = await fetch(`${gatewayUrl}/__checkcc/net-core/verify-domain`, {
    method: "POST",
    headers: { "X-CheckCC-Client": "gateway-ui", "Content-Type": "application/json" },
    body: JSON.stringify({ config, name }),
    cache: "no-store", signal: AbortSignal.timeout(90000),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok || value?.ok === false) {
    return { ...(value ?? {}), ok: false, reason: value?.reason ?? value?.error ?? `HTTP ${response.status}` } as NetCoreDomainCheck & NetCoreNetworkState & { reason?: string };
  }
  return value;
}

export type NetCoreExitEntry = { countryCode: string | null; country: string | null; ip: string | null };
export type NetCoreExitResult = { ok: boolean; exits: Record<string, NetCoreExitEntry | null>; reason?: string; netCore?: NetCoreReport | null };

/** 逐节点实测出口国家：会依次切换选中节点，测完还原。显式触发，避免自动轮询造成 IP 抖动。 */
export async function probeNodeExits(names: string[]): Promise<NetCoreExitResult> {
  const response = await fetch(gatewayUrl + "/__checkcc/net-core/exits", {
    method: "POST",
    headers: { "X-CheckCC-Client": "gateway-ui", "Content-Type": "application/json" },
    body: JSON.stringify({ names }),
    cache: "no-store", signal: AbortSignal.timeout(180000),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, exits: {}, reason: value?.error ?? ("HTTP " + response.status) };
  return value as NetCoreExitResult;
}
