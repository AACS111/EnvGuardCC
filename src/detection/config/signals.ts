// EnvGuardCC 的检测信号配置，用于声明各风险信号的启用状态、来源、权重、检测环境和展示顺序。
// order 同时决定界面网格顺序；仅启用项进入界面与检测报告。
// environment: browser=浏览器环境实测，claude=Claude 网关实测（Claude 真正发出的请求/出口），both=两侧都可测，用于对比拦截迷惑层是否生效。
import type { DetectionEnvironment, DetectionSignalConfig } from "./types";

type SignalInput = {
  labelKey: string;
  source: DetectionSignalConfig["source"];
  weight: number;
  environment: DetectionEnvironment;
  enabled?: boolean;
};

const ordered: Array<[string, SignalInput]> = [
  // 第 1 行
  ["timezone", { labelKey: "timezone", source: "browser", weight: 26, environment: "browser" }],
  ["language", { labelKey: "language", source: "browser", weight: 5, environment: "both" }],
  ["languageVariant", { labelKey: "languageVariant", source: "browser", weight: 12, environment: "both" }],
  ["chineseFonts", { labelKey: "chineseFonts", source: "browser", weight: 16, environment: "browser" }],
  // 第 2 行
  ["vendorFonts", { labelKey: "vendorFonts", source: "browser", weight: 0, environment: "browser" }],
  ["domesticBrowser", { labelKey: "domesticBrowser", source: "browser", weight: 0, environment: "browser" }],
  ["domesticDevice", { labelKey: "domesticDevice", source: "browser", weight: 0, environment: "browser" }],
  ["locale", { labelKey: "locale", source: "browser", weight: 4, environment: "both" }],
  // 第 3 行
  ["timezoneOffset", { labelKey: "timezoneOffset", source: "browser", weight: 3, environment: "browser" }],
  ["emojiStyle", { labelKey: "emojiStyle", source: "browser", weight: 2, environment: "browser" }],
  ["country", { labelKey: "country", source: "server", weight: 18, environment: "both" }],
  ["proxyCountry", { labelKey: "proxyCountry", source: "server", weight: 0, environment: "claude" }],
  // 第 4 行
  ["ipv4", { labelKey: "ipv4", source: "server", weight: 0, environment: "both" }],
  ["browserIpLocation", { labelKey: "browserIpLocation", source: "server", weight: 0, environment: "both" }],
  ["browserIpOrg", { labelKey: "browserIpOrg", source: "server", weight: 0, environment: "both" }],
  ["os", { labelKey: "os", source: "browser", weight: 0, environment: "both" }],
  // 第 5 行
  ["claudeReachability", { labelKey: "claudeReachability", source: "gateway", weight: 6, environment: "both" }],
  ["anthropicReachability", { labelKey: "anthropicReachability", source: "gateway", weight: 0, environment: "both" }],
  ["apiReachability", { labelKey: "apiReachability", source: "gateway", weight: 0, environment: "both", enabled: false }],
  ["claudeTrigger", { labelKey: "claudeTrigger", source: "gateway", weight: 0, environment: "claude" }],
  // 第 6 行
  ["claudeLatency", { labelKey: "claudeLatency", source: "gateway", weight: 0, environment: "claude" }],
  ["webrtcSupport", { labelKey: "webrtcSupport", source: "browser", weight: 0, environment: "browser" }],
  ["webrtcCandidates", { labelKey: "webrtcCandidates", source: "browser", weight: 0, environment: "browser" }],
  ["webrtcLeak", { labelKey: "webrtcLeak", source: "browser", weight: 19, environment: "browser" }],
  // 第 7 行
  ["webrtcLeakCount", { labelKey: "webrtcLeakCount", source: "browser", weight: 0, environment: "browser" }],
  ["webrtcFirstIp", { labelKey: "webrtcFirstIp", source: "browser", weight: 0, environment: "browser" }],
  ["webrtcRegion", { labelKey: "webrtcRegion", source: "browser", weight: 0, environment: "browser" }],
  ["webrtcConsistency", { labelKey: "webrtcConsistency", source: "browser", weight: 0, environment: "browser" }],
  // 第 8 行
  ["dnsMode", { labelKey: "dnsMode", source: "gateway", weight: 0, environment: "claude" }],
  ["dnsReview", { labelKey: "dnsReview", source: "gateway", weight: 2, environment: "claude" }],
  ["dnsConsistency", { labelKey: "dnsConsistency", source: "gateway", weight: 5, environment: "claude" }],
  ["gatewayProfile", { labelKey: "gatewayProfile", source: "gateway", weight: 0, environment: "claude" }],
  // 第 9 行
  ["deviceLineage", { labelKey: "deviceLineage", source: "browser", weight: 0, environment: "both" }],
  ["edgeCountry", { labelKey: "edgeCountry", source: "gateway", weight: 0, environment: "claude" }],
  ["edgeColo", { labelKey: "edgeColo", source: "gateway", weight: 0, environment: "claude" }],
  ["edgeCity", { labelKey: "edgeCity", source: "gateway", weight: 0, environment: "claude" }],
  // 第 10 行
  ["edgeAsn", { labelKey: "edgeAsn", source: "gateway", weight: 0, environment: "claude" }],
  ["edgeOrg", { labelKey: "edgeOrg", source: "gateway", weight: 0, environment: "claude" }],
  ["requestHeaders", { labelKey: "requestHeaders", source: "gateway", weight: 0, environment: "claude" }],
  ["httpLanguage", { labelKey: "httpLanguage", source: "gateway", weight: 0, environment: "claude" }],
  // 第 11 行
  ["secFetch", { labelKey: "secFetch", source: "gateway", weight: 0, environment: "claude" }],
  ["clientHints", { labelKey: "clientHints", source: "gateway", weight: 0, environment: "claude" }],
  ["exitType", { labelKey: "exitType", source: "gateway", weight: 13, environment: "claude" }],
  ["multiSourceConsistency", { labelKey: "multiSourceConsistency", source: "gateway", weight: 15, environment: "claude" }],
  // 第 12 行
  ["ipSourceCount", { labelKey: "ipSourceCount", source: "gateway", weight: 0, environment: "claude" }],
  ["countrySet", { labelKey: "countrySet", source: "gateway", weight: 0, environment: "claude" }],
  ["ipCountryRisk", { labelKey: "ipCountryRisk", source: "gateway", weight: 18, environment: "claude" }],
  ["claudeAccessRisk", { labelKey: "claudeAccessRisk", source: "gateway", weight: 16, environment: "both" }],
  // 第 13 行（底部两张 ASN 卡片）
  ["edgeAsnSecondary", { labelKey: "edgeAsn", source: "gateway", weight: 0, environment: "claude" }],
  ["gatewayAsn", { labelKey: "asn", source: "gateway", weight: 0, environment: "claude" }],
];

export const signalConfig: Record<string, DetectionSignalConfig> = Object.fromEntries(
  ordered.map(([id, input], index) => [id, {
    enabled: input.enabled !== false,
    labelKey: input.labelKey,
    source: input.source,
    weight: input.weight,
    order: index + 1,
    environment: input.environment,
  }]),
);

export const orderedSignalIds = ordered.map(([id]) => id);

export function signalEnvironment(id: string): DetectionEnvironment {
  return signalConfig[id]?.environment ?? "browser";
}
