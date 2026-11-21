// 官网产品标称与匿名历史记录分开保存；不内置用户地址或默认探测目标。
export type ProviderText = { zh: string; en: string };

export type VpsAssessment = {
  checkedAt: string;
  location: ProviderText;
  operator: string;
  asn: number;
  sent: number;
  received: number;
  timeouts: number;
  averageMs: number;
  minMs: number;
  maxMs: number;
};

export type VpsProvider = {
  id: string;
  name: string;
  domain: string;
  website: string;
  summary: ProviderText;
  product: {
    title: ProviderText;
    specs: ProviderText[];
    price: ProviderText;
    source: string;
  };
  assessment: VpsAssessment;
  note: ProviderText;
};

// 2026-11-18 的单次本机 ICMP 短测，不是实时结果或多地测速。
const checkedAt = "2026-11-18T14:03:00Z";

export const VPS_PROVIDERS: VpsProvider[] = [
  {
    id: "lisahost",
    name: "丽萨主机",
    domain: "lisahost.com",
    website: "https://lisahost.com/aff.php?aff=16697",
    summary: {
      zh: "提供多地区 ISP VPS，美国系列可选 9929 优化线路与双 ISP 产品。",
      en: "Multi-region ISP VPS; the US line offers 9929 optimized routing and dual-ISP products.",
    },
    product: {
      title: { zh: "美国 9929 双 ISP 住宅 IP VPS", en: "US 9929 dual-ISP residential-IP VPS" },
      specs: [
        { zh: "1核 / 1GB / 10GB NVMe", en: "1 vCPU / 1GB RAM / 10GB NVMe" },
        { zh: "50Mbps / 1000GB 月流量", en: "50Mbps / 1000GB monthly transfer" },
        { zh: "1 IPv4 / KVM", en: "1 IPv4 / KVM" },
      ],
      price: { zh: "参考价格 ¥68/月起", en: "Reference price from ¥68/month" },
      source: "https://lisahost.com/cart.php",
    },
    assessment: {
      checkedAt, location: { zh: "美国 · 洛杉矶", en: "US · Los Angeles" },
      operator: "NTT America, Inc.", asn: 2914,
      sent: 20, received: 17, timeouts: 3, averageMs: 157, minMs: 150, maxMs: 202,
    },
    note: { zh: "9929 与住宅属性为官网标称，未通过本次短测验证。", en: "9929 routing and residential status are vendor claims, unverified by this short test." },
  },
  {
    id: "yinnet",
    name: "YINNET",
    domain: "yin-net.com",
    website: "https://www.yin-net.com/aff.php?aff=1149",
    summary: {
      zh: "提供美国、韩国、日本等地区 ISP VPS，支持按地区及资源配置选择。",
      en: "ISP VPS in the US, Korea, Japan and more, with region and resource selection.",
    },
    product: {
      title: { zh: "美国双 ISP VPS ①", en: "US dual-ISP VPS ①" },
      specs: [
        { zh: "1核 / 1GB / 10GB", en: "1 vCPU / 1GB RAM / 10GB storage" },
        { zh: "100Mbps / 1000GB 月流量", en: "100Mbps / 1000GB monthly transfer" },
        { zh: "1 IPv4 / Linux / 普通直连", en: "1 IPv4 / Linux / standard routing" },
      ],
      price: { zh: "参考价格 US$6/月起", en: "Reference price from US$6/month" },
      source: "https://www.yin-net.com/index.php?rp=/store/isp-vps",
    },
    assessment: {
      checkedAt, location: { zh: "美国 · 洛杉矶", en: "US · Los Angeles" },
      operator: "NTT America, Inc.", asn: 2914,
      sent: 20, received: 18, timeouts: 2, averageMs: 247.7, minMs: 230, maxMs: 385,
    },
    note: { zh: "双 ISP 为官网标称，实际线路与服务可用性需在实例上另行核验。", en: "Dual-ISP is a vendor claim; actual routing and service availability need separate instance testing." },
  },
  {
    id: "lcayun",
    name: "莱卡云",
    domain: "lcayun.com",
    website: "https://www.lcayun.com/aff/OEDHHSXN",
    summary: {
      zh: "提供多地区双 ISP 云服务器及弹性配置，支持中文控制台管理。",
      en: "Multi-region dual-ISP cloud servers with elastic sizing and a Chinese control panel.",
    },
    product: {
      title: { zh: "美国双 ISP（弹性）", en: "US dual-ISP (elastic)" },
      specs: [
        { zh: "1–32核 / 1–64GB / 30–300GB", en: "1–32 vCPUs / 1–64GB RAM / 30–300GB storage" },
        { zh: "100–200Mbps / 1–5 IPv4", en: "100–200Mbps / 1–5 IPv4" },
        { zh: "Windows / Linux / 普通直连", en: "Windows / Linux / standard routing" },
      ],
      price: { zh: "参考价格 ¥52/月起", en: "Reference price from ¥52/month" },
      source: "https://www.lcayun.com/cart?fid=1&gid=100",
    },
    assessment: {
      checkedAt, location: { zh: "韩国 · 首尔", en: "KR · Seoul" },
      operator: "SEJONG NETWORKS", asn: 9848,
      sent: 20, received: 15, timeouts: 5, averageMs: 363.9, minMs: 328, maxMs: 466,
    },
    note: { zh: "历史样本位于韩国；上方为美国产品示例，不代表样本的实际套餐。", en: "The historical sample is in Korea; the US product above is not its confirmed plan." },
  },
];

export const VPS_DISCLAIMER: ProviderText = {
  zh: "产品参数为官网标称示例，不代表实例配置；价格与库存以官网为准。测试于样本当时的本机网络进行，每个样本 20 次 ICMP、单次超时 1.5 秒，不代表当前网络表现。短时 ICMP 超时不等于业务丢包；住宅/双 ISP 属性、带宽及服务解锁未验证。地区与运营商来自 IPWHO.IS，ASN 经 RIPEstat 核对，归属信息不证明住宅属性。",
  en: "Product specs are vendor examples, not confirmed instance configurations; check vendor prices and stock. Historical tests used the local network at the time: 20 ICMP probes per sample with a 1.5-second timeout, not current network performance. ICMP timeouts are not business packet loss; residential/dual-ISP status, bandwidth and service unblocking are unverified. Location and operator came from IPWHO.IS, with ASNs checked via RIPEstat; attribution does not prove residential status.",
};
