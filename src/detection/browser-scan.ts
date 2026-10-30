// EnvGuardCC 的浏览器侧完整扫描：环境快照 + WebRTC 泄漏 + 多源出口情报 + 可达性实测。
// 输出按 signalConfig 的 50 项顺序排列，便于与 Claude 网关侧逐项对比。
import { collectBrowserEnvironment, makeSignal, makeSignalScore, type BrowserEnvironmentSnapshot } from "./client-engine";
import { detectionConfig, getSignalConfig } from "./config";
import { collectBrowserIpIntel, collectBrowserReachability, probeWebrtc, RISK_COUNTRIES, type BrowserIpIntelligence, type BrowserReachability, type WebrtcProbe } from "./browser-probes";
import type { DetectorLocaleText } from "./locale";
import type { LocaleCode } from "@/i18n/messages";
import type { RegionCode, SignalResult } from "./types";
import * as rules from "./signal-rules";
import { activeRuntimePolicy } from "./environment-runtime";
import { policyAffectsSignal } from "./environment-actions";
import { collectBrowserSignals } from "./client-engine";

export type BrowserScan = {
  signals: SignalResult[];
  snapshot: BrowserEnvironmentSnapshot;
  webrtc: WebrtcProbe;
  ipIntel: BrowserIpIntelligence | null;
  reachability: BrowserReachability | null;
};

const DATACENTER_PATTERN = /(cloud|amazon|aws|google|azure|digitalocean|ovh|hetzner|linode|vultr|alibaba|aliyun|tencent|m247|choopa|leaseweb|contabo|oracle|cloudflare|fastly|akamai|hosting|datacenter|server|vpn|proxy)/i;

