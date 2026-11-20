/* eslint-disable @typescript-eslint/no-require-imports -- Exercise the real TS/React code without a new dependency. */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const test = require('node:test');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const root = path.resolve(__dirname, '..');
const nativeResolve = Module._resolveFilename;
Module._resolveFilename = function (id, parent, ...rest) {
  return nativeResolve.call(this, id.startsWith('@/') ? path.join(root, 'src', id.slice(2)) : id, parent, ...rest);
};
for (const extension of ['.ts', '.tsx']) {
  require.extensions[extension] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, filename);
}
const { VPS_PROVIDERS } = require('../src/detection/vps-providers.ts');
const { VpsRecommendDialog } = require('../src/components/detector/VpsRecommendDialog.tsx');
const ipv4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const render = (locale) => renderToStaticMarkup(React.createElement(VpsRecommendDialog, { locale, onClose() {} }));
module.exports = { render };

test('公开厂商目录没有个人 IP 或探测目标，仍保留三家的产品来源', () => {
  assert.deepEqual(VPS_PROVIDERS.map((provider) => provider.id), ['lisahost', 'yinnet', 'lcayun']);
  assert.doesNotMatch(JSON.stringify(VPS_PROVIDERS), ipv4);
  for (const provider of VPS_PROVIDERS) {
    assert.equal(provider.sample, undefined);
    assert.ok(provider.product.source.startsWith('https://'));
    assert.notEqual(new URL(provider.product.source).pathname, '/');
  }
});

test('匿名历史记录完整保留真实的测量时间、20次采样与延迟范围', () => {
  const expected = { lisahost: [157, 150, 202, 17], yinnet: [247.7, 230, 385, 18], lcayun: [363.9, 328, 466, 15] };
  for (const provider of VPS_PROVIDERS) {
    const record = provider.assessment;
    assert.equal(record.checkedAt, '2026-11-18T14:03:00Z');
    assert.equal(record.sent, 20);
    assert.deepEqual([record.averageMs, record.minMs, record.maxMs, record.received], expected[provider.id]);
    assert.equal(record.timeouts, record.sent - record.received);
  }
});

for (const locale of ['zh', 'en']) {
  test(`${locale} 弹窗显示三张匿名历史测评卡片及边界说明`, () => {
    const html = render(locale);
    assert.equal((html.match(/<article\b/g) ?? []).length, 3);
    assert.doesNotMatch(html, ipv4);
    assert.doesNotMatch(html, /<input\b|My IP|我的 IP|重新测评|Re-assess/);
    assert.doesNotMatch(html, /查看产品来源|View product source/);
    for (const url of ['https://lisahost.com/aff.php?aff=16697', 'https://www.yin-net.com/aff.php?aff=1149', 'https://www.lcayun.com/aff/OEDHHSXN']) {
      assert.ok(html.includes(`href="${url}"`), url);
    }
    assert.equal((html.match(/rel="noopener noreferrer sponsored"/g) ?? []).length, 3);
    assert.doesNotMatch(html, /推广链接|affiliate link/);
    assert.match(html, new RegExp(`<button type="button"[^>]*>${locale === 'zh' ? '导出搭建脚本' : 'Download setup script'}</button>`));
    assert.ok(html.includes(locale === 'zh' ? '自建节点推荐' : 'Self-host a node'));
    for (const value of ['157.0 ms', '247.7 ms', '363.9 ms', '17/20', '18/20', '15/20', 'AS2914', 'AS9848']) assert.ok(html.includes(value), value);
    assert.match(html, /aria-labelledby="vps-title"/);
    assert.match(html, /aria-describedby="vps-description"/);
    assert.ok(html.includes(locale === 'zh' ? '实测体验' : 'Test results'));
    assert.doesNotMatch(html, /历史测试摘要|Historical test summary/);
    assert.ok(html.includes(locale === 'zh' ? '不代表当前网络表现' : 'not current network performance'));
    assert.ok(html.includes(locale === 'zh' ? '未验证' : 'unverified'));
    assert.ok(html.includes('2026'));
  });
}
