/* eslint-disable @typescript-eslint/no-require-imports -- This CJS regression check intentionally installs an in-memory TypeScript loader. */
// Run without extra dependencies: transpile the real TS modules in memory.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const nativeResolve = Module._resolveFilename;
Module._resolveFilename = function(id, parent, ...rest) { return nativeResolve.call(this, id.startsWith('@/') ? path.join(root,'src',id.slice(2)) : id, parent, ...rest); };
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'), { compilerOptions: {module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020} }).outputText,filename);
const rules = require(path.join(root,'src/detection/signal-rules.ts'));
const {repairChoices,previewTotal,recommendedChoice} = require(path.join(root,'src/detection/repair-options.ts'));
const {buildExitTarget,windowsTimezoneFor,targetLanguageFor} = require(path.join(root,'src/detection/exit-geo.ts'));
const {collectBrowserSignals} = require(path.join(root,'src/detection/client-engine.ts'));
const {runDetection} = require(path.join(root,'src/detection/runner.ts'));
const {detectorLocaleText} = require(path.join(root,'src/detection/locale.ts'));
const text = detectorLocaleText.zh;

const {measurementStatus,measurementPoints} = require(path.join(root,'src/detection/measurement-status.ts'));
const measuredSample = {id:'language',value:'ko-KR',testedAt:'2026-10-24T00:00:00Z',assessment:'ok',contribution:0};
assert.equal(measurementStatus('language',measuredSample,{...measuredSample,assessment:'unknown'}),'pending','one measured side must not hide an unknown side');
assert.equal(measurementStatus('language',{...measuredSample,assessment:'not_applicable'},{...measuredSample,assessment:'not_applicable'}),'not_applicable','not applicable must not be labelled measured');
assert.equal(measurementStatus('language',measuredSample,{...measuredSample,assessment:'error'}),'error','failed side must stay visible');
assert.equal(measurementPoints('language',{...measuredSample,contribution:5},measuredSample),5,'gateway zero must not hide browser anomaly points');

