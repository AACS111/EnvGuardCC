// 内核配置不变量：NET-CORE.md 声称「任何一条不满足都拒绝启动」，这里把那份清单变成可执行断言。
// 只用 RFC 5737 保留地址，不依赖真实订阅、网络或内核二进制。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { CHINA_CIDRS } from './net-core/china-routes.mjs';
import { publicDnsForCountry, ANYCAST_DOH } from './net-core/public-dns.mjs';
import { buildKernelConfig, buildProbeConfig, strictKernelConfig, assertStrictKernelConfig, assertKernelConfig, serializeKernelConfig, CLAUDE_DOMAINS, CN_DIRECT_DOMAINS, DEFAULT_GROUP, DEFAULT_AUTO_GROUP, CLAUDE_GUARD_GROUP } from './net-core/config.mjs';

const proxies = [
  { name: 'node-a', type: 'ss', server: '203.0.113.10', port: 443, cipher: 'aes-128-gcm', password: 'test' },
  { name: 'node-b', type: 'vless', server: '203.0.113.11', port: 443, uuid: '11111111-1111-1111-1111-111111111111', tls: true },
];
const build = (overrides = {}) => buildKernelConfig({ proxies, selected: 'node-a', apiPort: 39090, mixedPort: 39080, egressMode: 'rule', ...overrides });

test('地区 DNS 支持 TCP 避开节点 UDP 故障，所有候选仍走固定出口', () => {
  const servers = publicDnsForCountry('US', { preferTcp: true });
  assert.deepEqual(servers, ['tcp://4.2.2.1', 'tcp://4.2.2.2']);
  assert.deepEqual(build({ publicDns: servers }).dns.nameserver, servers.map(server => `${server}#CLAUDE-PIN`));
  assert.deepEqual(publicDnsForCountry('ZZ', { preferTcp: true }), ANYCAST_DOH);
});

test('主内核与临时内核统一使用复用连接测速及 TCP 并发拨号', () => {
  for (const config of [build(), buildProbeConfig({ proxies, names: proxies.map(p => p.name) })]) {
    assert.equal(config['unified-delay'], true);
    assert.equal(config['tcp-concurrent'], true);
  }
  assert.equal(build()['proxy-groups'].find(group => group.name === DEFAULT_AUTO_GROUP).url, 'https://www.gstatic.com/generate_204');
});

test('默认阻断的内核不读取磁盘中上次放行的选择器', () => {
  const blocked = build({ guardInitiallyBlocked: true });
  assert.deepEqual(blocked.profile, { 'store-selected': false });
  assert.deepEqual(blocked['proxy-groups'].find(group => group.name === CLAUDE_GUARD_GROUP).proxies, ['REJECT', DEFAULT_GROUP]);
  assert.equal(blocked['proxy-groups'].find(group => group.name === DEFAULT_GROUP).proxies[0], 'node-a');
});

test('地区 DNS 不混入 anycast，全部固定到 Claude 出口', () => {
  const config = build({ publicDns: ['168.95.1.1', '168.95.192.1'] });
  const doh = ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'];
  assert.deepEqual(config.dns.nameserver, ['168.95.1.1#CLAUDE-PIN', '168.95.192.1#CLAUDE-PIN']);
  assert.equal(config.dns['respect-rules'], true);
  const custom = build({ publicDns: ['https://dns.example/dns-query', 'udp://192.0.2.53'] });
  assert.deepEqual(custom.dns.nameserver, ['https://dns.example/dns-query#CLAUDE-PIN', 'udp://192.0.2.53#CLAUDE-PIN']);
  assert.deepEqual(build({ publicDns: doh }).dns.nameserver, doh.map(server => `${server}#CLAUDE-PIN`));
  assert.deepEqual(strictKernelConfig({ ...config, secret: 'a'.repeat(32) }).dns.nameserver, config.dns.nameserver);
});

