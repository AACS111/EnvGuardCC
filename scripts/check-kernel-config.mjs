// 内核配置不变量：NET-CORE.md 声称「任何一条不满足都拒绝启动」，这里把那份清单变成可执行断言。
// 只用 RFC 5737 保留地址，不依赖真实订阅、网络或内核二进制。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKernelConfig, strictKernelConfig, assertStrictKernelConfig, assertKernelConfig, CLAUDE_DOMAINS, DEFAULT_GROUP, DEFAULT_AUTO_GROUP } from './net-core/config.mjs';

const proxies = [
  { name: 'node-a', type: 'ss', server: '203.0.113.10', port: 443, cipher: 'aes-128-gcm', password: 'test' },
  { name: 'node-b', type: 'vless', server: '203.0.113.11', port: 443, uuid: '11111111-1111-1111-1111-111111111111', tls: true },
];
const build = (overrides = {}) => buildKernelConfig({ proxies, selected: 'node-a', apiPort: 39090, mixedPort: 39080, egressMode: 'rule', ...overrides });

test('地区 DNS 无响应时可并行使用 DoH，显式协议保持且解析遵循路由', () => {
  const config = build({ publicDns: ['168.95.1.1', '168.95.192.1'] });
  const doh = ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'];
  assert.deepEqual(config.dns.nameserver, ['168.95.1.1', '168.95.192.1', ...doh]);
  assert.equal(config.dns['respect-rules'], true);
  const custom = build({ publicDns: ['https://dns.example/dns-query', 'udp://192.0.2.53'] });
  assert.deepEqual(custom.dns.nameserver, ['https://dns.example/dns-query', 'udp://192.0.2.53', ...doh]);
  assert.deepEqual(build({ publicDns: doh }).dns.nameserver, doh);
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
    [...CLAUDE_DOMAINS.map((domain) => `AND,((NETWORK,udp),(DST-PORT,443),(DOMAIN-SUFFIX,${domain})),REJECT`), ...CLAUDE_DOMAINS.map((domain) => `DOMAIN-SUFFIX,${domain},${DEFAULT_GROUP}`)],
  );
  const groups = new Map(config['proxy-groups'].map((group) => [group.name, group]));
  assert.equal(groups.get(DEFAULT_GROUP).type, 'select');
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
  const firstClaude = locked.rules.findIndex((rule) => rule.endsWith(',CLAUDE-PIN') && rule.includes('claude.ai'));
  const firstReject = locked.rules.findIndex((rule) => rule === 'DOMAIN-SUFFIX,claude.ai,REJECT');
  assert.ok(firstReject >= 0 && firstReject < firstClaude, 'REJECT 必须排在代理规则之前');
  assert.doesNotThrow(() => assertKernelConfig(locked, { egressMode: 'rule', blockClaude: true }));
  // 严格模式重写规则后仍然保留封禁。
  const strict = strictKernelConfig(build({ blockClaude: true, secret: 'x'.repeat(40) }), { blockClaude: true });
  assert.ok(strict.rules.includes('DOMAIN-SUFFIX,claude.ai,REJECT'));
  assert.equal(strict.rules.at(-1), `MATCH,${DEFAULT_GROUP}`);
  assert.doesNotThrow(() => assertStrictKernelConfig(strict));
});
