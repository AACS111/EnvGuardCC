// 检测项分层：决定「异常」该不该算在保护头上。
// 背景：字体/Emoji 是系统事实，出口与可达性取决于节点——它们一直为红时，
// 用户会误以为保护失效。这里把它们与真正的声明面项目分开统计。

export type SignalRequirement = "rewritable" | "environment" | "link";

// 环境固有限制：平台/OS/字体/Emoji 的实际渲染，任何声明面改写都改不了。
const ENVIRONMENT = new Set([
  "chineseFonts", "vendorFonts", "emojiStyle", "domesticDevice", "domesticBrowser", "deviceLineage", "os",
]);

// 链路与出口：由节点、路由、网络状况决定；换节点或重测才能改变，不属声明面。
const LINK = new Set([
  "country", "proxyCountry", "ipv4", "browserIpLocation", "browserIpOrg",
  "claudeReachability", "anthropicReachability", "apiReachability", "claudeTrigger", "claudeLatency",
  "webrtcConsistency", "webrtcRegion", "edgeCountry", "edgeCity", "edgeColo", "edgeAsn", "edgeOrg", "dnsMode", "dnsReview",
  // 出口类型/ASN/IP 情报交叉核对：完全取决于节点与情报源，声明面改不了。
  "exitType", "asn", "gatewayAsn", "multiSourceConsistency", "ipSourceCount", "countrySet",
]);

export function signalRequirement(id: string): SignalRequirement {
  if (ENVIRONMENT.has(id)) return "environment";
  if (LINK.has(id)) return "link";
  // 其余属于声明面：语言、区域、时区、WebRTC 泄漏、DNS 一致性、网关画像等，保护可以改写。
  return "rewritable";
}

/** 把异常项分成「可保护」「环境固有」「链路」三堆；只有第一堆算作保护失效。 */
export function partitionIssues<T extends { id: string }>(issues: T[]) {
  const actionable: T[] = [];
  const environment: T[] = [];
  const link: T[] = [];
  for (const issue of issues) {
    const bucket = signalRequirement(issue.id);
    if (bucket === "environment") environment.push(issue);
    else if (bucket === "link") link.push(issue);
    else actionable.push(issue);
  }
  return { actionable, environment, link };
}

export function requirementLabel(zh: boolean, requirement: SignalRequirement): string {
  if (requirement === "environment") return zh ? "环境固有限制" : "Environment limit";
  if (requirement === "link") return zh ? "链路 / 节点" : "Link / node";
  return zh ? "可保护" : "Protectable";
}