test('支持 IPv6 的节点启用双栈 TUN、AAAA 和同一套 Claude 固定出口规则', () => {
  const config = build({ ipv6: true });
  assert.equal(config.ipv6, true);
  assert.equal(config.dns.ipv6, true);
  assert.deepEqual(config.tun['inet6-address'], ['fdfe:dcba:9876::1/126']);
  assertKernelConfig(config, { egressMode: 'rule' });
  const strict = strictKernelConfig({ ...config, secret: 'x'.repeat(32) });
  assert.equal(strict.ipv6, true);
  assertStrictKernelConfig(strict);
});

test('规则模式：Claude 置顶、固定出口、strict-route、fake-ip 与故障转移兜底', () => {
  const config = build();
  assert.equal(config.ipv6, false);
  assert.equal(config.tun.enable, true);
  assert.equal(config.tun['strict-route'], true);
  assert.equal(config.dns['enhanced-mode'], 'fake-ip');
  assert.equal(config.dns['respect-rules'], true);
  assert.deepEqual(
    config.rules.slice(0, CLAUDE_DOMAINS.length * 2),
    [...CLAUDE_DOMAINS.map((domain) => `AND,((NETWORK,udp),(DST-PORT,443),(DOMAIN-SUFFIX,${domain})),REJECT`), ...CLAUDE_DOMAINS.map((domain) => `DOMAIN-SUFFIX,${domain},${CLAUDE_GUARD_GROUP}`)],
  );
  const groups = new Map(config['proxy-groups'].map((group) => [group.name, group]));
  assert.equal(groups.get(DEFAULT_GROUP).type, 'select');
  // 守卫组只包含固定出口组与 REJECT：运行时切一次选择就能阻断/放行 Claude，不需要重载配置。
  assert.deepEqual(groups.get(CLAUDE_GUARD_GROUP).proxies, [DEFAULT_GROUP, 'REJECT']);
  assert.equal(groups.get(CLAUDE_GUARD_GROUP).type, 'select');
  const auto = groups.get(DEFAULT_AUTO_GROUP);
  assert.ok(['fallback', 'url-test'].includes(auto.type));
  assert.deepEqual([...auto.proxies].sort(), proxies.map((node) => node.name).sort());
  assert.equal(typeof auto.url, 'string');
  assert.equal(Number.isInteger(auto.interval), true);
  assert.equal(config.rules.at(-1), `MATCH,${DEFAULT_AUTO_GROUP}`);
  assert.equal(new Set(config.rules).size, config.rules.length);
  // 做 TLS 握手的节点必须带指纹；纯 ss 不参与 TLS，不强行补。
  assert.equal(config.proxies.find((node) => node.name === 'node-b')['client-fingerprint'], 'chrome');
  assert.doesNotThrow(() => assertKernelConfig(config, { egressMode: 'rule' }));
});

test('默认分流只使用通用局域网和国内规则，STUN 拦截适用于所有进程', () => {
  const config = build({ ipv6: true });
  const localDomains = ['localhost', 'lan', 'local', 'home.arpa'];
  const directDomains = [...localDomains, ...CN_DIRECT_DOMAINS];
  assert.deepEqual(config.rules.filter(rule => /^DOMAIN-SUFFIX,.*,DIRECT$/.test(rule)),
    directDomains.map(domain => `DOMAIN-SUFFIX,${domain},DIRECT`));
  assert.ok(!config.rules.some(rule => rule.startsWith('PROCESS-NAME,')));
  assert.ok(config.rules.includes('AND,((NETWORK,udp),(DST-PORT,3478)),REJECT'));
  assert.deepEqual(config.dns['fake-ip-filter'], [...localDomains.map(domain => `+.${domain}`), '+.msftconnecttest.com', '+.msftncsi.com']);
  assert.equal(config.dns['nameserver-policy']['+.oray.com'], undefined);
  assert.deepEqual(config.dns['nameserver-policy']['+.cn'], config.dns['direct-nameserver']);
  const rules = new Set(config.rules);
  for (const cidr of CHINA_CIDRS) {
    assert.ok(rules.has(`${cidr.includes(':') ? 'IP-CIDR6' : 'IP-CIDR'},${cidr},DIRECT`), cidr);
  }
  assert.ok(Buffer.byteLength(serializeKernelConfig(config)) < 4 * 1024 * 1024);
  for (const egressMode of ['global', 'direct']) {
    const other = build({ egressMode, ipv6: true });
    assert.ok(!other.rules.includes('DOMAIN-SUFFIX,cn,DIRECT'));
    assert.ok(!other.rules.includes(`IP-CIDR,${CHINA_CIDRS.find(cidr => !cidr.includes(':'))},DIRECT`));
    assert.equal(other.dns['nameserver-policy']['+.cn'], undefined);
  }
  const strict = strictKernelConfig(build({ secret: 'x'.repeat(40) }));
  assert.deepEqual(strict.dns['nameserver-policy'], {});
  assert.deepEqual(strict.dns['fake-ip-filter'], []);
});

