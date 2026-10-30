import { detectionConfig } from "./config";
import type { SignalResult } from "./types";
import type { LocaleCode } from "@/i18n/messages";

// 范围与处理能力来自本项目实际采集/转发链路，不推断官方私有风控规则。
const gatewayFields = new Set(["language", "languageVariant", "locale"]);
const networkFields = new Set(["country", "claudeReachability", "dnsReview", "dnsConsistency", "exitType", "multiSourceConsistency", "ipCountryRisk", "claudeAccessRisk"]);

export const simulationSignalIds = ["language", "languageVariant", "locale", "requestHeaders", "httpLanguage", "secFetch", "clientHints", "deviceLineage", "claudeTrigger", "claudeLatency"];
export function signalTestKind(id: string) { return simulationSignalIds.includes(id) ? "simulation" : "native"; }

export function signalPolicy(id: string) {
  const scope = detectionConfig.signals[id]?.environment ?? "claude";
  const treatment = scope === "browser" ? "browser" : gatewayFields.has(id) ? "gateway" : networkFields.has(id) ? "network" : "observe";
  return { scope, treatment } as const;
}

export function signalPolicyCopy(id: string, locale: LocaleCode) {
  const policy = signalPolicy(id);
  const zh = locale.startsWith("zh");
  const scopes = zh ? { browser: "仅浏览器", both: "浏览器与客户端", claude: "仅客户端" } : { browser: "Browser only", both: "Browser + client", claude: "Client only" };
  const treatments = zh ? { browser: "浏览器设置", gateway: "网关语言 / 区域对齐", network: "需配置网络出口", observe: "客户端 / 网络采样" } : { browser: "Browser settings", gateway: "Gateway language / locale", network: "Configure network egress", observe: "Client / network observation" };
  return { ...policy, scopeLabel: scopes[policy.scope], treatmentLabel: treatments[policy.treatment] };
}

export function clientCoverage(signals: SignalResult[]) {
  const client = signals.filter((signal) => signalPolicy(signal.id).scope !== "browser");
  const risks = client.filter((signal) => signal.contribution > 0);
  const unknown = client.filter((signal) => signal.assessment === "unknown" || signal.assessment === "error" && signal.contribution === 0);
  const pending = unknown.filter((signal) => !signal.testedAt && signal.assessment !== "error");
  const limited = unknown.filter((signal) => signal.testedAt && signal.assessment !== "error");
  const failed = client.filter((signal) => signal.assessment === "error" && (signal.contribution === 0 || /Reachability$|^dns/.test(signal.id)));
  return { total: client.length, measured: client.length - unknown.length, risks, unknown, pending, limited, failed };
}
