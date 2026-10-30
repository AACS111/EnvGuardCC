// EnvGuardCC 的出口地区识别模块，用于读取真实出口 IP 情报并推导与其一致的时区、系统时区、语言和区域目标。
import { COUNTRY_LANGUAGES, COUNTRY_TIMEZONES, WINDOWS_ZONES, FALLBACK_COUNTRY_NAMES as COUNTRY_NAMES } from "./region-data";
import type { LocaleCode } from "@/i18n/messages";

export type ExitGeo = {
  ip: string | null;
  countryCode: string | null;
  countryName: string;
  city: string | null;
  cityRaw: string | null;
  regionName: string | null;
  timezone: string | null;
  asn: string | null;
  org: string | null;
  source: string;
};

export type ExitTarget = {
  countryCode: string | null;
  countryName: string;
  city: string | null;
  timezone: string | null;
  windowsTimezone: string | null;
  language: string | null;
  locale: string | null;
};

// 出口国家/地区 -> 首选语言标签。用于在语言、Intl 区域设置中把“与出口一致”的选项排到最前。


// 常见 VPN / 云节点城市的中文名，用于把英文城市名显示为“首尔”这样的本地化名称。
const CITY_NAMES: Record<string, string> = {
  seoul: "首尔", busan: "釜山", incheon: "仁川", tokyo: "东京", osaka: "大阪", nagoya: "名古屋", fukuoka: "福冈",
  singapore: "新加坡", "hong kong": "香港", kowloon: "九龙", taipei: "台北", kaohsiung: "高雄", macau: "澳门", macao: "澳门",
  beijing: "北京", shanghai: "上海", shenzhen: "深圳", guangzhou: "广州", hangzhou: "杭州", chengdu: "成都", nanjing: "南京",
  wuhan: "武汉", chongqing: "重庆", tianjin: "天津", qingdao: "青岛", suzhou: "苏州", xiamen: "厦门", changsha: "长沙",
  zhengzhou: "郑州", dalian: "大连", shenyang: "沈阳", harbin: "哈尔滨", kunming: "昆明", fuzhou: "福州", xian: "西安",
  "xi'an": "西安", bangkok: "曼谷", "kuala lumpur": "吉隆坡", jakarta: "雅加达", manila: "马尼拉", hanoi: "河内",
  "ho chi minh city": "胡志明市", mumbai: "孟买", "new delhi": "新德里", delhi: "德里", bengaluru: "班加罗尔",
  dubai: "迪拜", "abu dhabi": "阿布扎比", "tel aviv": "特拉维夫", istanbul: "伊斯坦布尔", moscow: "莫斯科",
  "saint petersburg": "圣彼得堡", "st petersburg": "圣彼得堡", novosibirsk: "新西伯利亚", warsaw: "华沙", berlin: "柏林",
  frankfurt: "法兰克福", "frankfurt am main": "法兰克福", munich: "慕尼黑", amsterdam: "阿姆斯特丹", paris: "巴黎",
  london: "伦敦", dublin: "都柏林", madrid: "马德里", barcelona: "巴塞罗那", rome: "罗马", milan: "米兰",
  zurich: "苏黎世", geneva: "日内瓦", vienna: "维也纳", stockholm: "斯德哥尔摩", oslo: "奥斯陆", helsinki: "赫尔辛基",
  copenhagen: "哥本哈根", kyiv: "基辅", kiev: "基辅", lisbon: "里斯本", prague: "布拉格", budapest: "布达佩斯",
  "los angeles": "洛杉矶", "san francisco": "旧金山", "san jose": "圣何塞", seattle: "西雅图", "silicon valley": "硅谷",
  "new york": "纽约", chicago: "芝加哥", dallas: "达拉斯", ashburn: "阿什本", miami: "迈阿密", atlanta: "亚特兰大",
  denver: "丹佛", phoenix: "凤凰城", toronto: "多伦多", vancouver: "温哥华", montreal: "蒙特利尔",
  "mexico city": "墨西哥城", "sao paulo": "圣保罗", "buenos aires": "布宜诺斯艾利斯", santiago: "圣地亚哥",
  lima: "利马", bogota: "波哥大", sydney: "悉尼", melbourne: "墨尔本", brisbane: "布里斯班", perth: "珀斯",
  auckland: "奥克兰", cairo: "开罗", johannesburg: "约翰内斯堡", lagos: "拉各斯", tehran: "德黑兰", riyadh: "利雅得",
};

// IANA 时区 -> Windows 时区 ID。本机助手只接受 Windows 已知的时区 ID。


export function windowsTimezoneFor(timezone: string | null | undefined): string | null {
  if (!timezone) return null;
  return WINDOWS_ZONES[timezone] ?? null;
}

// 出口国家缺失时区情报时的兜底时区（COUNTRY_TIMEZONES）与展示名（COUNTRY_NAMES）来自 region-data.ts。
const FALLBACK_COUNTRY_NAMES: Record<string, string> = COUNTRY_NAMES;

function normalizeLocale(locale: LocaleCode) {
  if (locale === "zh-HK") return "zh-Hant";
  if (locale === "ru") return "ru";
  if (locale === "en") return "en";
  return "zh-Hans";
}

