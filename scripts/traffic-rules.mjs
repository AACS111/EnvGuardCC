import { createHash } from 'node:crypto';
import { isIP, BlockList } from 'node:net';
import { domainToASCII } from 'node:url';

export function normalizeSites(input = {}) {
  const domains = [...new Set((input.domains ?? []).map(value => {
    if (typeof value !== 'string') throw new Error('域名必须是文本');
    const host = domainToASCII(value.toLowerCase().replace(/^\*\./, '').replace(/\.$/, ''));
    if (!host || isIP(host) || host.length > 253 || !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error('无效域名');
    return host;
  }))];
  const cidrs = [...new Set([...(input.ips ?? []), ...(input.cidrs ?? [])].map(value => {
    if (typeof value !== 'string') throw new Error('IP 必须是文本');
    const [ip, bits, extra] = value.split('/');
    const family = isIP(ip), prefix = bits === undefined ? (family === 4 ? 32 : 128) : Number(bits);
    if (!family || extra !== undefined || bits === '' || !Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) throw new Error('无效 IP/CIDR');
    new BlockList().addSubnet(ip, prefix, family === 4 ? 'ipv4' : 'ipv6');
    return `${ip}/${prefix}`;
  }))];
  return { domains, cidrs };
}

// Logical Mihomo rules contain commas inside parentheses.
export function splitRule(rule) {
  const fields = []; let depth = 0, start = 0;
  for (let index = 0; index < rule.length; index++) {
    if (rule[index] === '(') depth++;
    if (rule[index] === ')') depth--;
    if (depth < 0) throw new Error('规则括号不匹配');
    if (rule[index] === ',' && depth === 0) { fields.push(rule.slice(start, index).trim()); start = index + 1; }
  }
  if (depth) throw new Error('规则括号不匹配');
  fields.push(rule.slice(start).trim()); return fields;
}

export function buildTrafficConfig(original, options) {
  const { secret, listenPort = 3011, upstreamBasePort = 39100, defaultPolicy = 'Overseas' } = options;
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('拦截层认证密钥过短');
  for (const port of [listenPort, upstreamBasePort]) if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口无效');
  const config = structuredClone(original), sites = normalizeSites(options.sites);
  const names = new Set([...(config.proxies ?? []), ...(config['proxy-groups'] ?? [])].map(item => item.name));
  if (!names.has(defaultPolicy)) throw new Error('默认出口策略不存在');
  const routes = [], wrappers = new Map();
  const reserved = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE']);
  const usedPorts = new Set([config['mixed-port'], config.port, config['socks-port'], ...(config.listeners ?? []).map(item => item.port)].filter(Boolean));
  if (usedPorts.has(listenPort)) throw new Error('拦截入口与现有端口冲突');
  function wrap(policy) {
    if (wrappers.has(policy)) return wrappers.get(policy);
    if (!names.has(policy)) throw new Error(`未知出口策略：${policy}`);
    const id = createHash('sha256').update(policy).digest('hex').slice(0, 16);
    const name = `EnvGuardCC-${id}`, port = upstreamBasePort + routes.length;
    if (names.has(name) || port > 65535 || port === listenPort || usedPorts.has(port)) throw new Error('生成的策略或端口与现有配置冲突');
    names.add(name); usedPorts.add(port);
    routes.push({ id, policy, upstream: `http://127.0.0.1:${port}` });
    (config.proxies ??= []).push({ name, type: 'http', server: '127.0.0.1', port: listenPort, username: id, password: secret, udp: false });
    // This inbound selects the ORIGINAL group directly; it never re-enters the rules.
    (config.listeners ??= []).push({ name: `checkcc-return-${id}`, type: 'http', listen: '127.0.0.1', port, proxy: policy });
    wrappers.set(policy, name); return name;
  }
  const rules = (config.rules ?? []).map(rule => {
    if (typeof rule !== 'string') throw new Error('不支持非文本规则');
    const fields = splitRule(rule);
    const index = fields.length - (fields.at(-1) === 'no-resolve' ? 2 : 1);
    const policy = fields[index];
    if (reserved.has(policy)) return rule;
    // Sub-rule jumps are resolved inside the original sub-rule tables below.
    if (fields[0] === 'SUB-RULE') return rule;
    fields[index] = wrap(policy); return fields.join(',');
  });
  for (const [name, values] of Object.entries(config['sub-rules'] ?? {})) {
    config['sub-rules'][name] = values.map(rule => {
      const fields = splitRule(rule), index = fields.length - (fields.at(-1) === 'no-resolve' ? 2 : 1);
      if (!reserved.has(fields[index]) && fields[0] !== 'SUB-RULE') fields[index] = wrap(fields[index]);
      return fields.join(',');
    });
  }
  const forced = sites.domains.map(domain => `DOMAIN-SUFFIX,${domain},${wrap(defaultPolicy)}`);
  for (const cidr of sites.cidrs) forced.push(`${cidr.includes(':') ? 'IP-CIDR6' : 'IP-CIDR'},${cidr},${wrap(defaultPolicy)},no-resolve`);
  config.rules = ['IP-CIDR,127.0.0.0/8,DIRECT,no-resolve', 'IP-CIDR6,::1/128,DIRECT,no-resolve', ...forced, ...rules];
  config.mode = 'rule';
  return { config, routes, sites, listenPort, secret, defaultPolicy, version: 1 };
}
