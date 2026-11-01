/* eslint-disable @typescript-eslint/no-require-imports -- Exercise the real TS modules without a test dependency. */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const test = require('node:test');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const nativeResolve = Module._resolveFilename;
Module._resolveFilename = function(id, parent, ...rest) { return nativeResolve.call(this, id.startsWith('@/') ? path.join(root, 'src', id.slice(2)) : id, parent, ...rest); };
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, filename);
require.extensions['.css'] = () => {};
const { probeEmojiRendering, emojiRenderingSignal, EMOJI_SAMPLES } = require('../src/detection/emoji-rendering.ts');

function renderer(t, { style = 'apple', available = { 'Apple Color Emoji': 'apple' }, blocked = false, unstable = false, monochrome = false, missing = false, fontApi = true, combined = true } = {}) {
  const globals = ['document', 'FontFace', 'getComputedStyle'].map(key => [key, Object.getOwnPropertyDescriptor(global, key)]);
  t.after(() => { for (const [key, descriptor] of globals) { if (descriptor) Object.defineProperty(global, key, descriptor); else delete global[key]; } });
  const fonts = new Map();
  let readCount = 0, text = '';
  const context = {
    font: '', clearRect() {}, fillText(value) { text = value; },
    measureText(value) { return { width: missing && EMOJI_SAMPLES.includes(value) ? 48 : ['👩💻', '🏳️🌈'].includes(value) || !combined && value.includes('\u200d') ? 96 : value ? 48 : 0 }; },
    getImageData() {
      if (blocked) throw new Error('pixel access denied');
      const data = new Uint8ClampedArray(256 * 96 * 4);
      if (!text) return { data };
      const alias = this.font.match(/"(envguard_emoji_[^"]+)"/)?.[1];
      let actual = alias ? fonts.get(alias) : style;
      if (actual === 'no-glyphs') actual = 'trap';
      const painted = missing && EMOJI_SAMPLES.includes(text) || /[\uffff]|\u{10ffff}/u.test(text) ? 'missing' : !combined ? text.replaceAll('\u200d', '') : text;
      let seed = [...painted + actual].reduce((sum, char) => sum + char.codePointAt(0), 0) % 400;
      if (unstable) seed += ++readCount;
      for (let index = seed; index < seed + 8; index++) {
        data[index * 4] = actual === 'trap' || monochrome ? 0 : 200;
        data[index * 4 + 1] = 0; data[index * 4 + 2] = 0; data[index * 4 + 3] = 255;
      }
      return { data };
    },
  };
  global.document = { body: {}, createElement: () => ({ getContext: () => context }), fonts: { add(face) { fonts.set(face.family, face.style); }, delete(face) { return fonts.delete(face.family); } } };
  global.getComputedStyle = () => ({ fontFamily: 'sans-serif' });
  if (fontApi) global.FontFace = class {
    constructor(family, source) { this.family = family; this.style = source.startsWith('url(') ? 'trap' : available[source.match(/local\("(.+)"\)/)?.[1]]; }
    load() { return this.style ? Promise.resolve(this) : Promise.reject(new Error('font unavailable')); }
  }; else delete global.FontFace;
  return fonts;
}

test('measured Apple pixels remain Apple when the UA claims Windows; temporary fonts are cleaned up', async t => {
  const fonts = renderer(t);
  const result = await probeEmojiRendering('Mozilla Windows NT 10.0');
  assert.equal(result.matchedFont, 'Apple Color Emoji');
  assert.equal(result.declaredSystem, 'Windows');
  assert.equal(result.consistency, 'different');
  assert.equal(result.samples.filter(sample => sample.colored).length, 6);
  assert.equal(result.samples.filter(sample => sample.combined).length, 2);
  assert.equal(fonts.size, 0);
  const sample = emojiRenderingSignal(result, 'Emoji', true);
  assert.equal(sample.contribution, 0); assert.equal(sample.unscored, true);
});

test('an absent reference or a loaded font with no emoji glyphs cannot match through system fallback', async t => {
  renderer(t, { available: { 'Segoe UI Emoji': 'no-glyphs' } });
  const result = await probeEmojiRendering('Mac OS');
  assert.equal(result.matchedFont, null);
  assert.equal(result.fonts.find(font => font.name === 'Apple Color Emoji').available, false);
  assert.equal(result.fonts.find(font => font.name === 'Segoe UI Emoji').matches, 0);
  assert.equal(result.state, 'sampled');
});