test('离线中国网段与上游快照一致，且全部可解析', () => {
  const hash = createHash('sha256').update(CHINA_CIDRS.join('\n') + '\n').digest('hex');
  assert.equal(hash, 'd308cc97fd9222c5b66a5e71790f4f508a59b0a7a574dc04778dcf21ea49e6e6');
  assert.equal(new Set(CHINA_CIDRS).size, CHINA_CIDRS.length);
  const networks = new BlockList();
  for (const cidr of CHINA_CIDRS) {
    const [address, prefix] = cidr.split('/');
    networks.addSubnet(address, Number(prefix), isIP(address) === 4 ? 'ipv4' : 'ipv6');
  }
});

test('额外规则介于 Claude、STUN、内网保护和默认国内分流之间', () => {
  const extraRules = ['DOMAIN-SUFFIX,baidu.com,AUTO-PROXY', 'IP-CIDR,1.0.1.0/24,AUTO-PROXY', 'DOMAIN-SUFFIX,baidu.com,DIRECT'];
  const config = build({ extraRules, localNetwork: { directDomains: ['corp.example'], routeExcludeAddresses: ['1.0.1.0/24'] } });
  const relevant = new Set([
    'DOMAIN-SUFFIX,claude.ai,CLAUDE-GUARD', 'AND,((NETWORK,udp),(DST-PORT,3478)),REJECT',
    'DOMAIN-SUFFIX,corp.example,DIRECT', 'IP-CIDR,1.0.1.0/24,DIRECT', ...extraRules, 'DOMAIN-SUFFIX,cn,DIRECT',
  ]);
  assert.deepEqual(config.rules.filter(rule => relevant.has(rule)), [...relevant]);
  for (const catchAll of ['MATCH,DIRECT', 'FINAL,DIRECT', ' match ,DIRECT']) {
    assert.throws(() => build({ extraRules: [catchAll] }), /MATCH|FINAL/);
  }
});

test('国内及节点 DNS 子域策略不覆盖固定出口 DNS', () => {
  const config = build({ domains: ['qq.com', ...CLAUDE_DOMAINS], proxies: [{ ...proxies[0], server: 'gateway.claude.ai' }] });
  for (const host of ['weixin.qq.com', 'gateway.claude.ai']) {
    const policy = Object.entries(config.dns['nameserver-policy'])
      .filter(([pattern]) => host === pattern.slice(2) || host.endsWith(`.${pattern.slice(2)}`))
      .sort(([a], [b]) => b.length - a.length)[0]?.[1];
    assert.deepEqual(policy, config.dns.nameserver);
  }
});

test('direct 模式不生成兜底组，最后一条为 MATCH,DIRECT', () => {
  for (const egressMode of ['direct']) {
    const config = build({ egressMode });
    assert.equal(config['proxy-groups'].some((group) => group.name === DEFAULT_AUTO_GROUP), false);
    assert.equal(config.rules.at(-1), 'MATCH,DIRECT');
    assert.doesNotThrow(() => assertKernelConfig(config, { egressMode }));
  }
});

test('strictRoute=false 只在显式声明时通过，不会静默放宽', () => {
  const loose = build({ localNetwork: { strictRoute: false } });
  assert.equal(loose.tun['strict-route'], false);
  assert.throws(() => assertKernelConfig(loose, { egressMode: 'rule' }), /strict-route/);
  assert.doesNotThrow(() => assertKernelConfig(loose, { egressMode: 'rule', strictRoute: false }));
});

