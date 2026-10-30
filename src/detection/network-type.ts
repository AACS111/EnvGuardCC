const datacenterAsns: Record<string, string> = {
  AS132203: 'Tencent Cloud', AS45090: 'Tencent Cloud', AS16509: 'Amazon AWS', AS14618: 'Amazon AWS',
  AS396982: 'Google Cloud', AS15169: 'Google', AS8075: 'Microsoft', AS14061: 'DigitalOcean',
  AS24940: 'Hetzner', AS16276: 'OVH', AS20473: 'Vultr', AS63949: 'Akamai / Linode',
  AS45102: 'Alibaba Cloud', AS31898: 'Oracle Cloud',
};

export function exitNetworkType(org: string | null | undefined, locale: string, asn?: string | null) {
  const zh = locale.startsWith('zh');
  const text = (cn: string, en: string) => zh ? cn : en;
  const name = org?.trim() ?? '';
  const asnNumber = asn?.trim().toUpperCase().match(/^(?:AS)?([0-9]+)$/)?.[1];
  const asnCode = asnNumber ? `AS${asnNumber}` : null;
  const provider = asnCode ? datacenterAsns[asnCode] : undefined;
  const datacenter = /cloud|amazon|google(?! fiber)|microsoft|azure|digitalocean|ovh|hetzner|linode|vultr|alibaba|tencent|m247|choopa|leaseweb|contabo|oracle|hosting|data[ -]?cent(?:er|re)|colo(?:cation)?\b/i;
  const broadband = /comcast|xfinity|charter communications|spectrum|cox communications|rogers|shaw communications|bell canada|verizon|at&t|google fiber|chunghwa telecom|hinet|korea telecom|kt corporation|sk broadband|lg uplus|kddi|softbank|orange s\.?a\.?|deutsche telekom|british telecommunications|telstra|china telecom|china unicom|中国电信|中国联通|中国移动|中华电信/i;
  const kind = provider || datacenter.test(name) ? 'datacenter' : broadband.test(name) ? 'residential' : 'unknown';
  const label = kind === 'datacenter' ? text('机房网络（推断）', 'Datacenter (inferred)')
    : kind === 'residential' ? text('家庭网络（推断）', 'Residential (inferred)')
      : text('暂无法判定', 'Undetermined');
  const detail = provider ? text(`出口 ASN ${asnCode} 对应 ${provider}，组织名：${name || '未提供'}。按云厂商归属推断，非 IP 类型数据库实测。`, `Exit ASN ${asnCode} belongs to ${provider}; organization: ${name || 'unavailable'}. Inferred from cloud-provider ownership, not verified by an IP-type database.`)
    : !name ? text('尚未取得出口运营商信息，请刷新出口检测。', 'No exit network organization is available. Refresh the exit check.')
    : kind === 'unknown' ? text(`出口组织：${name}。现有证据不足以区分家庭和机房网络。`, `Exit organization: ${name}. Available evidence cannot distinguish residential and datacenter networks.`)
      : text(`依据出口组织 ${name} 的名称推断；非 IP 类型数据库实测，运营商线路也可能用于企业、移动网络或托管服务。`, `Inferred from the exit organization ${name}; not verified by an IP-type database. Carrier networks may also serve businesses, mobile users, or hosting services.`);
  return { kind, label, detail } as const;
}