export function countryDisplayName(code: string | null, locale: LocaleCode) {
  if (!code) return locale === "ru" ? "неизвестно" : locale.startsWith("zh") ? "未知" : "Unknown";
  try {
    const display = new Intl.DisplayNames([normalizeLocale(locale)], { type: "region" });
    const name = display.of(code.toUpperCase());
    if (name && name !== code) return name;
  } catch {
    // Intl.DisplayNames 在旧浏览器不可用时使用内置对照表。
  }
  return FALLBACK_COUNTRY_NAMES[code.toUpperCase()] ?? code.toUpperCase();
}

export function cityDisplayName(raw: string | null, locale: LocaleCode) {
  if (!raw) return null;
  if (!locale.startsWith("zh")) return raw;
  return CITY_NAMES[raw.trim().toLowerCase()] ?? raw;
}

export function targetLanguageFor(countryCode: string | null) {
  if (!countryCode) return null;
  return COUNTRY_LANGUAGES[countryCode.toUpperCase()]?.[0] ?? null;
}

function str(source: Record<string, unknown>, key: string) {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function obj(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

async function fetchJson(url: string, timeoutMs: number) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
    headers: { Accept: "application/json" },
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data: unknown = await response.json();
  if (!data || typeof data !== "object") throw new Error("Invalid JSON");
  return data as Record<string, unknown>;
}

type Provider = {
  source: string;
  url: string;
  read: (data: Record<string, unknown>) => ExitGeo;
};

function build(source: string, fields: Omit<ExitGeo, "source" | "countryName" | "city">, locale: LocaleCode): ExitGeo {
  const countryCode = fields.countryCode ? fields.countryCode.toUpperCase().slice(0, 2) : null;
  return {
    ...fields,
    countryCode,
    countryName: countryDisplayName(countryCode, locale),
    city: cityDisplayName(fields.cityRaw, locale),
    source,
  };
}

const providers: Provider[] = [
  {
    source: "ipwho.is",
    url: "https://ipwho.is/",
    read: (data) => {
      const connection = obj(data, "connection");
      const timezone = obj(data, "timezone");
      return build("ipwho.is", {
        ip: str(data, "ip"),
        countryCode: str(data, "country_code"),
        cityRaw: str(data, "city"),
        regionName: str(data, "region"),
        timezone: str(timezone, "id"),
        asn: str(connection, "asn") ? `AS${str(connection, "asn")}` : null,
        org: str(connection, "org") ?? str(connection, "isp"),
      }, "en");
    },
  },
  {
    source: "ipapi.co",
    url: "https://ipapi.co/json/",
    read: (data) => build("ipapi.co", {
      ip: str(data, "ip"),
      countryCode: str(data, "country_code") ?? str(data, "country"),
      cityRaw: str(data, "city"),
      regionName: str(data, "region"),
      timezone: str(data, "timezone"),
      asn: str(data, "asn"),
      org: str(data, "org"),
    }, "en"),
  },
  {
    source: "ipinfo.io",
    url: "https://ipinfo.io/json",
    read: (data) => build("ipinfo.io", {
      ip: str(data, "ip"),
      countryCode: str(data, "country"),
      cityRaw: str(data, "city"),
      regionName: str(data, "region"),
      timezone: str(data, "timezone"),
      asn: str(data, "org")?.match(/^AS\d+/)?.[0] ?? null,
      org: str(data, "org"),
    }, "en"),
  },
];

const TIMEZONE_PATTERN = /^[A-Za-z_]+\/[A-Za-z0-9_+\-/]+$/;

function validLocation(geo: ExitGeo) {
  if (!geo.countryCode || !/^[A-Z]{2}$/.test(geo.countryCode)) return false;
  if (geo.timezone && !TIMEZONE_PATTERN.test(geo.timezone)) return false;
  return true;
}

// 依次尝试多个公开 IP 情报接口；任一接口给出有效国家即采用，全部失败时返回 null（界面按未检测处理）。
export async function fetchExitGeo(locale: LocaleCode): Promise<ExitGeo | null> {
  const attempts = providers.map(async (provider) => {
    const geo = provider.read(await fetchJson(provider.url, 4500));
    if (!validLocation(geo)) throw new Error(`${provider.source}: invalid geo`);
    return {
      ...geo,
      countryName: countryDisplayName(geo.countryCode, locale),
      city: cityDisplayName(geo.cityRaw, locale),
    };
  });
  try {
    const geo = await Promise.any(attempts);
    return geo;
  } catch {
    return null;
  }
}

export function buildExitTarget(geo: ExitGeo | null): ExitTarget | null {
  if (!geo || !geo.countryCode) return null;
  const timezone = geo.timezone ?? COUNTRY_TIMEZONES[geo.countryCode] ?? null;
  const language = targetLanguageFor(geo.countryCode);
  return {
    countryCode: geo.countryCode,
    countryName: geo.countryName,
    city: geo.city,
    timezone,
    windowsTimezone: windowsTimezoneFor(timezone),
    language,
    locale: language,
  };
}

export function exitTargetLabel(target: ExitTarget | null) {
  if (!target) return null;
  return target.city ? `${target.countryName} · ${target.city}` : target.countryName;
}
