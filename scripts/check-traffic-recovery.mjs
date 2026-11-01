import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, stringify } from 'yaml';
import { buildTrafficConfig } from './traffic-rules.mjs';
import { hasTrafficReferences, planTrafficRecovery } from './traffic-recovery.mjs';

function fixture() {
  const original = {
    mode: 'global',
    proxies: [{ name: 'node', type: 'http', server: 'example.invalid', port: 443 }],
    'proxy-groups': [{ name: 'Overseas', type: 'select', proxies: ['node'] }],
    rules: ['DOMAIN-SUFFIX,example.org,Overseas', 'MATCH,Overseas'],
    'sub-rules': { nested: ['MATCH,Overseas'] },
  };
  const options = { secret: 'x'.repeat(32), listenPort: 3011, upstreamBasePort: 39100, defaultPolicy: 'Overseas', sites: { domains: ['example.com'] } };
  const built = buildTrafficConfig(original, options);
  const config = { ...built, config: undefined, defaultPolicy: options.defaultPolicy };
  return { original, applied: built.config, config, originalRaw: stringify(original), appliedRaw: stringify(built.config) };
}

test('外部更新后已无联动时保留当前配置，不需要联动备份', () => {
  const f = fixture();
  const current = structuredClone(f.original); current.proxies[0].port = 8443;
  const result = planTrafficRecovery({ ...f, appliedRaw: null, currentRaw: stringify(current) });
  assert.equal(result.kind, 'clean');
  assert.equal(result.candidate, undefined);
});

test('三方恢复只撤销生成的联动，保留节点、用户规则和注释', () => {
  const f = fixture();
  const current = structuredClone(f.applied);
  current.proxies[0].port = 8443;
  current.proxies.push({ name: 'new-node', type: 'direct' });
  current.rules.push('DOMAIN-SUFFIX,local.example,DIRECT');
  const raw = stringify(current).replace('port: 8443', 'port: 8443 # 用户修改');
  const result = planTrafficRecovery({ ...f, currentRaw: raw });
  assert.equal(result.kind, 'merge', result.reason);
  assert.match(result.candidate, /# 用户修改/);
  const restored = parse(result.candidate);
  assert.equal(restored.proxies[0].port, 8443);
  assert.equal(restored.proxies[1].name, 'new-node');
  assert.deepEqual(restored.rules, [...f.original.rules, 'DOMAIN-SUFFIX,local.example,DIRECT']);
  assert.deepEqual(restored['sub-rules'], f.original['sub-rules']);
  assert.equal(restored.mode, 'global');
  assert.equal(hasTrafficReferences(restored), false);
});

test('用户修改联动项或规则无法可靠还原时，不生成覆盖候选', () => {
  const f = fixture();
  const changedProxy = structuredClone(f.applied);
  changedProxy.proxies.at(-1).port = 9999;
  assert.equal(planTrafficRecovery({ ...f, currentRaw: stringify(changedProxy) }).kind, 'conflict');
  const changedRule = structuredClone(f.applied);
  changedRule.rules[0] = 'IP-CIDR,127.0.0.0/8,REJECT';
  assert.equal(planTrafficRecovery({ ...f, currentRaw: stringify(changedRule) }).kind, 'conflict');
  const changedReference = structuredClone(f.applied);
  changedReference.rules[changedReference.rules.length - 1] = `DOMAIN-SUFFIX,custom.test,EnvGuardCC-${f.config.routes[0].id}`;
  assert.equal(planTrafficRecovery({ ...f, currentRaw: stringify(changedReference) }).kind, 'conflict');
});

test('联动项上的用户注释、别名或缺少联动备份均不会被自动覆盖', () => {
  const f = fixture();
  const comment = f.appliedRaw.replace(`name: EnvGuardCC-${f.config.routes[0].id}`, `name: EnvGuardCC-${f.config.routes[0].id} # 用户注释`);
  assert.equal(planTrafficRecovery({ ...f, currentRaw: comment }).kind, 'conflict');
  assert.equal(planTrafficRecovery({ ...f, appliedRaw: null, currentRaw: f.appliedRaw }).kind, 'conflict');
  const alias = `${f.appliedRaw}\nextra-anchor: &mine value\nextra-alias: *mine\n`;
  assert.equal(planTrafficRecovery({ ...f, currentRaw: alias }).kind, 'conflict');
});

test('被重命名的未知联动引用和格式异常的规则不会被误判为已恢复', () => {
  const f = fixture();
  const renamed = structuredClone(f.original);
  renamed.proxies.push({ name: 'EnvGuardCC-renamed', type: 'direct' });
  assert.equal(planTrafficRecovery({ ...f, currentRaw: stringify(renamed) }).kind, 'conflict');
  const renamedEndpoint = structuredClone(f.original);
  renamedEndpoint.proxies.push({ name: 'user-renamed', type: 'http', server: '127.0.0.1', port: f.config.listenPort });
  assert.equal(planTrafficRecovery({ ...f, currentRaw: stringify(renamedEndpoint) }).kind, 'conflict');
  const addedEndpoint = structuredClone(f.applied);
  addedEndpoint.proxies.push({ name: 'user-renamed', type: 'http', server: '127.0.0.1', port: f.config.listenPort });
  assert.equal(planTrafficRecovery({ ...f, currentRaw: stringify(addedEndpoint) }).kind, 'conflict');
  const invalid = structuredClone(f.original); invalid.rules = 'not a rule array';
  assert.equal(planTrafficRecovery({ ...f, currentRaw: stringify(invalid) }).kind, 'conflict');
  const leftovers = structuredClone(f.original); leftovers.rules.unshift('DOMAIN-SUFFIX,example.com,DIRECT');
  assert.equal(planTrafficRecovery({ ...f, currentRaw: stringify(leftovers) }).kind, 'conflict');
});

test('配置中的循环别名不会让检查崩溃或遗漏联动引用', () => {
  const value = {}; value.self = value;
  assert.equal(hasTrafficReferences(value), false);
  value.name = 'EnvGuardCC-renamed';
  assert.equal(hasTrafficReferences(value), true);
  const f = fixture();
  const currentRaw = `${f.originalRaw}\nextra: &loop\n  self: *loop\n`;
  assert.equal(planTrafficRecovery({ ...f, currentRaw }).kind, 'clean');
});

test('原始配置中的注释或锚点没有保留时，不会自动丢弃这些信息', () => {
  const f = fixture();
  const commented = `# 用户原始注释\n${f.originalRaw}`;
  assert.match(planTrafficRecovery({ ...f, originalRaw: commented, currentRaw: f.appliedRaw }).reason, /注释/);
  const anchored = f.originalRaw.replace('name: node', 'name: &node-name node') + '\nother: *node-name\n';
  assert.match(planTrafficRecovery({ ...f, originalRaw: anchored, currentRaw: f.appliedRaw }).reason, /锚点/);
});