export async function runBrowserScan(region: RegionCode, locale: LocaleCode, text: DetectorLocaleText, signalId?: string): Promise<BrowserScan> {
  const snapshot = collectBrowserEnvironment(text);
  // 三项并行：WebRTC 候选、出口情报、可达性；任一失败都不阻塞其它信号。
  const [webrtc, ipIntel, reachability] = await Promise.all([
    !signalId || signalId.startsWith("webrtc") ? probeWebrtc() : Promise.resolve({ supported: false, candidates: 0, publicIps: [], hostCount: 0, srflxCount: 0, mdnsCount: 0, error: null } as WebrtcProbe),
    !signalId || ["country", "ipv4", "browserIpLocation", "browserIpOrg", "claudeAccessRisk", "webrtcConsistency"].includes(signalId) || signalId.startsWith("webrtc") ? collectBrowserIpIntel(locale).catch(() => null) : Promise.resolve(null),
    !signalId || ["claudeReachability", "anthropicReachability", "claudeAccessRisk"].includes(signalId) ? collectBrowserReachability().catch(() => null) : Promise.resolve(null),
  ]);

  const base = collectBrowserSignals(region, text, detectionConfig, snapshot, { webrtc, signalId }).signals;
  if (webrtc.error) {
    for (const sample of base.filter((signal) => signal.id.startsWith("webrtc"))) {
      sample.value = webrtc.supported ? webrtc.error : locale.startsWith("zh") ? "浏览器不支持 WebRTC，无法采样" : "WebRTC unavailable in this browser";
      sample.assessment = webrtc.supported ? "error" : "not_applicable";
    }
  } else if (webrtc.publicIps.length === 0) {
    for (const id of ["webrtcFirstIp", "webrtcRegion"]) {
      const sample = base.find((signal) => signal.id === id);
      if (sample) { sample.value = locale.startsWith("zh") ? "无公网候选地址，无需地域核对" : "No public candidates; region comparison unnecessary"; sample.assessment = "ok"; }
    }
  }
  const byId = new Map(base.map((signal) => [signal.id, signal]));
  const label = text.signalLabels;
  const value = text.signalValues;
  const countries = ipIntel?.countries ?? [];
  const riskyCountries = countries.filter((code) => RISK_COUNTRIES.includes(code));
  const primary = ipIntel?.primary ?? null;
  const languageVariant = byId.get("languageVariant");
  if (languageVariant) languageVariant.settingValue = snapshot.languages.join(", ");
  const consistency = byId.get("webrtcConsistency");
  if (consistency && webrtc.supported && !webrtc.error) {
    const noCandidates = webrtc.publicIps.length === 0;
    const knownExit = ipIntel?.ipv4 ?? primary?.ip;
    const matches = knownExit ? webrtc.publicIps.every((ip) => ip === knownExit) : null;
    Object.assign(consistency, {
      value: noCandidates ? (locale.startsWith("zh") ? "无公网候选地址，无需出口核对" : "No public candidates; exit comparison unnecessary") : matches === null ? (locale.startsWith("zh") ? "候选地址已采样，出口数据不足" : "Candidates sampled; exit data unavailable") : matches ? (locale.startsWith("zh") ? "候选地址与出口一致" : "Candidates match exit") : (locale.startsWith("zh") ? "候选地址与出口不同" : "Candidates differ from exit"),
      assessment: noCandidates || matches === true ? "ok" : matches === false ? "warning" : "unknown",
      ...(!noCandidates && matches === null ? { observation: "inconclusive" } : {}),
    });
  }
  const webrtcRegion = byId.get("webrtcRegion");
  if (webrtcRegion && webrtc.publicIps.length) { webrtcRegion.assessment = "unknown"; webrtcRegion.observation = "inconclusive"; }
  const networkDetail = locale.startsWith("zh")
    ? "浏览器侧三家 IP 情报源实测；只代表本机浏览器网络出口，不代表 Claude 实际看到的出口。"
    : "Measured by three browser-side IP providers; reflects this browser's exit only, not necessarily what Claude sees.";
  const notInBrowser = locale.startsWith("zh") ? "需切换到 Claude 环境实测" : "Requires the Claude environment";
  const notMeasured = value.notMeasured;
  const reachOk = (probe?: { ok: boolean; elapsedMs: number | null } | null) => probe?.ok === true;

  const put = (id: string, signal: SignalResult) => byId.set(id, signal);

  if (ipIntel) {
    if (primary?.countryCode) {
      const risky = riskyCountries.length > 0;
      put("country", makeSignalScore("country", label.country, primary.countryName, 18, risky ? 1 : 0, text, detectionConfig));
      put("country", { ...byId.get("country")!, detail: networkDetail, environment: "browser" });
    }
    put("proxyCountry", makeSignal("proxyCountry", label.proxyCountry, countries.join(" / ") || notMeasured, 0, false, text, detectionConfig));
    put("ipv4", makeSignal("ipv4", label.ipv4, ipIntel.ipv4 ?? ipIntel.ipv6 ?? notMeasured, 0, false, text, detectionConfig));
    put("browserIpLocation", makeSignal("browserIpLocation", label.browserIpLocation, [primary?.countryName, primary?.regionName, primary?.city].filter(Boolean).join(" / ") || notMeasured, 0, false, text, detectionConfig));
    put("browserIpOrg", makeSignal("browserIpOrg", label.browserIpOrg, [primary?.asn, primary?.org].filter(Boolean).join(" · ") || notMeasured, 0, false, text, detectionConfig));
    const consistent = ipIntel.consistentCountry;
    put("multiSourceConsistency", {
      ...makeSignalScore("multiSourceConsistency", label.multiSourceConsistency, consistent === null ? notMeasured : consistent ? `${countries.join("/")}` : `${countries.join("/")}`, 15, consistent === false ? 1 : 0, text, detectionConfig),
      assessment: consistent === null ? "unknown" : consistent ? "ok" : "error",
      detail: locale.startsWith("zh") ? "至少两源一致才算通过；不一致说明出口可能分流。" : "Needs at least two agreeing providers; conflicts suggest split routing.",
      environment: "browser",
    });
    put("ipSourceCount", makeSignal("ipSourceCount", label.ipSourceCount, `${ipIntel.okSources.length} / ${ipIntel.sources.length}`, 0, false, text, detectionConfig));
    put("countrySet", makeSignal("countrySet", label.countrySet, countries.join(" / ") || notMeasured, 0, false, text, detectionConfig));
    put("ipCountryRisk", {
      ...makeSignalScore("ipCountryRisk", label.ipCountryRisk, riskyCountries.length ? riskyCountries.join(" / ") : notMeasured, 18, riskyCountries.length ? 1 : 0, text, detectionConfig),
      assessment: riskyCountries.length ? "error" : "ok",
      detail: locale.startsWith("zh") ? "命中高风险出口国家名单（CN/RU/IR/KP/SY/CU）时为规则命中，不是封号概率。" : "A hit against the high-risk exit list (CN/RU/IR/KP/SY/CU); a rule hit, not a ban probability.",
      environment: "browser",
    });
    const datacenter = primary?.org ? DATACENTER_PATTERN.test(primary.org) : null;
    put("exitType", {
      ...makeSignalScore("exitType", label.exitType, datacenter === null ? notMeasured : datacenter ? (locale.startsWith("zh") ? "数据中心 / 云厂商" : "Datacenter / cloud provider") : (locale.startsWith("zh") ? "住宅 / 其它网络" : "Residential / other network"), 13, datacenter ? 1 : 0, text, detectionConfig),
      assessment: datacenter === null ? "unknown" : datacenter ? "warning" : "ok",
      detail: locale.startsWith("zh") ? `出口组织：${primary?.org ?? "未知"}。数据中心出口通常是 VPN 特征。` : `Exit org: ${primary?.org ?? "unknown"}. Datacenter exits usually look like VPNs.`,
      environment: "browser",
    });
  }
  if (reachability) {
    const probeMap: Array<[string, { ok: boolean; elapsedMs: number | null; error: string | null }]> = [
      ["claudeReachability", reachability.claude],
      ["anthropicReachability", reachability.anthropic],
    ];
    for (const [id, probe] of probeMap) {
      put(id, {
        ...makeSignalScore(id, label[id], probe.ok ? `${probe.elapsedMs} ms` : `${locale.startsWith("zh") ? "跨站探测未完成，无法判定网站可达性" : "Cross-site probe incomplete; site reachability is inconclusive"}${probe.error ? ` (${probe.error})` : ""}`, id === "claudeReachability" ? 6 : 0, 0, text, detectionConfig),
        assessment: probe.ok ? "ok" : "unknown",
        ...(!probe.ok ? { observation: "inconclusive" as const } : {}),
        detail: locale.startsWith("zh") ? "这里从本地检测页发起不带登录凭证的 no-cors 请求，与地址栏打开网站不同。CORP/COEP 响应策略、扩展拦截、重定向或网络错误都可能使脚本请求失败，即使网站可以正常打开。TypeError 不提供足够信息区分这些原因，超时也不能证明网站不可达。本项因此显示无法判定、不加分；可打开网站人工核对，点击打开不会自动标记通过。网关探测结果独立显示。" : "This credential-free no-cors request starts on the local checker; it differs from opening the site in the address bar. CORP/COEP policies, extensions, redirects or network errors can fail the script even when navigation works. TypeError cannot distinguish these causes, and a timeout does not prove unreachability. Incomplete probes remain inconclusive without risk points. Open the site to check manually; opening it is not an automatic pass. Gateway evidence is separate.",
        environment: "browser",
      });
    }
  }
  const riskyExit = riskyCountries.length > 0;
  const accessRisk = riskyExit;
  const completeAccessEvidence = Boolean(primary?.countryCode && reachOk(reachability?.claude));
  put("claudeAccessRisk", {
    ...makeSignalScore("claudeAccessRisk", label.claudeAccessRisk, accessRisk ? (locale.startsWith("zh") ? "浏览器出口命中风险国家" : "Browser exit hits a risk country") : (!completeAccessEvidence ? (locale.startsWith("zh") ? "网络采样不完整，无法判定访问风险" : "Network evidence incomplete; access risk is inconclusive") : (locale.startsWith("zh") ? "未命中访问风险规则" : "No access-risk rule hit")), 16, accessRisk ? 1 : 0, text, detectionConfig),
    assessment: accessRisk ? "error" : completeAccessEvidence ? "ok" : "unknown",
    ...(!accessRisk && !completeAccessEvidence ? { observation: "inconclusive" as const } : {}),
    detail: locale.startsWith("zh") ? "结合实际出口国家与浏览器探测的启发式结论。跨站脚本请求失败不能证明网站不可达，不因此增加访问风险分；缺少证据也不标记通过。实际命中风险出口国家时仍保留加分。此项不证明账号可用性。" : "Heuristic using exit-country evidence and the browser probe. A failed cross-site script does not prove unreachability or add access-risk points; missing evidence is not a pass. Actual risky-exit evidence retains its points. This does not verify account access.",
    environment: "browser",
  });

  // 按 50 项顺序输出；浏览器侧无法测的项明确标注需要切换环境。
  const signals = Object.entries(detectionConfig.signals)
    .filter(([, config]) => config.enabled)
    .sort(([, a], [, b]) => a.order - b.order)
    .map(([id, config]) => {
      const found = byId.get(id);
      if (found) return { ...found, ...(found.value === notMeasured || found.value === notInBrowser ? { assessment: "unknown" as const } : {}), environment: "browser" as const };
      const claudeOnly = config.environment === "claude";
      return {
        id, label: label[id] ?? config.labelKey, value: claudeOnly ? notInBrowser : notMeasured,
        score: 0, weight: config.weight, contribution: 0, source: config.source,
        assessment: "unknown" as const, environment: "browser" as const,
      };
    });

  const activePolicy = activeRuntimePolicy();
  if (activePolicy.webrtcDisabled && typeof window !== "undefined" && !window.RTCPeerConnection && !(window as unknown as { webkitRTCPeerConnection?: unknown }).webkitRTCPeerConnection) {
    const sample = signals.find((signal) => signal.id === "webrtcLeak");
    if (sample) Object.assign(sample, { value: locale.startsWith("zh") ? "WebRTC 已屏蔽（浏览器接口）" : "WebRTC blocked at browser interface", assessment: "ok", score: 0, contribution: 0 });
  }
  for (const signal of signals) if (policyAffectsSignal(activePolicy, signal.id)) {
    signal.cloaked = true;
    signal.detail = `${signal.detail ?? ""} ${locale.startsWith("zh") ? "本次采样来自已启用接口屏蔽的当前浏览器；不代表 Claude 桌面端也已接入，桌面端以执行报告为准。" : "Sampled from the current browser with interface protection enabled. Desktop coverage requires its own execution report."}`;
  }
  const testedAt = new Date().toISOString();
  for (const signal of signals) if (getSignalConfig(signal.id)?.environment !== "claude") {
    signal.testedAt = testedAt;
    if (signal.assessment === "unknown" && !signal.observation) signal.observation = signal.value === notMeasured ? "unavailable" : "inconclusive";
  }
  const linked = signalId?.startsWith("webrtc") ? signals.filter((sample) => sample.id.startsWith("webrtc")).map((sample) => sample.id) : signalId && ["language", "languageVariant"].includes(signalId) ? ["language", "languageVariant"] : signalId && ["timezone", "timezoneOffset"].includes(signalId) ? ["timezone", "timezoneOffset"] : [signalId];
  return { signals: signalId ? signals.filter((signal) => linked.includes(signal.id)) : signals, snapshot, webrtc, ipIntel, reachability };
}

// 浏览器侧能否独立判定该项（用于对比视图区分“未测得”与“确实一致”）。
export function browserMeasurable(id: string) {
  return getSignalConfig(id)?.environment !== "claude";
}

export { rules };
