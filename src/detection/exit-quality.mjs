// 出口 IP 类型：Claude 的地区判断不只看国家，还会看 ASN/机房属性。
// 腾讯云/AWS 等 hosting IP 即使 GeoIP 国家正确，也可能被 Claude 拒绝登录。
// 这里只做“提示/警告”，不直接禁止启动：部分账号/节点仍可能可用，最终以 Claude 实际响应为准。
export const HOSTING_ASNS = new Set([
  132203, // Tencent
  45102, 45103, // Alibaba Cloud
  16509, 14618, // Amazon / AWS
  15169, 396982, // Google / Google Cloud
  8075, // Microsoft / Azure
  31898, // Oracle Cloud
  16276, // OVH
  14061, // DigitalOcean
  20473, // Vultr
  24940, // Hetzner
  63949, // Linode / Akamai
  13335, // Cloudflare
  136907, // Huawei Cloud
  135377, // UCloud
  60068, // Datacamp
  51167, // Contabo
  9009, // M247
]);

const HOSTING_PATTERNS = [
  /tencent/i, /alibaba|aliyun/i, /\baws\b|amazon/i, /\bgoogle\b/i, /microsoft|azure/i,
  /oracle/i, /\bovh\b/i, /digitalocean/i, /linode|akamai/i, /vultr/i, /hetzner/i,
  /huawei/i, /\bucloud\b/i, /cloudflare/i, /hostinger/i, /contabo/i, /racknerd/i,
  /bandwagon|bwh/i, /colocation|data ?cent(?:er|re)|hosting|vps/i,
];

/** 只看情报字段，不猜；字段缺失时返回 false，避免把住宅 IP 误报成机房。 */
export function isHostingExit(info = {}) {
  const asn = Number(info.asn);
  if (Number.isInteger(asn) && HOSTING_ASNS.has(asn)) return true;
  const text = [info.org, info.isp, info.domain, info.asnOrg].filter((value) => typeof value === "string" && value).join(" ");
  if (!text) return false;
  return HOSTING_PATTERNS.some((pattern) => pattern.test(text));
}

/** 给界面显示用的简短描述，例如 "Shenzhen Tencent Computer Systems…（AS132203）"。 */
export function describeExit(info = {}) {
  const org = [info.org, info.isp, info.domain].find((value) => typeof value === "string" && value) ?? "";
  const asn = info.asn ? `AS${info.asn}` : "";
  if (org && asn) return `${org}（${asn}）`;
  return org || asn;
}