test('任何一条不变量被破坏都必须拒绝启动', () => {
  const mutations = [
    ['开启 IPv6', (config) => { config.ipv6 = true; }],
    ['关闭 strict-route', (config) => { config.tun['strict-route'] = false; }],
    ['退回明文 DNS', (config) => { config.dns['enhanced-mode'] = 'redir-host'; }],
    ['把置顶规则挪到末尾', (config) => { config.rules.push(...config.rules.splice(0, CLAUDE_DOMAINS.length)); }],
    ['Claude 出口组改成自动测速', (config) => { config['proxy-groups'].find((group) => group.name === DEFAULT_GROUP).type = 'url-test'; }],
    ['兜底组只留一个节点', (config) => { config['proxy-groups'].find((group) => group.name === DEFAULT_AUTO_GROUP).proxies = ['node-a']; }],
    ['兜底组去掉健康检查', (config) => { delete config['proxy-groups'].find((group) => group.name === DEFAULT_AUTO_GROUP).url; }],
    ['最后一条不是 MATCH', (config) => { config.rules[config.rules.length - 1] = 'DOMAIN-SUFFIX,example.com,DIRECT'; }],
    ['重复规则', (config) => { config.rules.splice(config.rules.length - 1, 0, config.rules[10]); }],
  ];
  for (const [name, mutate] of mutations) {
    const config = build();
    mutate(config);
    assert.throws(() => assertKernelConfig(config, { egressMode: 'rule' }), /./, `未拒绝：${name}`);
  }
});

test('关闭 sniffer / STUN 时必须同步关闭对应断言，不允许半开状态', () => {
  const config = build({ sniffer: false, blockStun: false });
  assert.throws(() => assertKernelConfig(config, { egressMode: 'rule' }), /sniffer|STUN/);
  assert.doesNotThrow(() => assertKernelConfig(config, { egressMode: 'rule', sniffer: false, blockStun: false }));
});

test('固定出口探测只钉探测主机到专用组，不新增入站', () => {
  assert.equal(build().listeners, undefined);
  assert.ok(!build().rules.some((rule) => rule.includes('ipwho.is')));
  const probed = build({ exitProbeHost: 'ipwho.is' });
  assert.equal(probed.listeners, undefined);
  assert.ok(probed.rules.includes(`DOMAIN-SUFFIX,ipwho.is,${DEFAULT_GROUP}`));
  assert.ok(probed.rules.indexOf(`DOMAIN-SUFFIX,ipwho.is,${DEFAULT_GROUP}`) < probed.rules.indexOf('MATCH,AUTO-PROXY'));
  assert.doesNotThrow(() => assertKernelConfig(probed, { egressMode: 'rule' }));
  const pinnedIp = build({ exitProbeHost: '203.0.113.77' });
  assert.ok(pinnedIp.rules.includes(`IP-CIDR,203.0.113.77/32,${DEFAULT_GROUP}`));
  assert.throws(() => build({ exitProbeHost: 'not a host!' }), /域名或 IP/);
});

test('区域锁定：Claude 域名在置顶代理规则之前被 REJECT，严格模式同样生效', () => {
  const locked = build({ blockClaude: true });
  const firstClaude = locked.rules.findIndex((rule) => rule.endsWith(`,${CLAUDE_GUARD_GROUP}`) && rule.includes('claude.ai'));
  const firstReject = locked.rules.findIndex((rule) => rule === 'DOMAIN-SUFFIX,claude.ai,REJECT');
  assert.ok(firstReject >= 0 && firstReject < firstClaude, 'REJECT 必须排在代理规则之前');
  assert.doesNotThrow(() => assertKernelConfig(locked, { egressMode: 'rule', blockClaude: true }));
  // 严格模式重写规则后仍然保留封禁，并且裁掉运行时守卫组（它本来就要断全部）。
  const strict = strictKernelConfig(build({ blockClaude: true, secret: 'x'.repeat(40) }), { blockClaude: true });
  assert.ok(strict.rules.includes('DOMAIN-SUFFIX,claude.ai,REJECT'));
  assert.equal(strict['proxy-groups'].some((group) => group.name === CLAUDE_GUARD_GROUP), false);
  assert.equal(strict.rules.at(-1), `MATCH,${DEFAULT_GROUP}`);
  assert.doesNotThrow(() => assertStrictKernelConfig(strict));
});

