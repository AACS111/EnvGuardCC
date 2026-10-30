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
const { exitNetworkType } = output.exports;

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
