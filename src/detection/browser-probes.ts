// EnvGuardCC 的浏览器侧实测模块：WebRTC 泄漏探测、出口 IP 多源情报、可达性实测。
// 全部为被动或只读探测：不建立媒体流、不携带凭证、不读取账号内容。
import { isPublicIp } from "./client-engine";
import { countryDisplayName, cityDisplayName } from "./exit-geo";
import type { LocaleCode } from "@/i18n/messages";

// 中国大陆、俄罗斯、伊朗被本项目规则视为高风险出口。
export const RISK_COUNTRIES = ["CN", "RU", "IR", "KP", "SY", "CU"];

export type WebrtcProbe = {
  supported: boolean;
  candidates: number;
  publicIps: string[];
  hostCount: number;
  srflxCount: number;
  mdnsCount: number;
  error: string | null;
};

// 只收集本地候选地址，收集完成后立刻关闭连接；不发送 offer、不交换 SDP。
export function probeWebrtc(timeoutMs = 2800): Promise<WebrtcProbe> {
  const factory = typeof window === "undefined" ? null : (window.RTCPeerConnection ?? (window as unknown as { webkitRTCPeerConnection?: typeof RTCPeerConnection }).webkitRTCPeerConnection);
  if (!factory) return Promise.resolve({ supported: false, candidates: 0, publicIps: [], hostCount: 0, srflxCount: 0, mdnsCount: 0, error: "WEBRTC_UNAVAILABLE" });
  return new Promise((resolve) => {
    const publicIps = new Set<string>();
    let candidates = 0;
    let hostCount = 0;
    let srflxCount = 0;
    let mdnsCount = 0;
    let settled = false;
    let connection: RTCPeerConnection | null = null;
    const finish = (error: string | null) => {
      if (settled) return;
      settled = true;
      try { connection?.close(); } catch { /* 连接已关闭 */ }
      resolve({ supported: true, candidates, publicIps: [...publicIps], hostCount, srflxCount, mdnsCount, error });
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      connection = new factory({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      connection.createDataChannel("checkcc");
      connection.onicecandidate = (event) => {
        const candidate = event.candidate;
        if (!candidate) { clearTimeout(timer); finish(null); return; }
        candidates += 1;
        const text = candidate.candidate;
        if (/ typ host /i.test(text)) hostCount += 1;
        if (/ typ srflx /i.test(text)) srflxCount += 1;
        if (/\.local\b/i.test(text)) mdnsCount += 1;
        // 候选地址形如 "candidate:1 1 udp 2122260223 1.2.3.4 54321 typ srflx ..."
        const parts = text.split(" ");
        const address = parts[4];
        if (address && isPublicIp(address)) publicIps.add(address);
      };
      void connection.createOffer().then((offer) => connection?.setLocalDescription(offer)).catch(() => finish("WEBRTC_OFFER_FAILED"));
    } catch {
      clearTimeout(timer);
      finish("WEBRTC_UNAVAILABLE");
    }
  });
}

export type IpIntelSource = {
  source: string;
  ip: string | null;
  countryCode: string | null;
  countryName: string;
  regionName: string | null;
  city: string | null;
  asn: string | null;
  org: string | null;
  timezone: string | null;
  error: string | null;
};

export type BrowserIpIntelligence = {
  sources: IpIntelSource[];
  okSources: IpIntelSource[];
  primary: IpIntelSource | null;
  ipv4: string | null;
  ipv6: string | null;
  countries: string[];
  consistentCountry: boolean | null;
  datacenter: boolean | null;
  riskCountries: string[];
  checkedAt: string;
};

const DATACENTER_PATTERN = /(cloud|amazon|aws|google|azure|digitalocean|ovh|hetzner|linode|vultr|alibaba|aliyun|tencent|m247|choopa|leaseweb|contabo|oracle|cloudflare|fastly|akamai|hosting|datacenter|server|vpn|proxy)/i;

type Provider = {
  source: string;
  url: string;
  read: (data: Record<string, unknown>, locale: LocaleCode) => IpIntelSource;
};

const text = (data: Record<string, unknown>, key: string) => {
  const value = data[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};
const nested = (data: Record<string, unknown>, key: string): Record<string, unknown> => {
  const value = data[key];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
};

const providers: Provider[] = [
  {
    source: "ipwho.is",
    url: "https://ipwho.is/",
    read: (data, locale) => {
      const connection = nested(data, "connection");
      const timezone = nested(data, "timezone");
      const countryCode = text(data, "country_code")?.toUpperCase().slice(0, 2) ?? null;
      const cityRaw = text(data, "city");
      return {
        source: "ipwho.is", ip: text(data, "ip"), countryCode, countryName: countryDisplayName(countryCode, locale),
        regionName: text(data, "region"), city: cityDisplayName(cityRaw, locale),
        asn: text(connection, "asn") ? `AS${text(connection, "asn")}` : null,
        org: text(connection, "org") ?? text(connection, "isp"), timezone: text(timezone, "id"), error: null,
      };
    },
  },
  {
    source: "ipapi.co",
    url: "https://ipapi.co/json/",
    read: (data, locale) => {
      const countryCode = (text(data, "country_code") ?? text(data, "country"))?.toUpperCase().slice(0, 2) ?? null;
      const cityRaw = text(data, "city");
      return {
        source: "ipapi.co", ip: text(data, "ip"), countryCode, countryName: countryDisplayName(countryCode, locale),
        regionName: text(data, "region"), city: cityDisplayName(cityRaw, locale),
        asn: text(data, "asn"), org: text(data, "org"), timezone: text(data, "timezone"), error: null,
      };
    },
  },
  {
    source: "ipinfo.io",
    url: "https://ipinfo.io/json",
    read: (data, locale) => {
      const countryCode = text(data, "country")?.toUpperCase().slice(0, 2) ?? null;
      const cityRaw = text(data, "city");
      const org = text(data, "org");
      return {
        source: "ipinfo.io", ip: text(data, "ip"), countryCode, countryName: countryDisplayName(countryCode, locale),
        regionName: text(data, "region"), city: cityDisplayName(cityRaw, locale),
        asn: org?.match(/^AS\d+/)?.[0] ?? null, org, timezone: text(data, "timezone"), error: null,
      };
    },
  },
];

async function readProvider(provider: Provider, locale: LocaleCode): Promise<IpIntelSource> {
  try {
    const response = await fetch(provider.url, { cache: "no-store", headers: { Accept: "application/json" }, referrerPolicy: "no-referrer", signal: AbortSignal.timeout(4500) });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const data = (await response.json()) as Record<string, unknown>;
    const source = provider.read(data, locale);
    if (!source.countryCode || !/^[A-Z]{2}$/.test(source.countryCode)) throw new Error("INVALID_GEO");
    return source;
  } catch (error) {
    return { source: provider.source, ip: null, countryCode: null, countryName: "", regionName: null, city: null, asn: null, org: null, timezone: null, error: error instanceof Error ? error.message : "NETWORK_ERROR" };
  }
}

// 浏览器侧多源出口情报：三家源同时读取，便于交叉核对国家一致性与出口类型。
export async function collectBrowserIpIntel(locale: LocaleCode): Promise<BrowserIpIntelligence> {
  const results = await Promise.all(providers.map((provider) => readProvider(provider, locale)));
  const okSources = results.filter((source) => !source.error && source.countryCode);
  const countries = [...new Set(okSources.map((source) => source.countryCode as string))];
  const primary = okSources[0] ?? null;
  const ipv4 = okSources.map((source) => source.ip).find((ip): ip is string => Boolean(ip && isPublicIp(ip) && !ip.includes(":"))) ?? null;
  const ipv6 = okSources.map((source) => source.ip).find((ip): ip is string => Boolean(ip && ip.includes(":"))) ?? null;
  const org = primary?.org ?? null;
  return {
    sources: results, okSources, primary, ipv4, ipv6, countries,
    consistentCountry: countries.length > 1 ? countries.length === 1 : null,
    datacenter: org ? DATACENTER_PATTERN.test(org) : null,
    riskCountries: countries.filter((code) => RISK_COUNTRIES.includes(code)),
    checkedAt: new Date().toISOString(),
  };
}

export type ReachabilityProbe = { status: number | null; elapsedMs: number | null; ok: boolean; error: string | null };

// 浏览器侧可达性：no-cors 只能拿到“网络是否连通 + 耗时”，读不到状态码正文。
async function probeReachability(url: string, timeoutMs = 6000): Promise<ReachabilityProbe> {
  const started = Date.now();
  try {
    const response = await fetch(url, { mode: "no-cors", cache: "no-store", credentials: "omit", redirect: "follow", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(timeoutMs) });
    // Opaque cross-origin responses hide the HTTP status; never invent an HTTP 200.
    const opaque = response.type === "opaque" || response.type === "opaqueredirect";
    return { status: opaque ? null : response.status, elapsedMs: Date.now() - started, ok: true, error: null };
  } catch (error) {
    return { status: null, elapsedMs: Date.now() - started, ok: false, error: error instanceof Error ? error.name : "NETWORK_ERROR" };
  }
}

export type BrowserReachability = {
  claude: ReachabilityProbe;
  anthropic: ReachabilityProbe;
};

export async function collectBrowserReachability(): Promise<BrowserReachability> {
  const [claude, anthropic] = await Promise.all([
    probeReachability("https://claude.ai/"),
    probeReachability("https://www.anthropic.com/"),
  ]);
  return { claude, anthropic };
}