// 不存在的网卡代表公司 VPN / 有线网络离线；公网配置必须与未配置内网时一致。
test('公司网卡离线：公司 DNS 仅限内网域名，公网直连与 Claude 保护保持独立', () => {
  for (const egressMode of ['rule', 'direct', 'global']) {
    for (const binding of [{ directInterface: 'Offline Corp Adapter' }, { dnsInterface: 'Offline Corp DNS' }]) {
      const baseline = build({ egressMode });
      const config = build({ egressMode, localNetwork: {
        directDomains: ['corp.example'], dnsServers: ['192.0.2.53'], ...binding,
      } });
      assert.deepEqual(config.dns['nameserver-policy']['+.corp.example'], ['192.0.2.53#ENVGUARD-LOCAL-DNS']);
      assert.equal(config.proxies.find(node => node.name === 'ENVGUARD-LOCAL-DNS')['interface-name'], binding.dnsInterface ?? binding.directInterface);
      assert.deepEqual(config.dns['direct-nameserver'], baseline.dns['direct-nameserver']);
      assert.ok(config.dns['direct-nameserver'].length > 0);
      assert.ok(config.dns['direct-nameserver'].every(server => server.endsWith('#DIRECT') && !server.includes('192.0.2.53')));
      assert.equal(config.dns['direct-nameserver-follow-policy'], true);
      assert.deepEqual(config.dns['nameserver-policy']['+.baidu.com'], baseline.dns['nameserver-policy']['+.baidu.com']);
      if (egressMode === 'rule') assert.ok(config.rules.includes('DOMAIN-SUFFIX,baidu.com,DIRECT'));
      if (egressMode === 'direct') assert.equal(config.rules.at(-1), 'MATCH,DIRECT');
      assert.deepEqual(config.dns.nameserver, baseline.dns.nameserver);
      assert.deepEqual(config['proxy-groups'], baseline['proxy-groups']);
      assert.ok(config.rules.includes('DOMAIN-SUFFIX,claude.ai,CLAUDE-GUARD'));
      assert.equal(config.tun['strict-route'], true);
      assertKernelConfig(config, { egressMode });
    }
  }
});

test('公网直连 DNS 允许显式覆盖，内网 DNS 策略仍独立保留', () => {
  const directDns = ['udp://192.0.2.54:53#DIRECT'];
  const config = build({
    localNetwork: { directDomains: ['corp.example'], dnsServers: ['192.0.2.53'], directInterface: 'Offline Corp Adapter' },
    dns: { 'direct-nameserver': directDns },
  });
  assert.deepEqual(config.dns['direct-nameserver'], directDns);
  assert.deepEqual(config.dns['nameserver-policy']['+.corp.example'], ['192.0.2.53#ENVGUARD-LOCAL-DNS']);
});

// 系统里残留「指向已断开网卡的默认路由」时，内核 auto-detect-interface 会拿到空接口；
// 运行时探测到真正 Up 的出口网卡后要显式写进 tun.interface-name。
test('显式出口网卡：写入 tun.interface-name，未提供时保持自动探测', () => {
  assert.equal(build().tun['interface-name'], undefined);
  assert.equal(build().tun['auto-detect-interface'], true);
  assert.equal(build({ tunInterface: 'WLAN' }).tun['interface-name'], 'WLAN');
  assert.equal(build({ tunInterface: '  WLAN  ' }).tun['interface-name'], 'WLAN');
  assert.equal(build({ tunInterface: '' }).tun['interface-name'], undefined);
  assert.equal(build({ tunInterface: '   ' }).tun['interface-name'], undefined);
  assertKernelConfig(build({ tunInterface: 'WLAN' }), { egressMode: 'rule' });
  const strict = strictKernelConfig(build({ tunInterface: 'WLAN', secret: 'x'.repeat(40) }));
  assert.equal(strict.tun['interface-name'], 'WLAN');
  assert.equal(strict.tun['strict-route'], true);
});
