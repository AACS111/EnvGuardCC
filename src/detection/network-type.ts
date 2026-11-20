const datacenterAsns: Record<string, string> = {
  AS132203: 'Tencent Cloud', AS45090: 'Tencent Cloud', AS16509: 'Amazon AWS', AS14618: 'Amazon AWS',
  AS396982: 'Google Cloud', AS15169: 'Google', AS8075: 'Microsoft', AS14061: 'DigitalOcean',
  AS24940: 'Hetzner', AS16276: 'OVH', AS20473: 'Vultr', AS63949: 'Akamai / Linode',
  AS45102: 'Alibaba Cloud', AS31898: 'Oracle Cloud',
};

export type NetworkTypeEvidence = {
  ip: string;
  source: string;
  kind: 'datacenter' | 'not-hosting' | 'other';
};

export function readIpQueryNetworkEvidence(data: Record<string, unknown>): NetworkTypeEvidence | null {
  const ip = typeof data.ip === 'string' ? data.ip.trim() : '';
  if (!ip || !data.risk || typeof data.risk !== 'object') return null;
  const risk = data.risk as Record<string, unknown>;
  if (typeof risk.is_datacenter !== 'boolean') return null;
  if (risk.is_datacenter) return { ip, source: 'IPQuery', kind: 'datacenter' };
  const other = [risk.is_mobile, risk.is_proxy, risk.is_vpn, risk.is_tor];
  if (other.some((flag) => flag === true)) return { ip, source: 'IPQuery', kind: 'other' };
  return other.every((flag) => flag === false) ? { ip, source: 'IPQuery', kind: 'not-hosting' } : null;
}

export function exitNetworkType(org: string | null | undefined, locale: string, asn?: string | null, ip?: string | null, evidence: NetworkTypeEvidence[] = []) {
  const zh = locale.startsWith('zh');
  const text = (cn: string, en: string) => zh ? cn : en;
  const name = org?.trim() ?? '';
  const asnNumber = asn?.trim().toUpperCase().match(/^(?:AS)?([0-9]+)$/)?.[1];
  const asnCode = asnNumber ? `AS${asnNumber}` : null;
  const provider = asnCode ? datacenterAsns[asnCode] : undefined;
  const datacenter = /cloud|amazon|google(?! fiber)|microsoft|azure|digitalocean|ovh|hetzner|linode|vultr|alibaba|tencent|m247|choopa|leaseweb|contabo|oracle|akari|hosting|data[ -]?cent(?:er|re)|colo(?:cation)?\b/i;
  const broadband = /comcast|xfinity|charter communications|spectrum|cox communications|rogers|shaw communications|bell canada|verizon|at&t|google fiber|chunghwa telecom|hinet|korea telecom|kt corporation|sk broadband|lg uplus|kddi|softbank|\bbiglobe\b|orange s\.?a\.?|deutsche telekom|british telecommunications|telstra|china telecom|china unicom|中国电信|中国联通|中国移动|中华电信/i;
  const sameExit = evidence.filter((entry) => ip && entry.ip.toLowerCase() === ip.toLowerCase());
  const hosting = sameExit.some((entry) => entry.kind === 'datacenter');
  const notHosting = sameExit.some((entry) => entry.kind === 'not-hosting');
  const other = sameExit.some((entry) => entry.kind === 'other');
  const sources = [...new Set(sameExit.map((entry) => entry.source))].join('、');
  const cloud = Boolean(provider || datacenter.test(name));
  if (hosting && !notHosting) return {
    kind: 'datacenter',
    label: text('机房网络', 'Datacenter'),
    detail: text(`${sources} 将当前出口标为机房网络。`, `${sources} classifies the current exit as datacenter.`),
  } as const;
  if (hosting && notHosting) return {
    kind: 'unknown',
    label: text('暂无法判定', 'Undetermined'),
    detail: text(`${sources} 的网络类型标记有冲突。`, `Network type sources disagree: ${sources}.`),
  } as const;
  if (notHosting && !cloud && !other) return {
    kind: 'residential',
    label: broadband.test(name) ? text('家庭网络（推断）', 'Residential (inferred)') : text('疑似家宽', 'Possibly residential'),
    detail: text(`${sources} 未将当前出口标为机房。该标记无法单独确认家宽，仍可能是企业或其他网络。`, `${sources} does not flag the current exit as hosting. This alone cannot confirm residential use.`),
  } as const;
  const kind = cloud ? 'datacenter' : !other && broadband.test(name) ? 'residential' : 'unknown';
  const label = kind === 'datacenter' ? text('机房网络（推断）', 'Datacenter (inferred)')
    : kind === 'residential' ? text('家庭网络（推断）', 'Residential (inferred)')
      : text('暂无法判定', 'Undetermined');
  const detail = provider ? text(`出口 ASN ${asnCode} 对应 ${provider}，组织名：${name || '未提供'}。按云厂商归属推断，非 IP 类型数据库实测。`, `Exit ASN ${asnCode} belongs to ${provider}; organization: ${name || 'unavailable'}. Inferred from cloud-provider ownership, not verified by an IP-type database.`)
    : !name ? text('尚未取得出口运营商信息，请刷新出口检测。', 'No exit network organization is available. Refresh the exit check.')
    : kind === 'unknown' ? text(`出口组织：${name}。现有证据不足以区分家庭和机房网络。`, `Exit organization: ${name}. Available evidence cannot distinguish residential and datacenter networks.`)
      : text(`依据出口组织 ${name} 的名称推断；非 IP 类型数据库实测，运营商线路也可能用于企业、移动网络或托管服务。`, `Inferred from the exit organization ${name}; not verified by an IP-type database. Carrier networks may also serve businesses, mobile users, or hosting services.`);
  return { kind, label, detail } as const;
}