test('indistinguishable reference fonts remain unclassified', async t => {
  renderer(t, { available: { 'Apple Color Emoji': 'apple', 'Noto Color Emoji': 'apple' } });
  const result = await probeEmojiRendering('Mac OS');
  assert.equal(result.matchedFont, null);
  assert.equal(result.consistency, 'unknown');
});

test('blocked or unstable pixels never fall back to UA classification', async t => {
  renderer(t, { blocked: true });
  const result = await probeEmojiRendering('Mac OS');
  assert.equal(result.state, 'unavailable'); assert.equal(result.matchedFont, null);
  assert.equal(emojiRenderingSignal(result, 'Emoji', true).assessment, 'unknown');
});

test('repeated pixel readback must be stable', async t => {
  renderer(t, { unstable: true });
  const result = await probeEmojiRendering('Mac OS');
  assert.equal(result.state, 'unavailable'); assert.equal(result.reason, 'unstable');
});

test('missing glyphs and unjoined sequences remain visible in the evidence', async t => {
  renderer(t, { missing: true, combined: false });
  const result = await probeEmojiRendering('Mac OS');
  assert.equal(result.samples.filter(sample => sample.rendered).length, 0);
  assert.equal(result.matchedFont, null);
});

test('monochrome rendering and lack of local-font access do not invent a style or risk', async t => {
  renderer(t, { monochrome: true, fontApi: false, combined: false });
  const result = await probeEmojiRendering('Mac OS');
  assert.equal(result.state, 'sampled'); assert.equal(result.matchedFont, null);
  assert.equal(result.samples.filter(sample => sample.colored).length, 0);
  assert.equal(result.samples.filter(sample => sample.combined === false).length, 2);
});

test('both detection entry points return pixel evidence; informational results and stale legacy points cannot affect scores', async t => {
  renderer(t);
  const { detectorLocaleText } = require('../src/detection/locale.ts');
  const { detectionConfig } = require('../src/detection/config/index.ts');
  const { emojiStylePlugin } = require('../src/detection/plugins/emoji-style.ts');
  const { runBrowserScan } = require('../src/detection/browser-scan.ts');
  const context = { browser: { userAgent: 'Windows' }, text: detectorLocaleText.zh, locale: 'zh', region: 'auto', config: detectionConfig };
  const [sample] = await emojiStylePlugin.run(context);
  const scan = await runBrowserScan('auto', 'zh', detectorLocaleText.zh, 'emojiStyle');
  assert.equal(scan.signals.length, 1); assert.equal(scan.signals[0].emojiRendering.matchedFont, sample.emojiRendering.matchedFont);
  const { verificationScores, verificationPoint, verificationLabel } = require('../src/detection/verification-score.ts');
  const { measurementContribution, measurementAbnormal } = require('../src/detection/measurement-status.ts');
  const { cardEvidence } = require('../src/detection/card-evidence.ts');
  const stale = { ...sample, contribution: 2, assessment: 'warning', unscored: undefined };
  assert.equal(verificationPoint(sample), null); assert.equal(verificationPoint(stale), null);
  assert.equal(measurementContribution(stale), 0); assert.equal(measurementAbnormal(stale), false);
  assert.equal(cardEvidence('emojiStyle', stale).state, 'informational');
  assert.deepEqual(verificationScores([stale], []), verificationScores([], []));
  assert.match(verificationLabel(sample, true), /仅供参考/);
  assert.equal(verificationLabel({ ...sample, assessment: 'not_applicable' }, true), '不适用');
  const { repairChoices } = require('../src/detection/repair-options.ts');
  assert.deepEqual(repairChoices(sample), []);
});

test('the dialog shows measured evidence without legacy risk points, pass claims or fake OS repair choices', async t => {
  renderer(t);
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { RepairDialog } = require('../src/components/detector/RepairDialog.tsx');
  const sample = emojiRenderingSignal(await probeEmojiRendering('Mac OS'), 'Emoji 渲染风格', true);
  const html = renderToStaticMarkup(React.createElement(RepairDialog, { signal: sample, browser: sample, signals: [sample], locale: 'zh', loading: false, onClose() {}, async onRecheck() {}, async onApplyGateway() {}, onBrowserSample() {} }));
  assert.match(html, /实际像素样本/); assert.match(html, /6\/6 组像素匹配/); assert.match(html, /已采样 · 仅供参考/);
  assert.doesNotMatch(html, /风险 \+|Windows \/ Android 计|name="repair-choice"|未达标/);
});
