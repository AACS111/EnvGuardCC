// EnvGuardCC 的浏览器检测核心工具，用于采集环境信号、生成展示数据并计算前端风险结果。
import * as rules from "./signal-rules";
import { evaluateAccess } from "./scoring";
import { detectionConfig, getSignalConfig, getSignalWeight, type DetectionConfig } from "./config";
import type { DetectorLocaleText, TargetRegion } from "./locale";
import type { RegionCode, SignalResult } from "./types";

export type SignalView = SignalResult & { state?: "pending" | "running" | "done" };
export type BrowserIpIntel = { ip: string | null; location: string | null; country: string | null; asn: string | null; org: string | null };

// WebRTC 实测结果：仅收集候选地址，不发起任何媒体流或连接。
export type WebrtcProbe = {
  supported: boolean;
  candidates: number;
  publicIps: string[];
  hostCount: number;
  srflxCount: number;
  mdnsCount: number;
  error: string | null;
};

export type BrowserEnvironmentSnapshot = {
  languages: string[];
  timezone: string | null;
  locale: string | null;
  userAgent: string;
  platform?: string;
  brands: string;
  hardwareConcurrency: number;
  deviceMemory: number | null;
  screen: string | null;
  colorDepth: number | null;
  touchPoints: number;
};

export const regions: Array<{ code: TargetRegion }> = [{ code: "auto" }, { code: "cn" }, { code: "hk" }, { code: "ru" }];

export function normalizeRegion(code: TargetRegion): RegionCode {
  return code === "hk" ? "auto" : code;
}

export const scanSteps = detectionConfig.steps;

// 浏览器侧可实测的信号（Claude 网关侧信号由 gateway-check 提供）。
export const defaultSignals: SignalView[] = Object.entries(detectionConfig.signals)
  .filter(([, config]) => config.enabled && config.environment !== "claude" && (config.source === "browser" || config.source === "server"))
  .sort(([, a], [, b]) => a.order - b.order)
  .map(([id, config]) => ({ id, label: config.labelKey, value: null, score: 0, weight: config.weight, contribution: 0, source: config.source }));

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function animateProgress(from: number, to: number, setProgress: (value: number) => void, setActiveSignal: (value: number) => void) {
  const frames = 4;
  for (let i = 1; i <= frames; i += 1) {
    const value = Math.round(from + ((to - from) * i) / frames);
    setProgress(value);
    setActiveSignal(Math.min(defaultSignals.length - 1, Math.floor((value / 100) * defaultSignals.length)));
    await sleep(22);
  }
}

export function makeSignal(id: string, label: string, value: string | null, fallbackWeight: number, matched: boolean, text: DetectorLocaleText, config: DetectionConfig): SignalResult {
  return makeSignalScore(id, label, value, fallbackWeight, matched ? 1 : 0, text, config);
}

export function makeSignalScore(id: string, label: string, value: string | null, fallbackWeight: number, score: number, text: DetectorLocaleText, config: DetectionConfig): SignalResult {
  const normalized = Math.max(0, Math.min(1, score));
  const weight = getSignalWeight(id, fallbackWeight, config);
  return { id, label, value: value || text.unknown, score: normalized, weight, contribution: Math.round(normalized * weight), assessment: !value || !Number.isFinite(normalized) ? "unknown" : normalized > 0 ? "warning" : "ok", source: getSignalConfig(id, config)?.source ?? "browser" };
}

function hasFont(font: string) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const sample = "\u4e2d\u6587\u5b57\u4f53\u68c0\u6d4bABCabc012";
  return ["monospace", "sans-serif", "serif"].some((base) => {
    ctx.font = `72px ${base}`;
    const baseWidth = ctx.measureText(sample).width;
    ctx.font = `72px "${font}", ${base}`;
    return Math.abs(ctx.measureText(sample).width - baseWidth) > 0.5;
  });
}

function matchAny(value: string, patterns: string[]) {
  const lower = value.toLowerCase();
  return patterns.find((pattern) => lower.includes(pattern.toLowerCase())) ?? null;
}