assert.equal(rules.timezoneScore('Asia/Shanghai'),1);
assert.equal(rules.timezoneScore('Asia/Hong_Kong'),0.6);
assert.equal(rules.timezoneScore('Asia/Tokyo'),0);
assert.equal(rules.languageScore(['en-US','zh-CN']),1,'English first must not hide a remaining Chinese language');
assert.equal(rules.languageScore(['zh-HK']),0.5);
assert.equal(rules.variantScore(['zh-HK']),1,'Traditional Chinese still counts under the existing rule');
assert.equal(rules.fontScore(3,0),0.99);
assert.equal(rules.offsetScore(8),1);
assert.equal(rules.timezoneOffset('America/Los_Angeles',new Date('2026-01-01T12:00:00Z')),-8);
assert.equal(rules.timezoneOffset('America/Los_Angeles',new Date('2026-07-01T12:00:00Z')),-7);
assert.equal(rules.timezoneOffset('Asia/Kolkata'),5.5);
const originalDate = Date;
const originalDateTimeFormat = Intl.DateTimeFormat;
Intl.DateTimeFormat = function(...args) {
 const formatter = new originalDateTimeFormat(...args);
 if (!args.length) { const resolved = formatter.resolvedOptions.bind(formatter); formatter.resolvedOptions = () => ({...resolved(),timeZone:'Asia/Shanghai',locale:'zh-CN'}); }
 return formatter;
};
global.Date = class extends originalDate { getTimezoneOffset() {return -480;} };
// Deterministic canvas font availability to reproduce the user's seven red signals.
global.document = {createElement:()=>({getContext:()=>({font:'',measureText(){const matched= /Microsoft YaHei|Microsoft JhengHei|SimSun/.test(this.font);return {width:matched?130:100};}})})};
const browser = {languages:['zh-CN','en'],timezone:'Asia/Shanghai',locale:'zh-CN',userAgent:'Mozilla/5.0 Windows NT 10.0 Chrome/130',platform:'Win32',brands:'Chromium'};
Object.defineProperty(global,'navigator',{configurable:true,value:{...browser, language:'zh-CN', userAgentData:{brands:[{brand:'Chromium',version:'130'}],platform:'Windows'}}});
const sample = collectBrowserSignals('cn',text,undefined,browser).signals;
// 50-signal报告权重：26+5+12+16+4+3+2=68（vendorFonts 在报告里权重为 0）。
assert.equal(sample.reduce((sum,item)=>sum+item.contribution,0),68,'Browser-only fixture must match the 50-signal report weights');
const contributions = Object.fromEntries(sample.map(item=>[item.id,item.contribution]));
for(const id of ['timezone','language','languageVariant','chineseFonts','vendorFonts','domesticBrowser','domesticDevice','locale','timezoneOffset','emojiStyle']) {
 const choices = repairChoices({id,value:'fixture',contribution:contributions[id]});
 assert.ok(choices.length>1,id+' has options');
 assert.ok(choices.every((option,index)=>index===0||choices[index-1].contribution<=option.contribution),id+' sorted ascending');
 assert.ok(choices.every(option=>Number.isInteger(option.contribution)&&option.contribution>=0),id+' valid points');
}
const source = {id:'timezone',value:'Asia/Shanghai',contribution:26};
const target = repairChoices(source).find(item=>item.value==='Asia/Tokyo');
assert.equal(previewTotal(sample,target),39,'Timezone preview must update both timezone and UTC offset');
assert.equal(source.contribution,26,'Preview must not modify measured signal');
assert.equal(previewTotal(sample,repairChoices({id:'language',value:'zh-CN, en',contribution:5}).find(item=>item.value==='en-US')),51,'Language preview includes languageVariant');
assert.equal(repairChoices({id:'timezone',value:'Asia/Shanghai',contribution:26}).find(item=>item.value==='Asia/Hong_Kong').contribution,26,'HK Windows mapping cannot claim 16 if it applies China Standard Time');
assert.ok(repairChoices({id:'emojiStyle',value:'Windows Emoji 风格',contribution:2}).every(item=>item.contribution>0),'Do not invent zero-point Windows emoji fixes');
assert.equal(previewTotal([{id:'a',contribution:80},{id:'b',contribution:80}],{impacts:{a:0}}),80,'Compute from unclamped contributions before capping');
// Exit-region priority: a Seoul exit must offer Seoul first for every repairable signal.
const seoulGeo = {ip:'1.2.3.4',countryCode:'KR',countryName:'韩国',city:'首尔',cityRaw:'Seoul',regionName:'Seoul',timezone:'Asia/Seoul',asn:'AS1234',org:'Example',source:'test'};
const seoul = buildExitTarget(seoulGeo);
assert.equal(seoul.timezone,'Asia/Seoul');
assert.equal(seoul.windowsTimezone,'Korea Standard Time');
assert.equal(seoul.language,'ko-KR');
for(const id of ['timezone','timezoneOffset']) {
 const choices = repairChoices({id,value:'Asia/Shanghai',contribution:26},seoul);
 assert.equal(choices[0].value,'Asia/Seoul',id+' must put the exit timezone first');
 assert.equal(choices[0].match,'target');
}
for(const id of ['language','languageVariant']) {
 const choices = repairChoices({id,value:'zh-CN',contribution:20},seoul);
 assert.equal(choices[0].value,'ko-KR',id+' must put the exit language first');
}
assert.equal(repairChoices({id:'locale',value:'zh-CN',contribution:6},seoul)[0].value,'ko-KR','locale must put the exit language first');
assert.equal(recommendedChoice({id:'timezone',value:'Asia/Shanghai',contribution:26},seoul).windowsTimezone,'Korea Standard Time','one-click optimize must target the exit zone');
assert.equal(windowsTimezoneFor('Asia/Seoul'),'Korea Standard Time');
assert.equal(windowsTimezoneFor('Europe/Moscow'),'Russian Standard Time');
assert.equal(targetLanguageFor('JP'),'ja-JP');
assert.equal(repairChoices({id:'timezone',value:'x',contribution:26},seoul).filter(item=>item.value==='Asia/Seoul').length,1,'exit zone must not be duplicated');
// A mainland-China exit makes zh-CN and China Standard Time the highest-point choices: keep them labelled, never promoted.
const cn = buildExitTarget({ip:'1.1.1.1',countryCode:'CN',countryName:'中国',city:'苏州',cityRaw:'Suzhou',regionName:'Jiangsu',timezone:'Asia/Shanghai',asn:null,org:null,source:'test'});
const cnLocale = repairChoices({id:'locale',value:'zh-CN',contribution:6},cn);
assert.equal(cnLocale[0].contribution,Math.min(...cnLocale.map(item=>item.contribution)),'a higher-point exit target must not be promoted');
assert.ok(cnLocale.some(item=>item.match==='target'),'exit target is still labelled');
assert.equal(cn.timezone,'Asia/Shanghai','CN exit target timezone resolves');
assert.equal(repairChoices({id:'timezone',value:'x',contribution:26},cn)[0].match,'other','risk-scored exit zone must not be promoted as the fix');
assert.equal(repairChoices({id:'timezone',value:'x',contribution:26},cn).find(item=>item.match==='target').value,'Asia/Shanghai','risk-scored exit zone is still labelled');
runDetection({region:'cn',locale:'zh',text}).then(result=>{
 for(const signal of result.signals) assert.equal(signal.contribution,contributions[signal.id],signal.id+' plugin/engine rules agree');
 console.log('PASS: scoring, exit-region priority, option ordering, linked previews, DST, unchanged 85-point fixture, plugin consistency.');
}).catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{global.Date=originalDate;Intl.DateTimeFormat=originalDateTimeFormat;});

