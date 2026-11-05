// 公共 DNS 必须与出口地区对齐。
//
// 1.1.1.1 / 8.8.8.8 是 Cloudflare / Google 的全球 anycast，同一个地址在不同 GeoIP 库里
// 标注互相矛盾（实测：出口在首尔，`o-o.myaddr.l.google.com` 回报的解析器却被标成日本），
// 「解析器国家 ≠ 出口国家」本身就是一条自相矛盾的指纹。
//
// 选解析器的顺序：
//   1. 节点名里带地区（订阅普遍如此，如 "Hong Kong 01" / "首尔-Reality-443"）；
//   2. 名字认不出 → 用节点服务器 IP 实测国别（probe），结果按 IP 缓存；
//   3. 都认不出 → 退回 anycast DoH（宁可退让，也不用错国家的解析器）。
//
// 表里只收录**已核对过归属国**的非 anycast 解析器（用 ip-api 批量核过国家码）。

export const ANYCAST_DOH = ["https://1.1.1.1/dns-query", "https://8.8.8.8/dns-query"];

// ISO 国别码 → 该国 ISP/国家级解析器。
export const REGION_SERVERS = {
  KR: ["168.126.63.1", "168.126.63.2", "164.124.101.2"], // KT / LG U+
  JP: ["133.11.0.1", "203.141.128.1"], // 东京大学 / NTT PC
  HK: ["203.80.96.9", "203.80.96.10", "205.252.144.228"], // HKBN / PCCW
  SG: ["165.21.83.88", "165.21.100.88"], // SingNet
  TW: ["168.95.1.1", "168.95.192.1"], // HiNet
  US: ["4.2.2.1", "4.2.2.2"], // Level 3
  IN: ["202.56.250.5"], // Bharti Airtel
  IT: ["212.216.112.112", "151.99.125.1"], // Telecom Italia
  MX: ["200.94.180.1"], // NIC México
  MY: ["1.9.1.9", "202.188.0.133"], // TM
  BR: ["200.160.2.3", "200.160.2.4"], // NIC.br
  AU: ["203.12.160.35"], // TPG
  TH: ["203.146.44.2"], // CS Loxinfo
};

// 节点名里可能出现的地区写法（中文全称优先，避免 "hk" 之类短码误匹配）。
const REGION_WORDS = {
  KR: ["首尔", "首爾", "韩国", "韓國", "seoul", "korea"],
  JP: ["日本", "东京", "東京", "大阪", "japan", "tokyo", "osaka"],
  HK: ["香港", "hong kong", "hongkong"],
  SG: ["新加坡", "singapore"],
  TW: ["台湾", "台灣", "台北", "新北", "taipei", "taiwan"],
  US: ["美国", "美國", "洛杉矶", "圣何塞", "西雅图", "纽约", "united states", "los angeles", "san jose", "seattle", "new york", "usa"],
  IN: ["印度", "india", "mumbai", "孟买"],
  IT: ["意大利", "italy", "milan", "米兰"],
  MX: ["墨西哥", "mexico", "méxico"],
  MY: ["马来西亚", "馬來西亞", "malaysia", "kuala lumpur"],
  BR: ["巴西", "brazil", "são paulo", "sao paulo", "圣保罗"],
  AU: ["澳大利亚", "澳洲", "australia", "sydney", "悉尼"],
  TH: ["泰国", "泰國", "thailand", "bangkok", "曼谷"],
};

const regionCodes = Object.keys(REGION_SERVERS);

/** 按节点名识别地区，返回 ISO 国别码；认不出返回 null（不猜）。 */
export function regionOfNode(node) {
  const name = `${node?.name ?? ""}`.toLowerCase();
  if (!name) return null;
  for (const code of regionCodes) {
    if ((REGION_WORDS[code] ?? []).some((word) => name.includes(word))) return code;
  }
  // 短国别码只在独立片段里认（"HK-01"、"us 02"），避免 "fushun" 之类误命中。
  const tokens = name.split(/[^a-z]+/).filter(Boolean);
  return regionCodes.find((code) => tokens.includes(code.toLowerCase())) ?? null;
}

/** 按国别码取解析器；未知地区退回 anycast DoH。 */
export function publicDnsForCountry(code) {
  return REGION_SERVERS[String(code ?? "").toUpperCase()] ?? ANYCAST_DOH;
}

// 按节点服务器 IP 缓存实测结果，避免每次重建配置都探一次。
const countryCache = new Map();

/**
 * 选出与出口地区一致的公共 DNS。
 * @param {{node?: {name?: string, server?: string}, probe?: (server: string) => Promise<string|null>}} options
 *   probe 返回节点服务器 IP 的 ISO 国别码（实测），抛错或返回空表示探测失败。
 */
export async function resolvePublicDns({ node, probe } = {}) {
  const byName = regionOfNode(node);
  if (byName) return publicDnsForCountry(byName);
  const server = typeof node?.server === "string" ? node.server.trim() : "";
  if (!server || typeof probe !== "function") return ANYCAST_DOH;
  if (countryCache.has(server)) return publicDnsForCountry(countryCache.get(server));
  try {
    const code = await probe(server);
    if (!code) return ANYCAST_DOH;
    countryCache.set(server, code);
    return publicDnsForCountry(code);
  } catch {
    // 探测失败不缓存：下次重建配置时再试。
    return ANYCAST_DOH;
  }
}

/** 仅供测试：清空实测缓存。 */
export function resetPublicDnsCache() {
  countryCache.clear();
}