export function localizeSignalValue(value: string | null, text: DetectorLocaleText) {
  if (!value) return value;
  return text.valueMap[value] ?? value;
}

export function detectBrowserName(ua: string, text: DetectorLocaleText) {
  if (/MicroMessenger/i.test(ua)) return text.signalValues.wechatBrowser;
  if (/Edg\//.test(ua)) return "Microsoft Edge";
  if (/OPR\//.test(ua)) return "Opera";
  if (/YaBrowser/i.test(ua)) return "Yandex Browser";
  if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) return "Chrome";
  if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return "Safari";
  if (/Firefox\//.test(ua)) return "Firefox";
  return text.signalValues.unknownBrowser;
}

export function detectOS(ua: string, platform: string | undefined, text: DetectorLocaleText) {
  const probe = `${ua} ${platform ?? ""}`;
  if (/harmonyos/i.test(probe)) return "HarmonyOS";
  if (/android/i.test(probe)) return "Android";
  if (/iphone|ipad|ios/i.test(probe)) return "iOS";
  if (/mac os|macintosh|macintel/i.test(probe)) return "macOS";
  if (/windows nt/i.test(probe)) return "Windows";
  if (/linux/i.test(probe)) return "Linux";
  return platform || text.signalValues.unknownSystem;
}

function detectDeviceName(ua: string, platform: string | undefined, text: DetectorLocaleText) {
  const os = detectOS(ua, platform, text);
  if (/iphone/i.test(ua)) return `iPhone / ${os}`;
  if (/ipad/i.test(ua)) return `iPad / ${os}`;
  if (/android/i.test(ua)) return `${text.signalValues.androidDevice} / ${os}`;
  if (/macintosh|mac os|macintel/i.test(`${ua} ${platform ?? ""}`)) return `Mac / ${os}`;
  if (/windows/i.test(ua)) return `Windows PC / ${os}`;
  if (/linux/i.test(ua)) return `${text.signalValues.linuxDevice} / ${os}`;
  return os;
}

// 设备/系统线索：把“能看到的设备能力”与“系统声明”放在一起，用于识别伪装设备。
function deviceLineage(snapshot: BrowserEnvironmentSnapshot, text: DetectorLocaleText) {
  const os = detectOS(snapshot.userAgent, snapshot.platform, text);
  const cores = snapshot.hardwareConcurrency ? `${snapshot.hardwareConcurrency}${text.signalValues.coreUnit}` : null;
  const memory = snapshot.deviceMemory != null ? `${snapshot.deviceMemory} GB` : null;
  const touch = snapshot.touchPoints ? `${snapshot.touchPoints}${text.signalValues.touchUnit}` : null;
  const gpu = snapshot.colorDepth ? `${snapshot.screen ?? ""} ${snapshot.colorDepth}bit`.trim() : snapshot.screen;
  return [os, cores, memory, gpu, touch].filter(Boolean).join(" / ");
}

export function collectBrowserEnvironment(text: DetectorLocaleText): BrowserEnvironmentSnapshot {
  if (typeof navigator === "undefined") {
    return { languages: [], timezone: null, locale: null, userAgent: "", platform: undefined, brands: text.signalValues.noBrands, hardwareConcurrency: 0, deviceMemory: null, screen: null, colorDepth: null, touchPoints: 0 };
  }
  const nav = navigator as Navigator & { userAgentData?: { platform?: string; brands?: Array<{ brand: string; version: string }> }; deviceMemory?: number };
  return {
    languages: nav.languages?.length ? [...nav.languages] : [nav.language].filter(Boolean),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    locale: Intl.DateTimeFormat().resolvedOptions().locale || null,
    userAgent: nav.userAgent,
    platform: nav.userAgentData?.platform ?? nav.platform,
    brands: nav.userAgentData?.brands?.map((item) => item.brand).filter(Boolean).join(" / ") || text.signalValues.noBrands,
    hardwareConcurrency: nav.hardwareConcurrency ?? 0,
    deviceMemory: typeof nav.deviceMemory === "number" ? nav.deviceMemory : null,
    screen: typeof window === "undefined" ? null : `${window.screen.width}×${window.screen.height}`,
    colorDepth: typeof window === "undefined" ? null : window.screen.colorDepth,
    touchPoints: nav.maxTouchPoints ?? 0,
  };
}

export type BrowserSignalExtras = {
  signalId?: string;
  webrtc?: WebrtcProbe;
};

export function collectBrowserSignals(region: RegionCode, text: DetectorLocaleText, config: DetectionConfig = detectionConfig, snapshot = collectBrowserEnvironment(text), extras: BrowserSignalExtras = {}) {
  const { languages, timezone, locale, userAgent: ua, platform, brands } = snapshot;
  const uaLower = ua.toLowerCase();
  const simplifiedFonts = ["Microsoft YaHei", "Microsoft JhengHei", "PingFang SC", "Hiragino Sans GB", "STHeiti", "STSong", "SimSun", "SimHei", "Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Micro Hei"].filter((font) => (!extras.signalId || extras.signalId === "chineseFonts") && hasFont(font));
  const traditionalFonts = ["PingFang TC", "Heiti TC", "Hiragino Sans CNS", "Noto Sans CJK TC", "Source Han Sans TC", "MingLiU", "PMingLiU"].filter((font) => (!extras.signalId || extras.signalId === "chineseFonts") && hasFont(font));
  const vendorFonts = ["MiSans", "HarmonyOS Sans", "OPPO Sans", "vivo Sans", "Honor Sans", "Alibaba PuHuiTi", "WPS Fangzheng", "FZLanTingHeiS"].filter((font) => (!extras.signalId || extras.signalId === "vendorFonts") && hasFont(font));
  const domesticBrowser = matchAny(`${uaLower} ${brands.toLowerCase()}`, ["micromessenger", "qqbrowser", "mqqbrowser", "quark", "ucbrowser", "ucweb", "baiduboxapp", "baidubrowser", "miuibrowser", "mibrowser", "huaweibrowser", "heytapbrowser", "oppobrowser", "vivobrowser", "360se", "360ee", "qihoobrowser", "sogoumobilebrowser", "2345browser", "lbbrowser"]);
  const domesticDevice = matchAny(`${uaLower} ${platform ?? ""}`, ["harmonyos", "huawei", "honor", "xiaomi", "redmi", "oppo", "vivo", "realme", "oneplus", "miui"]);
  const chineseVariant = languages.some((lang) => /zh-(tw|hk|mo)|zh-hant/i.test(lang)) ? text.signalValues.traditionalChinese : languages.some((lang) => /zh-cn|zh-sg|zh-hans|zh/i.test(lang)) ? text.signalValues.simplifiedChinese : null;
  const offset = -new Date().getTimezoneOffset() / 60;
  const emojiStyle = /iphone|ipad|mac os/i.test(ua) ? text.signalValues.appleEmoji : /android|harmonyos/i.test(ua) ? text.signalValues.androidEmoji : /windows/i.test(ua) ? text.signalValues.windowsEmoji : text.signalValues.unknownEmoji;
  const label = text.signalLabels;
  const value = text.signalValues;
  const os = detectOS(ua, platform, text);
  const browserName = detectBrowserName(ua, text);
  const webrtc = extras.webrtc ?? { supported: false, candidates: 0, publicIps: [], hostCount: 0, srflxCount: 0, mdnsCount: 0, error: null };

  return {
    ...evaluateAccess({ region, languages, timezone, locale, userAgent: ua, source: "browser" }),
    signals: [
      makeSignalScore("timezone", label.timezone, timezone, 26, rules.timezoneScore(timezone ?? ""), text, config),
      makeSignalScore("language", label.language, languages.join(", "), 5, rules.languageScore(languages), text, config),
      makeSignal("languageVariant", label.languageVariant, chineseVariant || value.noLanguageVariant, 12, Boolean(chineseVariant), text, config),
      makeSignalScore("chineseFonts", label.chineseFonts, simplifiedFonts.length ? `${value.scFonts}：${simplifiedFonts.join(" / ")}` : traditionalFonts.length ? `${value.tcFonts}：${traditionalFonts.join(" / ")}` : value.noFonts, 16, rules.fontScore(simplifiedFonts.length, traditionalFonts.length), text, config),
      makeSignalScore("vendorFonts", label.vendorFonts, vendorFonts.length ? `${value.vendorFontsFound}：${vendorFonts.join(" / ")}` : value.noVendorFonts, 0, rules.vendorFontScore(vendorFonts.length), text, config),
      makeSignal("domesticBrowser", label.domesticBrowser, domesticBrowser ? `${value.domesticBrowserFound}：${domesticBrowser}` : value.noDomesticBrowser, 0, Boolean(domesticBrowser), text, config),
      makeSignal("domesticDevice", label.domesticDevice, domesticDevice ? `${value.domesticDeviceFound}：${domesticDevice}` : value.noDomesticDevice, 0, Boolean(domesticDevice), text, config),
      makeSignalScore("locale", label.locale, locale, 4, rules.localeScore(locale ?? ""), text, config),
      makeSignalScore("timezoneOffset", label.timezoneOffset, `UTC${offset >= 0 ? "+" : ""}${offset}`, 3, rules.offsetScore(offset), text, config),
      makeSignalScore("emojiStyle", label.emojiStyle, emojiStyle, 2, rules.emojiScore(ua), text, config),
      makeSignal("browser", label.browser, browserName, 0, false, text, config),
      makeSignal("os", label.os, os, 0, false, text, config),
      makeSignal("device", label.device, detectDeviceName(ua, platform, text), 0, false, text, config),
      makeSignal("deviceLineage", label.deviceLineage, deviceLineage(snapshot, text), 0, false, text, config),
      makeSignal("gatewayProfile", label.gatewayProfile, `${browserName} / ${os}`, 0, false, text, config),
      makeSignal("webrtcSupport", label.webrtcSupport, webrtc.supported ? value.webrtcSupported : value.webrtcUnsupported, 0, false, text, config),
      makeSignal("webrtcCandidates", label.webrtcCandidates, webrtc.supported ? `${webrtc.candidates} ${value.candidateUnit}` : value.notMeasured, 0, false, text, config),
      makeSignalScore("webrtcLeak", label.webrtcLeak, webrtc.publicIps.length ? `${value.webrtcLeakFound}：${webrtc.publicIps.length}` : value.webrtcNoLeak, 19, rules.webrtcLeakScore(webrtc.publicIps.length), text, config),
      makeSignal("webrtcLeakCount", label.webrtcLeakCount, String(webrtc.publicIps.length), 0, false, text, config),
      makeSignal("webrtcFirstIp", label.webrtcFirstIp, webrtc.publicIps[0] ?? value.notMeasured, 0, false, text, config),
      makeSignal("webrtcRegion", label.webrtcRegion, webrtc.publicIps.length ? value.webrtcRegionUnknown : value.notMeasured, 0, false, text, config),
      makeSignal("webrtcConsistency", label.webrtcConsistency, value.cannotDetermine, 0, false, text, config),
    ].filter((signal) => getSignalConfig(signal.id, config)?.enabled !== false),
  };
}

export function isPublicIp(ip: string) {
  if (ip.includes(":")) return !/^(::1|fc|fd|fe80:)/i.test(ip);
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false;
  const [a, b] = parts;
  return !(a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0);
}

// 总分 = 所有命中项加分之�和，封顶 100；浏览器侧与 Claude 侧同一项只取一次更高分。
export function signalsScore(...groups: SignalResult[][]) {
  const scoreMap = new Map<string, number>();
  for (const signals of groups) {
    for (const signal of signals) {
      if (!signal || !(signal.contribution > 0)) continue;
      const current = scoreMap.get(signal.id) ?? 0;
      if (signal.contribution > current) scoreMap.set(signal.id, signal.contribution);
    }
  }
  return Array.from(scoreMap.values()).reduce((sum, value) => sum + value, 0);
}
