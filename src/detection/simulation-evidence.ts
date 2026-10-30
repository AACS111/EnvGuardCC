import type { CloakState } from "./gateway-check";
import type { SimulationJob } from "./simulation";
import type { SignalResult } from "./types";
import { languageScore, variantScore, localeScore } from "./signal-rules";
import type { LocaleCode } from "@/i18n/messages";
import { signalTestKind } from "./signal-policy";

export function nativeClientSignals(signals: SignalResult[], configurationMatches: boolean) {
  return signals.map((signal) => signal.sampleKind === "simulation" || !configurationMatches && signalTestKind(signal.id) === "simulation"
    ? { ...signal, value: null, originalValue: undefined, testedAt: undefined, settingValue: undefined, observation: undefined, score: 0, contribution: 0, cloaked: false, sampleKind: undefined, assessment: "unknown" as const }
    : signal);
}

export function currentSimulation(job: SimulationJob | null, live: CloakState | null, error = "") {
  return !error && live?.enabled && job?.profileUpdatedAt === live.target?.updatedAt && job?.cloakUpdatedAt === live.updatedAt ? job : null;
}

export function simulationSignals(signals: SignalResult[], job: SimulationJob | null, live: CloakState | null, locale: LocaleCode) {
  const current = currentSimulation(job, live);
  const probe = current?.messageProbe;
  if (!current || current.running || current.state === "stale" || current.state === "idle" || !probe?.viaLiveGateway || probe.status !== 200 || !probe.bodyUnchanged || current.signalResults.language?.state !== "passed" || probe.receivedLocale !== current.target?.locale) return signals;
  const languages = probe.receivedLanguage.split(",").map((entry) => entry.trim().split(";")[0]);
  if (languages[0] !== (current.target?.language === "en" ? "en-US" : current.target?.language)) return signals;
  const values: Record<string, [string, number, boolean]> = {
    language: [probe.receivedLanguage, languageScore(languages), probe.sentLanguage !== probe.receivedLanguage],
    languageVariant: [probe.receivedLanguage, variantScore(languages), probe.sentLanguage !== probe.receivedLanguage],
    locale: [probe.receivedLocale, localeScore(probe.receivedLocale), probe.sentLocale !== probe.receivedLocale],
  };
  if (probe.headersIntegrity && probe.receivedHeaders) {
    const headers = probe.receivedHeaders;
    const absent = locale.startsWith("zh") ? "未发送（原生 API 消息）" : "Not sent (native API message)";
    Object.assign(values, {
      httpLanguage: [probe.receivedLanguage, 0, probe.sentLanguage !== probe.receivedLanguage],
      requestHeaders: [Object.keys(headers).join(" · "), 0, false],
      secFetch: [[headers["sec-fetch-site"], headers["sec-fetch-mode"], headers["sec-fetch-dest"]].filter(Boolean).join(" / ") || absent, 0, false],
      clientHints: [headers["sec-ch-ua"] || headers["sec-ch-ua-platform"] || absent, 0, false],
      deviceLineage: [[locale.startsWith("zh") ? "模拟客户端" : "Simulated client", headers["x-stainless-os"], headers["x-stainless-runtime"], headers["x-stainless-arch"]].filter(Boolean).join(" · "), 0, false],
      claudeTrigger: [`${locale.startsWith("zh") ? "模拟消息已接收" : "Simulated message received"} · HTTP ${probe.status}`, 0, false],
      claudeLatency: [`${probe.elapsedMs ?? 0} ms`, 0, false],
    });
  }
  return signals.map((signal) => {
    const observation = values[signal.id];
    const headerRule = ["language", "languageVariant", "locale"].includes(signal.id);
    if (!observation || headerRule && current.signalResults[signal.id]?.state !== "passed") return signal;
    const [value, score, cloaked] = observation;
    const originalValue = signal.id === "locale" ? probe.sentLocale : ["language", "languageVariant", "httpLanguage"].includes(signal.id) ? probe.sentLanguage : undefined;
    return { ...signal, value, originalValue, testedAt: new Date().toISOString(), settingValue: undefined, observation: undefined, score, contribution: Math.round(score * signal.weight), assessment: score > 0 ? "warning" as const : "ok" as const, cloaked, sampleKind: "simulation" as const,
      detail: locale.startsWith("zh") ? "本地模拟消息经网关发送，接收端已核对语言头、区域头和消息正文。分数按接收到的值计算。" : "A local message passed through the gateway; the receiver checked headers and unchanged body. Points use received values." };
  });
}
