/* eslint-disable @typescript-eslint/no-require-imports -- Exercise the real TypeScript with the existing compiler. */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const test = require('node:test');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const resolve = Module._resolveFilename;
Module._resolveFilename = function(id, parent, ...rest) { return resolve.call(this,id.startsWith('@/')?path.join(root,'src',id.slice(2)):id,parent,...rest); };
require.extensions['.ts'] = (module,filename) => module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,filename);
const {buildGatewayCheck} = require('../src/detection/gateway-check.ts');
const {claudeBrowserSignal,readClaudeBrowser} = require('../src/detection/claude-browser.ts');
const {verificationPoint,verificationLabel,verificationScores} = require('../src/detection/verification-score.ts');
const {signalConfig} = require('../src/detection/config/signals.ts');
const at='2026-11-01T10:00:00Z';
const report = (probe) => ({version:1,upstream:'https://api.anthropic.com/',platform:'darwin',profile:null,profileError:null,transport:'node-native-proxy',rewrites:0,previewHeaders:{},lastRequest:null,lastFailure:null,checkedAt:at,testedSignals:['claudeReachability'],probes:{claude:probe}});
const row = result => result.signals.find(item=>item.id==='claudeReachability');

test('gateway challenges, authentication and rate limits earn and lose no verification points',()=>{
  const all=Object.entries(signalConfig).filter(([,config])=>config.enabled).map(([id])=>({id,value:'ok',assessment:'ok',contribution:0,testedAt:at}));
  const baseline=verificationScores(all,all);
  for (const probe of [{status:403,challenge:true},{status:403},{status:401},{status:429}]) {
    const sample=row(buildGatewayCheck(report({...probe,elapsedMs:40}),'zh'));
    assert.equal(sample.assessment,'unknown');
    assert.equal(sample.unscored,true);
    assert.equal(sample.contribution,0);
    assert.equal(verificationPoint(sample),null);
    assert.equal(verificationLabel(sample,true),'无法判定 · 不计分');
    const score=verificationScores(all,all.map(item=>item.id===sample.id?sample:item));
    assert.equal(score.coverage.claude.maximum,baseline.coverage.claude.maximum-6);
    if(probe.challenge) assert.match(sample.value,/Cloudflare/);
    else assert.doesNotMatch(sample.value,/Cloudflare/);
  }
  const failed=row(buildGatewayCheck(report({status:null,error:'ENOTFOUND',failureKind:'dns',elapsedMs:1}),'zh'));
  assert.equal(verificationPoint(failed),0);
  assert.match(failed.value,/域名解析失败/);
});

test('managed browser evidence scores website access without claiming successful messages',()=>{
  for (const state of ['challenge','loading','unavailable','route_changed','access_denied','rate_limited']) {
    const sample=claudeBrowserSignal({state,checkedAt:at,status:state==='challenge'?403:null},'zh');
    assert.equal(verificationPoint(sample),null,state);
    assert.equal(sample.assessment,'unknown');
  }
  for (const state of ['login_page','app_ready','page_loaded']) {
    const sample=claudeBrowserSignal({state,checkedAt:at,status:200},'zh');
    assert.equal(verificationPoint(sample),6,state);
    assert.match(sample.value,/未验证/);
  }
  assert.equal(verificationPoint(claudeBrowserSignal({state:'network_error',checkedAt:at},'zh')),0);
});

test('read-only browser checks never obtain a session token or request a browser launch',async()=>{
  const original=global.fetch;
  const calls=[];
  global.fetch=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({state:'challenge',checkedAt:at,status:403})};};
  try {
    assert.equal((await readClaudeBrowser()).state,'challenge');
    assert.equal(calls.length,1);
    assert.ok(calls[0].url.endsWith('/claude-browser'));
    assert.equal(calls[0].options.method,'GET');
    assert.equal(calls[0].options.body,undefined);
    global.fetch=async()=>({ok:true,json:async()=>({state:'invented',checkedAt:at})});
    await assert.rejects(readClaudeBrowser(),/需要更新/);
  } finally {global.fetch=original;}
});
