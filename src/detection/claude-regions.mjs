// Claude 支持地区（Anthropic 官方 Supported Regions Policy）。
//
// 用途：环境防护启动/复检时，固定出口必须落在已列出的国家或地区；否则说明用户
// 正在把一个不支持地区的出口带给 Claude，继续使用会有账号风控风险。这里直接拒绝，
// 而不是等到 Claude 侧封禁才暴露。
//
// 清单来源：https://www.anthropic.com/legal/supported-regions
// 抓取日期：2026-11-07（页面标注 Effective 2026-11-12）。政策会调整，更新时请重新
// 抓取并把上面的日期一起改掉；测试会校验清单里没有明显不该出现的国家。
export const CLAUDE_SUPPORTED_REGIONS_URL = "https://www.anthropic.com/legal/supported-regions";
export const CLAUDE_SUPPORTED_REGIONS_RETRIEVED_AT = "2026-11-07";

// ISO 3166-1 alpha-2。按官方页面的国家/地区名顺序生成，去掉了已废弃代码。
export const CLAUDE_SUPPORTED_REGION_CODES = Object.freeze([
  "AD", "AE", "AG", "AL", "AM", "AO", "AR", "AT", "AU", "AZ",
  "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BN",
  "BO", "BR", "BS", "BT", "BW", "BZ", "CA", "CD", "CF", "CG",
  "CH", "CI", "CL", "CM", "CO", "CR", "CV", "CY", "CZ", "DE",
  "DJ", "DK", "DM", "DO", "DZ", "EC", "EE", "EG", "ER", "ES",
  "ET", "FI", "FJ", "FM", "FR", "GA", "GB", "GD", "GE", "GH",
  "GM", "GN", "GQ", "GR", "GT", "GW", "GY", "HN", "HR", "HT",
  "HU", "ID", "IE", "IL", "IN", "IQ", "IS", "IT", "JM", "JO",
  "JP", "KE", "KG", "KH", "KI", "KM", "KN", "KR", "KW", "KZ",
  "LA", "LB", "LC", "LI", "LK", "LR", "LS", "LT", "LU", "LV",
  "LY", "MA", "MC", "MD", "ME", "MG", "MH", "MK", "ML", "MN",
  "MR", "MT", "MU", "MV", "MW", "MX", "MY", "MZ", "NA", "NE",
  "NG", "NI", "NL", "NO", "NP", "NR", "NZ", "OM", "PA", "PE",
  "PG", "PH", "PK", "PL", "PS", "PT", "PW", "PY", "QA", "RO",
  "RS", "RW", "SA", "SB", "SC", "SD", "SE", "SG", "SI", "SK",
  "SL", "SM", "SN", "SO", "SR", "SS", "ST", "SV", "SZ", "TD",
  "TG", "TH", "TJ", "TL", "TM", "TN", "TO", "TR", "TT", "TV",
  "TW", "TZ", "UA", "UG", "US", "UY", "UZ", "VA", "VC", "VN",
  "VU", "WS", "ZA", "ZM", "ZW",
]);

const SUPPORTED = new Set(CLAUDE_SUPPORTED_REGION_CODES);

/** 统一成大写两字母代码；无法识别时返回 null（不要猜）。 */
export function normalizeCountryCode(value) {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/**
 * supported   = 官方清单内，可以继续启动环境防护；
 * unsupported = 官方清单外，必须拒绝，避免把账号带到封禁地区；
 * unknown     = 拿不到有效代码，由调用方决定（探测本身要求 countryCode，通常到不了这里）。
 */
export function claudeRegionSupport(countryCode) {
  const code = normalizeCountryCode(countryCode);
  if (!code) return "unknown";
  return SUPPORTED.has(code) ? "supported" : "unsupported";
}

/**
 * 固定出口的地区校验。返回归一化后的代码；不支持时抛出可操作的错误，
 * 调用方（环境防护 detect）会把它原样展示给用户。
 */
export function assertClaudeSupportedExit(primary, { source = CLAUDE_SUPPORTED_REGIONS_URL } = {}) {
  const code = normalizeCountryCode(primary?.countryCode);
  if (!code) throw new Error(`固定出口缺少可识别的国家/地区代码，无法确认 Claude 是否支持该地区；已拒绝启动环境防护。`);
  if (!SUPPORTED.has(code)) {
    const where = primary?.ip ? `（${primary.ip}）` : "";
    throw new Error(`固定出口位于 Claude 不支持的地区：${code}${where}。请切换到支持地区的节点后再启动环境防护。支持地区清单：${source}`);
  }
  return code;
}
