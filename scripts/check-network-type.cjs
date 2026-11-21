/* eslint-disable @typescript-eslint/no-require-imports -- Match existing TypeScript model tests without another test dependency. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const path = require('node:path');
const vm = require('node:vm');
const file = path.join(__dirname, '../src/detection/network-type.ts');
const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const output = { exports: {} };
vm.runInNewContext(compiled.outputText, { exports: output.exports });
const { exitNetworkType, readIpQueryNetworkEvidence } = output.exports;

test('云厂商、宽带运营商与未知网络分开，未命中云厂商不能当作住宅', () => {
  assert.equal(exitNetworkType('Tencent Cloud Computing (Beijing) Co., Ltd', 'zh-CN').kind, 'datacenter');
  assert.equal(exitNetworkType('6 COLLYER QUAY', 'zh-CN', 'AS132203').kind, 'datacenter');
  assert.match(exitNetworkType('6 COLLYER QUAY', 'zh-CN', 'AS132203').detail, /Tencent Cloud/);
  assert.equal(exitNetworkType('Unknown company', 'zh-CN', 'AS999999').kind, 'unknown');
  assert.equal(exitNetworkType('Comcast Cable Communications', 'zh-CN').kind, 'residential');
  for (const org of [null, '', 'Example Company', 'Unidentified ISP']) assert.equal(exitNetworkType(org, 'zh-CN').kind, 'unknown');
  assert.equal(exitNetworkType('SK Broadband Cloud Hosting', 'zh-CN').kind, 'datacenter');
  for (const org of ['Example Colocation LLC', 'Example Colo']) assert.equal(exitNetworkType(org, 'zh-CN').kind, 'datacenter');
  for (const org of ['Google Fiber', 'Orange S.A.']) assert.equal(exitNetworkType(org, 'zh-CN').kind, 'residential');
});
test('名称推断明确保留不确定性和依据，支持首页中英文', () => {
  const home = exitNetworkType('Comcast Cable Communications', 'zh-CN');
  assert.match(home.label, /推断/);
  assert.match(home.detail, /企业/);
  assert.match(home.detail, /Comcast/);
  assert.match(exitNetworkType('Tencent Cloud', 'en').label, /Datacenter \(inferred\)/);
  assert.equal(exitNetworkType(null, 'en').label, 'Undetermined');
});

test('BIGLOBE 组织名识别为住宅推断，云厂商证据优先', () => {
  assert.equal(exitNetworkType('BIGLOBE Inc.', 'zh', 'AS2518').kind, 'residential');
  assert.equal(exitNetworkType('biglobe inc.', 'en', '2518').label, 'Residential (inferred)');
  assert.equal(exitNetworkType('BIGLOBE Cloud Hosting', 'en', 'AS2518').kind, 'datacenter');
  assert.equal(exitNetworkType('BIGLOBE Inc.', 'en', 'AS16509').kind, 'datacenter');
  assert.equal(exitNetworkType('Japan Network Information Center', 'zh', 'AS2518').kind, 'unknown');
});

test('只使用与当前出口相同的数据库证据，明确区分机房与家宽推断', () => {
  const ip = '203.0.113.20';
  const sample = (kind, address = ip, source = 'IPQuery') => ({ ip: address, kind, source });
  const classify = (evidence, org = 'Transit network', asn = 'AS2914') =>
    exitNetworkType(org, 'zh', asn, ip, evidence);
  assert.equal(classify([sample('not-hosting', '203.0.113.21')]).kind, 'unknown');
  assert.equal(classify([sample('not-hosting')]).label, '疑似家宽');
  assert.equal(classify([sample('not-hosting')], 'Comcast').label, '家庭网络（推断）');
  assert.match(classify([sample('not-hosting')]).detail, /IPQuery/);
  assert.equal(classify([sample('datacenter')]).label, '机房网络');
  assert.equal(classify([sample('not-hosting')], 'Transit network', 'AS16509').kind, 'datacenter');
  assert.equal(classify([sample('datacenter'), sample('not-hosting', ip, 'ipwho.is')]).kind, 'unknown');
  assert.equal(classify([sample('other')], 'Comcast').kind, 'unknown');
});

test('IPQuery 只在返回明确且完整的标记时参与家宽推断', () => {
  const ip = '203.0.113.20';
  const risk = { is_datacenter: false, is_mobile: false, is_proxy: false, is_vpn: false, is_tor: false };
  assert.equal(readIpQueryNetworkEvidence({ ip, risk }).kind, 'not-hosting');
  assert.equal(readIpQueryNetworkEvidence({ ip, risk: { ...risk, is_mobile: true } }).kind, 'other');
  assert.equal(readIpQueryNetworkEvidence({ ip, risk: { is_datacenter: true } }).kind, 'datacenter');
  assert.equal(readIpQueryNetworkEvidence({ ip, risk: { is_datacenter: false } }), null);
});
