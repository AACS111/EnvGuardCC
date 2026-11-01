import { getSignalWeight } from "./config";
import { windowsTimezoneFor, type ExitTarget } from "./exit-geo";
import type { SignalResult } from "./types";
import * as rules from "./signal-rules";

export type RepairAction = "timezone" | "language" | "locale" | "information";
// target: 与当前出口地区（VPN/IP 位置）一致的选项；other: 其它可比较的选项。
export type RepairMatch = "target" | "other";
export type RepairChoice = {
  id: string;
  value: string;
  label: string;
  contribution: number;
  impacts: Record<string, number>;
  action: RepairAction;
  windowsTimezone?: string;
  match: RepairMatch;
  current?: boolean;
};

const points = (id: string, score: number) => Math.round(score * getSignalWeight(id, 0));

// 按出口目标排序后的候选时区；目标时区缺失时使用这组常见节点。
const ZONES = [
  "Asia/Seoul",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Taipei",
  "Asia/Singapore",
  "Asia/Bangkok",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Europe/Moscow",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Warsaw",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

const LANGUAGES = [["en-US"], ["en-GB"], ["ko-KR"], ["ja-JP"], ["ru-RU"], ["en-US", "zh-CN"], ["zh-HK"], ["zh-CN"]];

const LOCALES = ["en-US", "en-GB", "ko-KR", "ja-JP", "ru-RU", "zh-HK", "zh-CN"];

// Windows 把香港与澳门映射到 China Standard Time，浏览器随后解析为上海时区。
// 因此不使用“香港 0 分”的误导性选项，按实际映射计分。
function effectiveZone(zone: string) {
  return windowsTimezoneFor(zone) === "China Standard Time" && zone !== "Asia/Shanghai" && zone !== "Asia/Urumqi" ? "Asia/Shanghai" : zone;
}

function zoneLabel(zone: string) {
  const offset = rules.timezoneOffset(zone);
  return `${zone} · UTC${offset >= 0 ? "+" : ""}${offset}`;
}

function dedupe<T>(values: T[], key: (value: T) => string) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const id = key(value);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function repairValueMatches(id: string, left: string, right: string) {
  const language = /^(language|languageVariant)$/.test(id);
  const comparable = (value: string) => language ? value.split(",").map((part) => part.trim().split(";")[0].toLowerCase()).join(",") : value.replace(/\s/g, "").toLowerCase();
  if (comparable(left) === comparable(right)) return true;
  if (!language || left.includes(",")) return false;
  const base = left.split("-")[0].toLowerCase();
  const expected = base === "en" ? `${left === "en" ? "en-US" : left},en` : left === base ? `${base},en` : `${left},${base},en`;
  return comparable(expected) === comparable(right);
}

export function repairChoices(signal: Pick<SignalResult, "id" | "value" | "contribution" | "assessment"> & Partial<Pick<SignalResult, "score" | "settingValue">>, target?: ExitTarget | null, platform = "win32"): RepairChoice[] {
  const { id } = signal;
  const choices: RepairChoice[] = [];
  const add = (value: string, label: string, score: number, action: RepairAction = "information", extra: Partial<RepairChoice> = {}) => {
    choices.push({ id: value, value, label, contribution: points(id, score), impacts: { [id]: points(id, score) }, action, match: "other", ...extra });
  };

  if (id === "timezone" || id === "timezoneOffset") {
    const zones = dedupe(
      [...(target?.timezone ? [target.timezone] : []), ...ZONES],
      (zone) => zone,
    );
    for (const zone of zones) {
      const effective = platform === "win32" ? effectiveZone(zone) : zone;
      const impacts = { timezone: points("timezone", rules.timezoneScore(effective)), timezoneOffset: points("timezoneOffset", rules.offsetScore(rules.timezoneOffset(zone))) };
      add(zone, zoneLabel(zone), 0, "timezone", {
        contribution: impacts[id],
        impacts,
        windowsTimezone: windowsTimezoneFor(zone) ?? undefined,
        match: target?.timezone && zone === target.timezone ? "target" : "other",
      });
    }
  } else if (id === "language" || id === "languageVariant") {
    const values = dedupe(
      [...(target?.language ? [[target.language]] : []), ...LANGUAGES],
      (item) => item.join(", "),
    );
    for (const item of values) {
      const impacts = { language: points("language", rules.languageScore(item)), languageVariant: points("languageVariant", rules.variantScore(item)) };
      add(item.join(", "), item.join(", "), 0, "language", {
        contribution: impacts[id],
        impacts,
        match: target?.language && item.length === 1 && item[0] === target.language ? "target" : "other",
      });
    }
  } else if (id === "locale") {
    const values = dedupe([...(target?.locale ? [target.locale] : []), ...LOCALES], (value) => value);
    for (const value of values) {
      add(value, value, rules.localeScore(value), "locale", {
        match: target?.locale && value === target.locale ? "target" : "other",
      });
    }
  } else if (id === "chineseFonts") {
    for (const [label, sc, tc] of [["No listed fonts / 无名单内字体", 0, 0], ["Traditional only / 仅繁体名单字体", 0, 1], ["1 simplified font / 1 种简体名单字体", 1, 0], ["2 simplified fonts / 2 种简体名单字体", 2, 0], ["3+ simplified fonts / 3 种以上简体名单字体", 3, 0]] as const) add(label, label, rules.fontScore(sc, tc));
  } else if (id === "vendorFonts") {
    for (const count of [0, 1, 2]) add(String(count), `${count === 2 ? "2+" : count} vendor fonts / 厂商名单字体`, rules.vendorFontScore(count));
  } else if (id === "emojiStyle") {
    // Unknown UA is not a real setting and is deliberately excluded as a zero-point "fix".
    for (const value of ["macOS / iOS", "Windows", "Android"]) add(value, value, rules.emojiScore(value === "macOS / iOS" ? "Mac OS" : value));
  } else if (id === "domesticBrowser") {
    add("Chrome / Edge / Firefox / Safari", "Chrome / Edge / Firefox / Safari", 0);
    add("Matched browser brand / 命中品牌名单", "Matched browser brand / 命中品牌名单", 1);
  } else if (id === "domesticDevice") {
    for (const value of ["Other / 其他真实设备", "huawei", "harmonyos"]) add(value, value, rules.deviceScore(value.startsWith("Other") ? null : value));
  } else if (id === "country" || id === "ipCountryRisk" || id === "claudeAccessRisk") {
    // 出口国家属于网络路径设置，网页不能改写；这里只比较“真实目标国出口”与“当前出口”的规则分。
    const targetCountry = id === "country" ? target?.countryName : null;
    if (targetCountry) add(targetCountry, targetCountry + " · 与出口情报一致", 0, "information", { match: "target" });
    for (const country of ["未命中高风险国家名单 / outside risk list", "中国大陆 / Mainland China", "俄罗斯 / Russia", "伊朗 / Iran"]) add(country, country, /未命中|outside/.test(country) ? 0 : 1);
  } else if (id === "exitType") {
    for (const value of ["住宅 / 其它网络 / Residential or other network", "数据中心 / 云厂商 / Datacenter or cloud"]) add(value, value, /数据中心/.test(value) ? 1 : 0);
  } else if (id === "webrtcLeak") {
    for (const value of ["未发现公网候选地址 / No public candidates", "禁用 WebRTC / WebRTC disabled", "检测到公网候选地址 / Public candidates found"]) add(value, value, /检测到/.test(value) ? 1 : 0);
  } else if (id === "dnsMode" || id === "dnsReview") {
    for (const value of ["代理解析 / Proxy resolution", "系统 DNS / System DNS"]) add(value, value, 0);
  } else if (id === "dnsConsistency") {
    add("DNS 参考答案交叉核对通过 / DNS references overlap", "DNS 参考答案交叉核对通过 / DNS references overlap", 0);
  } else if (id === "multiSourceConsistency" || id === "proxyCountry") {
    for (const value of ["多源一致 / consistent sources", "实际已分流 / traffic actually split"]) add(value, value, /分流/.test(value) ? 1 : 0);
  } else if (id === "claudeReachability" || id === "anthropicReachability" || id === "apiReachability") {
    for (const value of ["可达 / reachable", "不可达 / unreachable"]) add(value, value, /不可达|unreachable/.test(value) ? 1 : 0);
  }

  const hasCurrent = Boolean(signal.value && signal.assessment !== "unknown" && signal.assessment !== "not_applicable" && !(signal.assessment === "error" && signal.contribution === 0));
  for (const choice of choices) choice.current = hasCurrent && repairValueMatches(id, choice.value, signal.settingValue ?? signal.value ?? "");
  if (hasCurrent) for (const choice of choices) {
    const actual = signal.value ?? "";
    if (id === "timezone") choice.current = effectiveZone(choice.value) === actual;
    if (id === "timezoneOffset") choice.current = actual === `UTC${rules.timezoneOffset(choice.value) >= 0 ? "+" : ""}${rules.timezoneOffset(choice.value)}`;
    if (id === "webrtcLeak") choice.current = /禁用/.test(choice.value) ? /已屏蔽|blocked|disabled/i.test(actual) : /检测到/.test(choice.value) ? signal.score! > 0 : signal.score === 0 && !/已屏蔽|blocked|disabled/i.test(actual);
    if (id === "exitType") choice.current = /数据中心|Datacenter/i.test(choice.value) ? /机房|数据中心|云厂商|Datacenter|cloud/i.test(actual) : /住宅|家庭|其它网络|Residential|other network/i.test(actual);
    if (id === "domesticBrowser") choice.current = /Matched browser/.test(choice.value) ? signal.score! > 0 : signal.score === 0;
    if (id === "domesticDevice") choice.current = /Other/.test(choice.value) ? signal.score === 0 : actual.toLowerCase().includes(choice.value.toLowerCase());
    if (id === "emojiStyle") choice.current = /Windows/.test(choice.value) ? /Windows/i.test(actual) : /Android/.test(choice.value) ? /Android/i.test(actual) : /Apple|苹果|macOS|iOS/i.test(actual);
    if (id === "dnsMode" || id === "dnsReview") choice.current = /Proxy resolution/.test(choice.value) ? /代理解析|Proxy resolution/.test(actual) : /系统 DNS|系统解析|System DNS|System lookup/.test(actual);
    if (id === "dnsConsistency") choice.current = signal.assessment === "ok" && /交叉核对通过|answer sets overlap/.test(actual);
    if (id === "multiSourceConsistency" || id === "proxyCountry") choice.current = /consistent sources/.test(choice.value) ? signal.assessment === "ok" : signal.assessment === "warning" || signal.assessment === "error";
    if (["claudeReachability", "anthropicReachability", "apiReachability"].includes(id)) choice.current = /unreachable/.test(choice.value) ? signal.assessment === "error" && !/HTTP \d{3}/.test(actual) : /HTTP \d{3}|^\d+\s*ms/.test(actual);
    if (["country", "ipCountryRisk", "claudeAccessRisk"].includes(id) && /outside risk list/.test(choice.value)) choice.current = signal.score === 0;
    if (["country", "ipCountryRisk"].includes(id)) {
      for (const [pattern, codes] of [[/Mainland China/, /中国|China|\bCN\b/i], [/Russia/, /俄罗斯|Russia|\bRU\b/i], [/Iran/, /伊朗|Iran|\bIR\b/i]] as const) if (pattern.test(choice.value)) choice.current = codes.test(actual);
    }
  }
  if (hasCurrent && id === "chineseFonts" && typeof signal.score === "number") {
    const index = signal.score === 0 ? 0 : signal.score === 0.5 ? 1 : signal.score < 0.9 ? 2 : signal.score < 0.98 ? 3 : 4;
    if (choices[index]) choices[index].current = true;
  }
  if (hasCurrent && id === "vendorFonts" && typeof signal.score === "number") {
    const index = signal.score === 0 ? 0 : signal.score < 1 ? 1 : 2;
    if (choices[index]) choices[index].current = true;
  }
  if (hasCurrent && choices.length && !choices.some((choice) => choice.current)) {
    choices.push({ current: true, id: "current", label: signal.value ?? "Current / 当前", value: signal.value ?? "", contribution: signal.contribution, impacts: { [id]: signal.contribution }, action: "information", match: "other" });
  }

  // 与出口地区一致的选项优先；但出口设置本身加分更高时（例：出口在中国大陆），
  // 不能把更高分的选项顶到第一位，此时仍以最低分项在前，目标项保留“与出口一致”标记。
  const lowest = Math.min(...choices.map((choice) => choice.contribution));
  const targetChoice = choices.find((choice) => choice.match === "target");
  const promoteTarget = Boolean(targetChoice && targetChoice.contribution <= lowest);
  return choices.sort((a, b) => {
    if (promoteTarget && (a.match === "target" || b.match === "target")) return a.match === b.match ? a.contribution - b.contribution : a.match === "target" ? -1 : 1;
    return a.contribution - b.contribution;
  });
}

// 一键优化使用的推荐项：优先出口目标，但目标项加分更高时仍取最低分项。
export function recommendedChoice(signal: Pick<SignalResult, "id" | "value" | "contribution">, target?: ExitTarget | null, platform = "win32"): RepairChoice | null {
  const choices = repairChoices(signal, target, platform);
  if (!choices.length) return null;
  const targetChoice = choices.find((choice) => choice.match === "target" && choice.id !== "current");
  if (targetChoice && targetChoice.contribution <= choices[0].contribution) return targetChoice;
  return choices[0];
}

export function previewTotal(signals: Pick<SignalResult, "id" | "contribution">[], choice: RepairChoice) {
  const values = new Map(signals.map((signal) => [signal.id, signal.contribution]));
  for (const [id, contribution] of Object.entries(choice.impacts)) if (values.has(id)) values.set(id, contribution);
  return Math.min(100, Array.from(values.values()).reduce((sum, value) => sum + value, 0));
}
