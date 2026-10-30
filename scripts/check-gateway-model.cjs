/* eslint-disable @typescript-eslint/no-require-imports -- Load real TypeScript without a new test dependency. */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const test = require('node:test');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const nativeResolve = Module._resolveFilename;
Module._resolveFilename = function(id, parent, ...rest) { return nativeResolve.call(this, id.startsWith('@/') ? path.join(root,'src',id.slice(2)) : id, parent, ...rest); };
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,filename);
require.extensions['.tsx'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText,filename);
const {buildGatewayCheck} = require(path.join(root,'src/detection/gateway-check.ts'));
const {signalConfig} = require(path.join(root,'src/detection/config/signals.ts'));
const fixtures = () => ({
  version:1,upstream:'https://api.anthropic.com/',platform:'win32',profileError:null,
  profile:{language:'ko-KR',locale:'ko-KR',timezone:'Asia/Seoul',updatedAt:'new'},
  previewHeaders:{'accept-language':'ko-KR,ko;q=0.9,en;q=0.5','x-checkcc-target-locale':'ko-KR'},
  transport:'node-native-direct',proxyEnvironmentDetected:false,rewrites:0,lastRequest:null,lastFailure:null,
  cloak:{enabled:true,updatedAt:'2026-10-23T00:00:00Z'},
  probes:{api:{status:401,elapsedMs:20,tls:{authorized:true,protocol:'TLSv1.3'}},claude:{status:403,elapsedMs:10},anthropic:{status:200,elapsedMs:10}},
  dns:{hostname:'api.anthropic.com',addresses:[{address:'1.2.3.4',family:4}],resolvers:['127.0.0.1'],error:null},
  exit:{primary:{source:'test',ip:'1.2.3.4',countryCode:'KR',city:'Seoul',regionName:'Seoul',timezone:'Asia/Seoul',asn:'AS1',org:'Example'},sources:[{source:'test',countryCode:'KR'}],ipv4:'1.2.3.4',ipv6:null,consistentCountry:null,ipv6Error:'ENETUNREACH'},
});
const index = result => Object.fromEntries(result.signals.map(signal=>[signal.id,signal]));

test('49 enabled signals exclude the removed API check; offline and non-applicable are not passes',()=>{
  assert.equal(Object.values(signalConfig).filter(config=>config.enabled).length,49);
  const result = buildGatewayCheck(null,'zh','offline');
  const signals = index(result);
  assert.equal(result.signals.length,49);
  assert.equal(signals.apiReachability,undefined);
  assert.equal(signals.claudeReachability.assessment,'unknown');
  assert.equal(signals.country.assessment,'unknown');
  assert.equal(signals.webrtcLeak.assessment,'not_applicable');
  assert.equal(signals.chineseFonts.assessment,'not_applicable');
  assert.equal(result.signals.reduce((sum,signal)=>sum+signal.contribution,0),0);
  assert.equal(result.verifiedRequest,false);
});

test('previews, HTTP 401/403 and DNS resolution do not manufacture successful Claude requests',()=>{
  const result = buildGatewayCheck(fixtures(),'zh');
  const signals = index(result);
  assert.equal(signals.language.assessment,'unknown');
  assert.equal(signals.requestHeaders.assessment,'unknown');
  assert.equal(signals.apiReachability,undefined);
  assert.equal(signals.dnsReview.assessment,'unknown');
  assert.equal(signals.proxyCountry.assessment,'unknown');
  assert.equal(signals.ipv4.assessment,'ok');
  assert.equal(result.verifiedRequest,false);
  assert.equal(result.geo.countryCode,'KR');
});

test('HTTP redirects finish reachability checks without claiming final-page or account access',()=>{
  const {signalScoreLabel}=require(path.join(root,'src/detection/card-evidence.ts'));
  for (const status of [200,301,302,307,308,401,403,429,503]) {
    const report=fixtures();
    for (const name of ['claude','anthropic','api']) report.probes[name]={status,elapsedMs:257};
    const result=buildGatewayCheck(report,'zh');
    const rows=index(result);
    for (const id of ['claudeReachability','anthropicReachability']) {
      assert.equal(rows[id].assessment,status>=400?'warning':'ok');
      assert.equal(signalScoreLabel(rows[id],true),'0');
      assert.match(rows[id].value,new RegExp(`HTTP ${status}`));
      assert.match(rows[id].detail,/未验证最终页面/);
      if (status>=300 && status<400) assert.match(rows[id].value,/网络可达/);
    }
    assert.equal(result.verifiedRequest,false);
  }
  const report=fixtures();
  report.probes.claude={status:null,elapsedMs:50,error:'ECONNRESET'};
  const failed=index(buildGatewayCheck(report,'zh')).claudeReachability;
  assert.equal(failed.assessment,'error');
  assert.equal(signalScoreLabel(failed,true),'测试失败');
});

test('opaque browser reachability never invents an HTTP status and failures stay independent',async()=>{
  const {collectBrowserReachability}=require(path.join(root,'src/detection/browser-probes.ts'));
  const originalFetch=global.fetch;
  try {
    const requestedUrls=[];
    global.fetch=async (url,options)=>{
      requestedUrls.push(url);
      assert.equal(options.redirect,'follow');
      assert.equal(options.mode,'no-cors');
      assert.equal(options.credentials,'omit');
      return {type:'opaque',status:0};
    };
    const result=await collectBrowserReachability();
    assert.equal(requestedUrls.length,2);
    assert.ok(requestedUrls.every(url=>!url.includes('api.anthropic.com')));
    assert.equal(result.api,undefined);
    for (const sample of Object.values(result)) {
      assert.equal(sample.ok,true);
      assert.equal(sample.status,null);
    }
    global.fetch=async()=>{throw new TypeError('Failed to fetch');};
    const failed=await collectBrowserReachability();
    assert.equal(failed.claude.ok,false);
    assert.equal(failed.claude.error,'TypeError');
    const {runBrowserScan}=require(path.join(root,'src/detection/browser-scan.ts'));
    const {detectorLocaleText}=require(path.join(root,'src/detection/locale.ts'));
    const scan=await runBrowserScan('auto','zh',detectorLocaleText.zh,'claudeReachability');
    assert.equal(scan.signals[0].assessment,'unknown');
    assert.equal(scan.signals[0].observation,'inconclusive');
    assert.equal(scan.signals[0].contribution,0);
    assert.match(scan.signals[0].value,/跨站探测未完成/);
    assert.match(scan.signals[0].detail,/即使网站可以正常打开/);
  } finally {global.fetch=originalFetch;}
});

test('WebRTC 单项修复使用中继限制，复测会刷新整组历史结果',async()=>{
  const {choiceRuntimePolicy}=require(path.join(root,'src/detection/environment-actions.ts'));
  assert.deepEqual(choiceRuntimePolicy('webrtcLeak',{id:'disabled',value:'禁用 WebRTC',action:'information'}),{webrtcDisabled:false,webrtcRelayOnly:true});
  const probes=require(path.join(root,'src/detection/browser-probes.ts'));
  const original=probes.probeWebrtc, originalIp=probes.collectBrowserIpIntel;
  let sampledIp=false;
  try {
    probes.probeWebrtc=async()=>({supported:true,candidates:0,publicIps:[],hostCount:0,srflxCount:0,mdnsCount:0,error:null});
    probes.collectBrowserIpIntel=async()=>{sampledIp=true;return null;};
    const {runBrowserScan}=require(path.join(root,'src/detection/browser-scan.ts'));
    const {detectorLocaleText}=require(path.join(root,'src/detection/locale.ts'));
    const scan=await runBrowserScan('auto','zh',detectorLocaleText.zh,'webrtcLeak');
    assert.equal(sampledIp,true);
    assert.equal(scan.signals.length,7);
    for(const sample of scan.signals) {
      assert.ok(sample.id.startsWith('webrtc'));
      assert.notEqual(sample.assessment,'not_applicable',sample.id);
      assert.ok(sample.testedAt,sample.id);
    }
  } finally {probes.probeWebrtc=original;probes.collectBrowserIpIntel=originalIp;}
});

test('browser script failures do not become reachability or aggregate access-risk points',async()=>{
  const probes=require(path.join(root,'src/detection/browser-probes.ts'));
  const {runBrowserScan}=require(path.join(root,'src/detection/browser-scan.ts'));
  const {detectorLocaleText}=require(path.join(root,'src/detection/locale.ts'));
  const {signalScoreLabel}=require(path.join(root,'src/detection/card-evidence.ts'));
  const originalIp=probes.collectBrowserIpIntel,originalReach=probes.collectBrowserReachability;
  let country='KR',failure='TypeError';
  probes.collectBrowserIpIntel=async()=>({primary:{countryCode:country,countryName:country,org:'Example'},sources:[],okSources:[],countries:[country],ipv4:null,ipv6:null,consistentCountry:null});
  probes.collectBrowserReachability=async()=>Object.fromEntries(['claude','anthropic','api'].map(name=>[name,{ok:!failure,error:failure,status:null,elapsedMs:40}]));
  try {
    const report=fixtures(); report.probes.claude={status:302,elapsedMs:179};
    const gateway=index(buildGatewayCheck(report,'zh')).claudeReachability;
    for(const error of ['TypeError','TimeoutError','AbortError']) {
      failure=error;
      const reach=(await runBrowserScan('auto','zh',detectorLocaleText.zh,'claudeReachability')).signals[0];
      const risk=(await runBrowserScan('auto','zh',detectorLocaleText.zh,'claudeAccessRisk')).signals[0];
      for(const sample of [reach,risk]) {
        assert.equal(sample.assessment,'unknown'); assert.equal(sample.observation,'inconclusive');
        assert.equal(sample.contribution,0); assert.equal(signalScoreLabel(sample,true),'无法判定');
      }
      const html=renderCard(reach,null,{browser:reach,claude:gateway});
      assert.match(html,/data-signal-state="pending"/);
      assert.match(html,/无法判定/);
      assert.match(html,/HTTP 302/);
      assert.doesNotMatch(html,/测试失败|网关改写后通过|适用侧均通过/);
    }
    country='CN';
    const actualRisk=(await runBrowserScan('auto','zh',detectorLocaleText.zh,'claudeAccessRisk')).signals[0];
    assert.equal(actualRisk.assessment,'error'); assert.ok(actualRisk.contribution>0); assert.match(actualRisk.value,/出口命中风险国家/);
    country='KR'; failure=null;
    const pass=(await runBrowserScan('auto','zh',detectorLocaleText.zh,'claudeAccessRisk')).signals[0];
    assert.equal(pass.assessment,'ok'); assert.equal(pass.contribution,0);
    const {RepairDialog}=require(path.join(root,'src/components/detector/RepairDialog.tsx'));
    const html=renderToStaticMarkup(React.createElement(RepairDialog,{signal:gateway,claude:gateway,signals:[gateway],locale:'zh',loading:false,onClose:()=>{},onRecheck:async()=>{},onApplyGateway:async()=>{}}));
    assert.match(html,/重新检测/);
    assert.match(html,/打开网站人工核对/);
  } finally {probes.collectBrowserIpIntel=originalIp;probes.collectBrowserReachability=originalReach;}
});

test('observed headers use real rule scores and changed profiles require new traffic',()=>{
  const report = fixtures();
  report.lastRequest={profileUpdatedAt:'new',startedAt:'2026-10-23T00:00:00Z',status:200,elapsedMs:19,headers:{'accept-language':'zh-CN,zh;q=0.9','x-checkcc-target-locale':'zh-CN'},originalHeaders:{'accept-language':'zh-CN,zh;q=0.9'},tls:{authorized:true,protocol:'TLSv1.3'}};
  let result=buildGatewayCheck(report,'zh');
  const signals=index(result);
  assert.equal(signals.language.contribution,5);
  assert.equal(signals.languageVariant.contribution,12);
  assert.equal(signals.locale.contribution,4);
  assert.equal(signals.timezone.contribution,0);
  assert.equal(signals.chineseFonts.contribution,0);
  assert.equal(result.verifiedRequest,true);
  assert.equal(signals.gatewayProfile.assessment,'ok');
  report.profile.updatedAt='newer';
  result=buildGatewayCheck(report,'zh');
  assert.equal(result.verifiedRequest,false);
  assert.equal(index(result).language.assessment,'unknown');
  report.lastFailure={at:'2026-10-23T01:00:00Z',error:'ECONNRESET'};
  assert.equal(index(buildGatewayCheck(report,'en')).claudeTrigger.assessment,'error');
});

test('cloak state is surfaced and rewritten headers are flagged',()=>{
  const report = fixtures();
  report.lastRequest={profileUpdatedAt:'new',startedAt:'2026-10-23T00:00:00Z',status:200,elapsedMs:19,headers:{'accept-language':'ko-KR,ko;q=0.9,en;q=0.5','x-checkcc-target-locale':'ko-KR'},originalHeaders:{'accept-language':'zh-CN,zh;q=0.9'},tls:null};
  const on = buildGatewayCheck(report,'zh');
  assert.equal(on.cloak.enabled,true);
  assert.equal(index(on).language.cloaked,true);
  assert.equal(index(on).httpLanguage.cloaked,true);
  report.cloak={enabled:false,updatedAt:'2026-10-23T02:00:00Z'};
  const off = buildGatewayCheck(report,'zh');
  assert.equal(off.cloak.enabled,false);
  assert.equal(index(off).language.cloaked,false);
});

const {environmentScores, comparisonEvidence} = require(path.join(root,'src/detection/environment-evidence.ts'));
test('environment scores keep both sources separate and deduplicate each shared signal',()=>{
  const browser=[{id:'language',value:'zh-CN',contribution:12},{id:'chineseFonts',value:'Chinese fonts',contribution:16}];
  const claude=[{id:'language',value:'ko-KR',contribution:6},{id:'country',value:'KR',contribution:5}];
  assert.deepEqual(environmentScores(browser,claude),{browser:28,claude:11,combined:33});
  assert.deepEqual(environmentScores([{id:'language',contribution:93}],[{id:'language',contribution:0}]),{browser:93,claude:null,combined:93});
  assert.deepEqual(environmentScores(null,null),{browser:null,claude:null,combined:null});
  assert.deepEqual(environmentScores(browser,null),{browser:28,claude:null,combined:28});
  assert.deepEqual(environmentScores([{id:'language',contribution:90},{id:'chineseFonts',contribution:50}],[]),{browser:100,claude:null,combined:100});
});
test('zero requires completed applicable scoring samples, not just a gateway report',()=>{
  const pending = buildGatewayCheck(fixtures(), 'zh').signals;
  assert.equal(environmentScores(null, pending).claude, null);
  assert.deepEqual(environmentScores([], []), {browser:null,claude:null,combined:null});
  const passed = Object.entries(signalConfig).map(([id]) => ({id, value:'measured', testedAt:'2026-10-24T00:00:00Z', assessment:'ok', contribution:0}));
  assert.deepEqual(environmentScores(passed, passed), {browser:0,claude:0,combined:0});
  assert.deepEqual(environmentScores(passed, pending), {browser:0,claude:null,combined:null});
  assert.deepEqual(environmentScores(passed, null), {browser:0,claude:null,combined:null});
  for (const assessment of ['unknown', 'error']) {
    assert.equal(environmentScores(null, passed.map(s => s.id === 'language' ? {...s,assessment} : s)).claude, null);
  }
  assert.equal(environmentScores(null, passed.map(s => s.id === 'language' ? {...s,testedAt:undefined} : s)).claude, null);
  assert.equal(environmentScores(null, passed.map(s => s.id === 'language' ? {...s,assessment:'not_applicable',testedAt:undefined,value:null} : s)).claude, 0);
  assert.equal(environmentScores(null, pending.map(s => s.id === 'country' ? {...s,contribution:18,assessment:'warning'} : s)).claude, 18);
});
test('unknown and inapplicable samples are not differences or verified passes',()=>{
  const sampled={id:'language',value:'zh-CN',assessment:'ok'};
  assert.equal(comparisonEvidence(sampled,{...sampled,value:'Awaiting request',assessment:'unknown'}),'unknown');
  assert.equal(comparisonEvidence(sampled,{...sampled,value:'Not applicable',assessment:'not_applicable'}),'not_applicable');
  assert.equal(comparisonEvidence(sampled,{...sampled,value:'HTTP error',assessment:'error'}),'unknown');
  assert.equal(comparisonEvidence(sampled,undefined),'unknown');
  assert.equal(comparisonEvidence({...sampled,value:'未知'},sampled,['未知']),'unknown');
  assert.equal(comparisonEvidence({...sampled,value:'Not measured'},sampled,['Not measured']),'unknown');
  assert.equal(comparisonEvidence(sampled,{...sampled,value:'ko-KR',cloaked:true}),'rewritten');
  assert.equal(comparisonEvidence(sampled,{...sampled}),'same');
  assert.equal(comparisonEvidence(sampled,{...sampled,value:'ko-KR'}),'different');
});

const {signalOptimization, verifiedOptimization} = require(path.join(root,'src/detection/environment-evidence.ts'));
test('optimization badges require flagged browser evidence and a successful current rewritten request',()=>{
  const browser={id:'language',value:'zh-CN',contribution:12,assessment:'warning'};
  const claude={...browser,value:'ko-KR',contribution:0,assessment:'ok',cloaked:true};
  assert.equal(signalOptimization(browser,claude,true,true),'optimized');
  assert.equal(signalOptimization(browser,claude,true,false),'pending');
  assert.notEqual(signalOptimization(browser,claude,false,true),'optimized');
  assert.equal(signalOptimization(browser,{...claude,cloaked:false},true,true),'unattributed');
  assert.equal(signalOptimization(browser,{...claude,assessment:'not_applicable'},true,true),'not_applicable');
  assert.equal(signalOptimization(browser,{...claude,contribution:5,assessment:'warning'},true,true),'not_improved');
  assert.equal(signalOptimization({...browser,contribution:0},claude,true,true),'none');
  assert.notEqual(signalOptimization({...browser,id:'httpLanguage'},claude,true,true),'optimized');
});
test('old traffic and failed requests cannot verify a newly changed optimization',()=>{
  const live={enabled:true,updatedAt:'2026-10-23T00:00:00Z',target:{updatedAt:'profile-one'}};
  const check={verifiedRequest:true,cloak:live,report:{lastRequest:{startedAt:'2026-10-23T00:00:01Z',profileUpdatedAt:'profile-one'}}};
  assert.equal(verifiedOptimization(check,live),true);
  assert.equal(verifiedOptimization({...check,verifiedRequest:false},live),false);
  assert.equal(verifiedOptimization(check,{...live,enabled:false}),false);
  assert.equal(verifiedOptimization(check,{...live,updatedAt:'2026-10-23T00:01:00Z'}),false);
  assert.equal(verifiedOptimization(check,{...live,target:{updatedAt:'profile-two'}}),false);
  assert.equal(verifiedOptimization(check,{...live,target:null}),false);
  assert.equal(verifiedOptimization({...check,report:{lastRequest:{startedAt:'2026-10-22T23:59:59Z'}}},live),false);
});
test('rewriting language alone must not mark an unchanged locale as optimized',()=>{
  const report=fixtures();
  report.lastRequest={profileUpdatedAt:'new',startedAt:'2026-10-23T00:00:01Z',status:200,elapsedMs:19,headers:{'accept-language':'ko-KR,ko;q=0.9,en;q=0.5','x-checkcc-target-locale':'ko-KR'},originalHeaders:{'accept-language':'zh-CN','x-checkcc-target-locale':'ko-KR'},tls:null};
  const rows=index(buildGatewayCheck(report,'zh'));
  assert.equal(rows.language.cloaked,true);
  assert.equal(rows.languageVariant.cloaked,true);
  assert.equal(rows.locale.cloaked,false);
});

const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const {SignalCard} = require(path.join(root,'src/components/detector/SignalCard.tsx'));
const {EnvironmentScores} = require(path.join(root,'src/components/detector/EnvironmentScores.tsx'));
const {SimulationPanel} = require(path.join(root,'src/components/detector/SimulationPanel.tsx'));
const {signalPolicy, clientCoverage} = require(path.join(root,'src/detection/signal-policy.ts'));
const {simulationSignals, currentSimulation} = require(path.join(root,'src/detection/simulation-evidence.ts'));
const renderCard = (signal, job = null, extra = {}) => renderToStaticMarkup(React.createElement(SignalCard, {
  signal: {...signal, state:'done'}, job, simulationBusy:false, locale:'zh', checking:false, detailLabel:'查看详情与选项', onSelect:()=>{}, ...extra,
}));
const passedJob = {messageProbe:{viaLiveGateway:true,status:200,bodyUnchanged:true},version:1,kind:'local-simulation-only',state:'passed',scenarios:[],signalResults:{language:{state:'passed',completed:1,total:1,failed:0}}};

test('dual cards show independent scores, applicable icons and current source values',()=>{
  const signal={...index(buildGatewayCheck(fixtures(),'zh')).language,value:'ko-KR,ko;q=0.9',assessment:'ok',contribution:0,cloaked:true,testedAt:'2026-10-24T00:00:00Z'};
  const browser={...signal,source:'browser',environment:'browser',value:'zh-CN',contribution:12,cloaked:false};
  const html=renderCard(signal,passedJob,{browser,claude:signal,onTest:async()=>{}});
  assert.match(html,/data-score-side="browser"[^>]*>0</);
  assert.match(html,/data-score-side="claude"[^>]*>\+20</);
  assert.match(html,/aria-label="浏览器"/);
  assert.match(html,/aria-label="客户端"/);
  assert.match(html,/data-signal-state="flagged"/);
  assert.match(html,/data-environment="browser">[\s\S]*?<p title="浏览器：zh-CN"/);
  assert.match(html,/data-environment="client">[\s\S]*?<p title="客户端：ko-KR/);
  assert.ok(html.indexOf('aria-label="浏览器"') < html.indexOf('data-score-side="browser"'));
  assert.doesNotMatch(html,/处理目标|已达到目标|原始 \/ 保护后/);

  assert.match(html,/<article/);
  assert.equal((html.match(/<button/g)||[]).length,1);
});

test('card pass colors require real values on every applicable side',()=>{
  const signal={...index(buildGatewayCheck(fixtures(),'zh')).language,value:'ko-KR',assessment:'ok',contribution:0,cloaked:false,testedAt:'2026-10-24T00:00:00Z'};
  const browser={...signal,source:'browser',environment:'browser'};
  assert.match(renderCard(signal,null,{browser,claude:signal}),/data-signal-state="measured"/);
  assert.match(renderCard({...signal,contribution:5},null,{browser:{...browser,contribution:12}}),/data-signal-state="flagged"/);
  assert.match(renderCard(signal,null,{browser:{...browser,contribution:12},claude:signal}),/data-signal-state="flagged"/);
  const unknown={...signal,assessment:'unknown',value:'等待真实 Claude 请求'};
  const pending=renderCard(unknown,passedJob,{browser});
  assert.match(pending,/data-signal-state="pending"/);
  assert.doesNotMatch(pending,/data-score-side="claude"[^>]*>0<|等待真实/);
  const font={...signal,id:'chineseFonts',source:'browser',value:'No Chinese fonts'};
  const onlyBrowser=renderCard(font,null,{browser:font});
  assert.match(onlyBrowser,/data-score-side="browser"/);
  assert.doesNotMatch(onlyBrowser,/data-score-side="claude"|aria-label="Claude 客户端"/);
  assert.equal((onlyBrowser.match(/<button/g)||[]).length,1);
});

test('gateway zero score is green independently of simulation progress, with accurate status text',()=>{
  const render=(claude,simulationState)=>renderToStaticMarkup(React.createElement(EnvironmentScores,{browser:93,claude,combined:93,claudeAttempted:true,simulationState,locale:'zh'}));
  for(const state of ['idle','running','passed','failed','stale','unknown']) {
    const html=render(0,state);
    assert.match(html,/data-environment="claude" data-severity="measured"/);
    assert.doesNotMatch(html,/真实请求未验证/);
  }
  assert.match(render(0,'passed'),/模拟请求已通过/);
  assert.match(render(0,'failed'),/模拟请求未通过/);
  assert.match(render(null,'passed'),/data-environment="claude" data-severity="pending"/);
  assert.match(render(null,'passed'),/网关未连接/);
});

test('simulation summary reports actual outcome without a real-request validation requirement',()=>{
  const html=renderToStaticMarkup(React.createElement(SimulationPanel,{job:passedJob,busy:false,error:'',locale:'zh'}));
  assert.match(html,/模拟请求已通过/);
  assert.doesNotMatch(html,/真实请求已验证|真实请求未验证/);
  const failed=renderToStaticMarkup(React.createElement(SimulationPanel,{job:{...passedJob,state:'failed'},busy:false,error:'',locale:'zh'}));
  assert.match(failed,/模拟请求未通过/);
});

test('all client risk rules have a treatment and cards label browser/shared/client scope',()=>{
  for(const [id,config] of Object.entries(signalConfig)) {
    if(config.environment!=='browser' && config.weight>0) assert.ok(['gateway','network'].includes(signalPolicy(id).treatment),id);
  }
  const signals=index(buildGatewayCheck(fixtures(),'zh'));
  assert.match(renderCard(signals.chineseFonts),/data-signal-scope="browser"/);
  assert.match(renderCard(signals.language),/data-signal-scope="both"/);
  assert.match(renderCard(signals.proxyCountry),/data-signal-scope="claude"/);
  assert.equal(signalPolicy('timezone').scope,'browser');
  assert.equal(signalPolicy('timezoneOffset').scope,'browser');
  assert.equal(signalPolicy('ipCountryRisk').treatment,'network');
  const coverage=clientCoverage(Object.values(signals));
  assert.equal(coverage.total,Object.values(signalConfig).filter(c=>c.enabled&&c.environment!=='browser').length);
  assert.ok(coverage.unknown.some(s=>s.id==='language'));
});

test('received simulation headers drive client scores without erasing egress risks',()=>{
  const report=fixtures();
  report.exit.sources[0].countryCode='CN';
  report.exit.primary.countryCode='CN';
  const rows=buildGatewayCheck(report,'zh').signals;
  const live={...report.cloak,target:report.profile};
  const job={...passedJob,profileUpdatedAt:'new',cloakUpdatedAt:live.updatedAt,target:report.profile,
    signalResults:Object.fromEntries(['language','languageVariant','locale'].map(id=>[id,{state:'passed',completed:1,total:1,failed:0}])),
    messageProbe:{viaLiveGateway:true,method:'POST',path:'/v1/messages',status:200,sentLanguage:'zh-CN,zh;q=0.9',receivedLanguage:'ko-KR,ko;q=0.9,en;q=0.5',sentLocale:'zh-CN',receivedLocale:'ko-KR',bodyUnchanged:true}};
  const simulated=simulationSignals(rows,job,live,'zh');
  const language=simulated.find(s=>s.id==='language');
  assert.equal(language.sampleKind,'simulation');
  assert.equal(language.value,'ko-KR,ko;q=0.9,en;q=0.5');
  assert.equal(language.contribution,0);
  assert.equal(simulated.find(s=>s.id==='ipCountryRisk'),rows.find(s=>s.id==='ipCountryRisk'));
  assert.ok(simulated.find(s=>s.id==='ipCountryRisk').contribution>0);
  assert.equal(report.lastRequest,null);
  for(const changed of [{...job,state:'stale'},{...job,cloakUpdatedAt:'old'},{...job,profileUpdatedAt:'old'},{...job,messageProbe:{...job.messageProbe,viaLiveGateway:false}},{...job,messageProbe:{...job.messageProbe,status:502}},{...job,messageProbe:{...job.messageProbe,bodyUnchanged:false}}]) {
    assert.equal(simulationSignals(rows,changed,live,'zh'),rows);
  }
  assert.equal(currentSimulation(job,{...live,enabled:false}),null);
  const riskyProfile={...report.profile,language:'zh-CN',locale:'zh-CN'};
  const riskyJob={...job,target:riskyProfile,messageProbe:{...job.messageProbe,receivedLanguage:'zh-CN,zh;q=0.9,en;q=0.5',receivedLocale:'zh-CN'}};
  assert.ok(simulationSignals(rows,riskyJob,{...live,target:riskyProfile},'zh').find(s=>s.id==='language').contribution>0);
  const englishProfile={...report.profile,language:'en',locale:'en-US'};
  const englishJob={...job,target:englishProfile,messageProbe:{...job.messageProbe,receivedLanguage:'en-US,en;q=0.9',receivedLocale:'en-US'}};
  assert.equal(simulationSignals(rows,englishJob,{...live,target:englishProfile},'zh').find(s=>s.id==='language').sampleKind,'simulation');
});

const {repairChoices} = require(path.join(root,'src/detection/repair-options.ts'));
const {RepairDialog} = require(path.join(root,'src/components/detector/RepairDialog.tsx'));
const {mergePointSignals,mergePointCheckSignals} = require(path.join(root,'src/detection/single-signal.ts'));

test('detail dialog identifies the actual current header and selects the exit target for confirmation',()=>{
  const signal={...index(buildGatewayCheck(fixtures(),'zh')).language,value:'ko-KR,ko;q=0.9,en;q=0.5',assessment:'ok',state:'done'};
  const choices=repairChoices(signal,{language:'en-US'});
  assert.equal(choices.find(c=>c.current).value,'ko-KR');
  assert.equal(repairChoices({...signal,assessment:'unknown'}).some(c=>c.current),false);
  const html=renderToStaticMarkup(React.createElement(RepairDialog,{signal,signals:[signal],claude:signal,browser:{...signal,source:'browser',value:'zh-CN',contribution:5},locale:'zh',loading:false,target:{language:'en-US'},onClose:()=>{},onRecheck:async()=>{},onApplyGateway:async()=>{}}));
  const currentInput=(html.match(/<input[^>]+>/g)||[]).find(input=>input.includes('value="ko-KR"'));
  assert.match(currentInput,/value="ko-KR"/);
  const targetInput=(html.match(/<input[^>]+>/g)||[]).find(input=>input.includes('value="en-US"'));
  assert.match(targetInput,/checked/);
  assert.match(html,/当前客户端配置/);
  assert.match(html,/当前浏览器配置/);
  assert.match(html,/确认并重测/);
  assert.equal((html.match(/<footer[^>]*>[\s\S]*?<button/g)||[]).length,1);
  const weighted={...signal,value:'en-US,zh-CN;q=0.9',contribution:5};
  const actual=repairChoices(weighted).find(choice=>choice.current);
  assert.equal(actual.value,'en-US, zh-CN');
  assert.ok(actual.contribution>0);
});

test('a point test updates only its own observation and cannot turn other zero placeholders into passes',()=>{
  const previous=buildGatewayCheck(fixtures(),'zh').signals;
  const sample={...previous.find(s=>s.id==='country'),value:'new sample'};
  const merged=mergePointSignals(previous,sample);
  assert.equal(merged.find(s=>s.id==='country'),sample);
  assert.equal(merged.find(s=>s.id==='language'),previous.find(s=>s.id==='language'));
  const first=mergePointSignals([],sample,previous);
  assert.equal(first.find(s=>s.id==='language').assessment,'unknown');
  assert.equal(first.find(s=>s.id==='language').value,null);
});

test('new profile metadata cannot reactivate preserved old native message observations',()=>{
  const before=buildGatewayCheck(fixtures(),'zh');
  before.signals=before.signals.map(signal=>signal.id==='languageVariant'?{...signal,value:'en-US',assessment:'ok',contribution:0,cloaked:true}:signal);
  const afterReport=fixtures();
  afterReport.profile={...afterReport.profile,language:'zh-CN',updatedAt:'updated-profile'};
  afterReport.cloak={enabled:true,updatedAt:'new-cloak-version'};
  const after=buildGatewayCheck(afterReport,'zh');
  const merged=mergePointCheckSignals(before,after);
  assert.equal(merged.find(signal=>signal.id==='languageVariant').assessment,'unknown');
  assert.equal(merged.find(signal=>signal.id==='languageVariant').value,null);
  assert.equal(merged.find(signal=>signal.id==='country'),before.signals.find(signal=>signal.id==='country'));
});

test('simulated receiver fills protocol metadata without fabricating a normal Claude request',()=>{
  const report=fixtures();
  const rows=buildGatewayCheck(report,'zh').signals;
  const live={...report.cloak,target:report.profile};
  const job={...passedJob,profileUpdatedAt:'new',cloakUpdatedAt:live.updatedAt,target:report.profile,
    messageProbe:{viaLiveGateway:true,status:200,bodyUnchanged:true,headersIntegrity:true,elapsedMs:27,sentLanguage:'zh-CN,zh;q=0.9',receivedLanguage:'ko-KR,ko;q=0.9,en;q=0.5',sentLocale:'zh-CN',receivedLocale:'ko-KR',receivedHeaders:{'accept-language':'ko-KR','user-agent':'Local test','x-stainless-os':'win32','x-stainless-runtime':'node','x-stainless-arch':'x64'}}};
  const samples=simulationSignals(rows,job,live,'zh');
  for(const id of ['httpLanguage','requestHeaders','deviceLineage','secFetch','clientHints','claudeTrigger','claudeLatency']) {
    const signal=samples.find(s=>s.id===id);
    assert.equal(signal.sampleKind,'simulation',id);
    assert.equal(signal.assessment,'ok',id);
  }
  assert.equal(samples.find(s=>s.id==='claudeLatency').value,'27 ms');
  assert.equal(report.lastRequest,null);
});

test('gateway ASN aliases and received trace countries produce measured values; missing city explains its cause',()=>{
  const report=fixtures();
  report.edge={loc:'KR',colo:'ICN',city:null,http:200,error:null};
  const rows=index(buildGatewayCheck(report,'zh'));
  assert.equal(rows.gatewayAsn.assessment,'ok');
  assert.equal(rows.edgeCountry.assessment,'ok');
  assert.equal(rows.edgeCity.assessment,'unknown');
  assert.match(rows.edgeCity.value,/未提供城市/);
});

test('native browser language point refreshes linked variant without remote network probes',async()=>{
  const {runBrowserScan}=require(path.join(root,'src/detection/browser-scan.ts'));
  const {detectorLocaleText}=require(path.join(root,'src/detection/locale.ts'));
  const originalFetch=global.fetch;
  let calls=0;
  global.fetch=async()=>{calls++;throw new Error('Unexpected network request');};
  try {
    const scan=await runBrowserScan('auto','zh',detectorLocaleText.zh,'language');
    assert.equal(calls,0);
    assert.equal(scan.signals.length,2);
    assert.equal(scan.signals[0].id,'language');
    assert.equal(scan.signals[1].id,'languageVariant');
    assert.equal(scan.signals[1].settingValue,scan.snapshot.languages.join(', '));
  } finally {global.fetch=originalFetch;}
});

test('native WebRTC without public candidates explains absence instead of waiting for another test',async()=>{
  const {runBrowserScan}=require(path.join(root,'src/detection/browser-scan.ts'));
  const {detectorLocaleText}=require(path.join(root,'src/detection/locale.ts'));
  const probes=require(path.join(root,'src/detection/browser-probes.ts'));
  const original=probes.probeWebrtc;
  probes.probeWebrtc=async()=>({supported:true,publicIps:[],candidates:0,error:null});
  try {
    const scan=await runBrowserScan('auto','zh',detectorLocaleText.zh,'webrtcFirstIp');
    assert.equal(scan.signals.length,7);
    const first=scan.signals.find(sample=>sample.id==='webrtcFirstIp');
    assert.equal(first.assessment,'ok');
    assert.match(first.value,/无公网候选/);
    probes.probeWebrtc=async()=>({supported:false,publicIps:[],candidates:0,error:'WEBRTC_UNAVAILABLE'});
    const unsupported=await runBrowserScan('auto','zh',detectorLocaleText.zh,'webrtcFirstIp');
    const unavailable=unsupported.signals.find(sample=>sample.id==='webrtcFirstIp');
    assert.equal(unavailable.assessment,'not_applicable');
    assert.match(unavailable.value,/不支持/);
  } finally {probes.probeWebrtc=original;}
});

test('raw state cannot retain a simulated pass after configuration invalidates its overlay',()=>{
  const {nativeClientSignals}=require(path.join(root,'src/detection/simulation-evidence.ts'));
  const signal={...index(buildGatewayCheck(fixtures(),'zh')).language,value:'ko-KR',assessment:'ok',cloaked:true,sampleKind:'simulation'};
  for(const matches of [true,false]) {
    const raw=nativeClientSignals([signal],matches)[0];
    assert.equal(raw.assessment,'unknown');
    assert.equal(raw.value,null);
    assert.equal(raw.cloaked,false);
  }
});

test('missing browser network inputs are not reported as a zero-point pass',async()=>{
  const probes=require(path.join(root,'src/detection/browser-probes.ts'));
  const {runBrowserScan}=require(path.join(root,'src/detection/browser-scan.ts'));
  const {detectorLocaleText}=require(path.join(root,'src/detection/locale.ts'));
  const ip=probes.collectBrowserIpIntel,reach=probes.collectBrowserReachability;
  probes.collectBrowserIpIntel=async()=>null;
  probes.collectBrowserReachability=async()=>null;
  try {
    const scan=await runBrowserScan('auto','zh',detectorLocaleText.zh,'claudeAccessRisk');
    assert.equal(scan.signals[0].assessment,'unknown');
    assert.match(scan.signals[0].value,/采样不完整/);
  } finally {probes.collectBrowserIpIntel=ip;probes.collectBrowserReachability=reach;}
});

test('completed inconclusive and unavailable diagnostics are distinct from unrun and failed tests',()=>{
  const {signalScoreLabel,signalResultStatus}=require(path.join(root,'src/detection/card-evidence.ts'));
  const report=fixtures();
  report.edge={loc:'KR',colo:'ICN',city:null,http:200,error:null};
  const rows=index(buildGatewayCheck(report,'zh'));
  for(const id of ['dnsReview','dnsConsistency']) {
    assert.equal(signalScoreLabel(rows[id],true),'无法判定');
    const html=renderCard(rows[id],null,{claude:rows[id]});
    assert.match(html,/无法判定/);
    assert.doesNotMatch(html,/待测试|待测|data-signal-state="measured"/);
  }
  assert.equal(rows.edgeCity.observation,'unavailable');
  assert.equal(signalScoreLabel(rows.edgeCity,true),'已测·无数据');
  assert.equal(signalScoreLabel(rows.edgeCity,false),'Tested · no data');
  assert.match(renderCard(rows.edgeCity,null,{claude:rows.edgeCity}),/未返回数据/);
  assert.equal(signalScoreLabel(undefined,true),'待测试');
  assert.equal(signalResultStatus({...rows.dnsReview,value:'未测得'}),'pending');
  assert.equal(signalResultStatus({...rows.dnsReview,state:'running'}),'running');
  assert.equal(signalScoreLabel({...rows.dnsReview,assessment:'error'},true),'测试失败');
  assert.equal(signalScoreLabel({...rows.dnsReview,assessment:'not_applicable'},true),'不适用');
  const offline=index(buildGatewayCheck(null,'zh'));
  assert.equal(signalScoreLabel(offline.dnsReview,true),'待测试');
});

test('information choices are read-only while legacy target storage remains separate',()=>{
  const {RepairDialog}=require(path.join(root,'src/components/detector/RepairDialog.tsx'));
  const {saveRepairTarget,readRepairTarget,decodeRepairTarget}=require(path.join(root,'src/detection/repair-target.ts'));
  const {repairChoices}=require(path.join(root,'src/detection/repair-options.ts'));
  const signal=index(buildGatewayCheck(fixtures(),'zh')).dnsConsistency;
  const before=JSON.stringify(signal);
  const values=new Map();
  const storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
  const choice=repairChoices(signal)[0];
  assert.equal(choice.action,'information');
  saveRepairTarget(storage,signal.id,choice);
  assert.deepEqual(decodeRepairTarget(readRepairTarget(storage,signal.id)),{id:choice.id,value:choice.value,label:choice.label});
  assert.equal(readRepairTarget(storage,'dnsReview'),null);
  const dynamic={id:'current',value:'old observed value',label:'old current label'};
  saveRepairTarget(storage,signal.id,dynamic);
  dynamic.value='new observed value';
  dynamic.label='new current label';
  assert.deepEqual(decodeRepairTarget(readRepairTarget(storage,signal.id)),{id:'current',value:'old observed value',label:'old current label'});
  assert.equal(decodeRepairTarget('current'),null);
  assert.equal(decodeRepairTarget('{"id":true}'),null);
  assert.equal(JSON.stringify(signal),before);
  assert.throws(()=>saveRepairTarget({getItem:()=>null,setItem:()=>{throw new Error('Storage unavailable');}},signal.id,choice),/Storage unavailable/);
  const html=renderToStaticMarkup(React.createElement(RepairDialog,{signal,claude:signal,signals:[signal],locale:'zh',loading:false,onClose:()=>{},onRecheck:async()=>{},onApplyGateway:async()=>{}}));
  assert.match(html,/<footer[\s\S]*>重新检测<\/button>/);
  assert.match(html,/<fieldset[^>]*disabled/);
  assert.doesNotMatch(html,/原生测试此项|模拟测试此项/);
  assert.match(html,/无法判定/);
  assert.doesNotMatch(html,/待测试 \/ 需复核/);
});

test('read-only dialogs ignore legacy targets while cards preserve measured evidence',()=>{
  const {RepairDialog}=require(path.join(root,'src/components/detector/RepairDialog.tsx'));
  const {saveRepairTarget}=require(path.join(root,'src/detection/repair-target.ts'));
  const {notifyRepairTargetChange,subscribeRepairTargets}=require(path.join(root,'src/detection/use-repair-target.ts'));
  const previousWindow=global.window;
  const previousStore=React.useSyncExternalStore;
  const values=new Map();
  const testWindow=new EventTarget();
  testWindow.localStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
  global.window=testWindow;
  // Render client snapshots with the real React store hook, without a DOM dependency.
  React.useSyncExternalStore=(subscribe,snapshot)=>previousStore(subscribe,snapshot,snapshot);
  let notifications=0;
  const unsubscribe=subscribeRepairTargets(()=>notifications++);
  const signal=index(buildGatewayCheck(fixtures(),'zh')).country;
  const browser={...signal,value:'Browser request failed',assessment:'error',contribution:16,source:'browser',environment:'browser'};
  const before=JSON.stringify({signal,browser});
  try {
    for (const label of ['韩国 · 与出口情报一致','未命中高风险国家名单']) {
      saveRepairTarget(testWindow.localStorage,signal.id,{id:label,value:label,label});
      notifyRepairTargetChange();
      const card=renderCard(signal,null,{browser,claude:signal});
      const dialog=renderToStaticMarkup(React.createElement(RepairDialog,{signal,browser,claude:signal,signals:[signal],locale:'zh',loading:false,onClose:()=>{},onRecheck:async()=>{},onApplyGateway:async()=>{}}));
      assert.ok(!card.includes(label));
      assert.doesNotMatch(dialog,/处理目标/);
      assert.match(dialog,/<fieldset[^>]*disabled/);
      assert.doesNotMatch(card,/处理目标/);
      assert.match(card,/Browser request failed/);
      assert.match(card,/data-signal-state="flagged"/);
      assert.match(card,/data-score-side="claude"[^>]*>\+10</);
    }
    assert.equal(notifications,2);
    testWindow.dispatchEvent(new Event('storage'));
    assert.equal(notifications,3);
    unsubscribe();
    notifyRepairTargetChange();
    assert.equal(notifications,3);
    assert.equal(JSON.stringify({signal,browser}),before);
  } finally {
    unsubscribe();
    React.useSyncExternalStore=previousStore;
    if (previousWindow===undefined) delete global.window; else global.window=previousWindow;
  }
});

test('dialog dismissal only recognizes points on the backdrop, not content or inner padding',()=>{
  const {isDialogBackdropEvent}=require(path.join(root,'src/components/detector/RepairDialog.tsx'));
  const dialog={getBoundingClientRect:()=>({left:100,right:700,top:30,bottom:600})};
  const event=(x,y,target=dialog)=>({currentTarget:dialog,target,clientX:x,clientY:y});
  assert.equal(isDialogBackdropEvent(event(50,200)),true);
  assert.equal(isDialogBackdropEvent(event(750,200)),true);
  assert.equal(isDialogBackdropEvent(event(400,10)),true);
  assert.equal(isDialogBackdropEvent(event(400,650)),true);
  assert.equal(isDialogBackdropEvent(event(110,200)),false);
  assert.equal(isDialogBackdropEvent(event(100,30)),false);
  assert.equal(isDialogBackdropEvent(event(400,200,{})),false);
});

test('executable choices cover adjustable browser signals and exclude network observations or hardware claims',()=>{
  const {choiceRuntimePolicy}=require(path.join(root,'src/detection/environment-actions.ts'));
  const {repairChoices}=require(path.join(root,'src/detection/repair-options.ts'));
  const rows=index(buildGatewayCheck(fixtures(),'zh'));
  for(const id of ['chineseFonts','vendorFonts','language','languageVariant','locale','webrtcLeak']) {
    const choices=repairChoices({...rows[id],assessment:'ok',value:'baseline',score:0});
    assert.ok(choices.some(choice=>choiceRuntimePolicy(id,choice)),id);
    assert.equal(choiceRuntimePolicy(id,{id:'current',value:'baseline'}),null);
  }
  for(const id of ['country','exitType','claudeAccessRisk','dnsReview','domesticDevice','emojiStyle']) {
    assert.ok(repairChoices(rows[id]).every(choice=>choiceRuntimePolicy(id,choice)===null),id);
  }
  const noFonts={...rows.chineseFonts,source:'browser',environment:'browser',assessment:'ok',value:'未检测到名单字体',score:0,contribution:0,cloaked:true,testedAt:'2026-10-24T00:00:00Z'};
  const current=repairChoices(noFonts).find(choice=>choice.current);
  assert.match(current.value,/No listed fonts/);
  const html=renderCard(noFonts,null,{browser:noFonts});
  assert.match(html,/data-signal-state="simulated"/);
  assert.match(html,/保护后通过/);
  assert.doesNotMatch(html,/网关改写后通过/);
});

test('browser cloak status requires both live Claude interfaces and received request headers',()=>{
  const {BrowserCloakStatus}=require(path.join(root,'src/components/detector/BrowserCloakStatus.tsx'));
  const report={enabled:true,policy:{},appliedAt:'now',gatewayUpdatedAt:'one',results:[{target:'web',state:'verified',detail:'live sample',pages:1}],requestProbe:{state:'verified',receivedLanguage:'ko-KR',sampledAt:'now',detail:'received'}};
  const render=value=>renderToStaticMarkup(React.createElement(BrowserCloakStatus,{report:value,locale:'zh'}));
  assert.match(render(report),/data-browser-cloak="verified"/);
  assert.match(render(report),/Accept-Language: ko-KR/);
  assert.match(render({...report,requestProbe:{state:'unverified'}}),/data-browser-cloak="unverified"/);
  assert.match(render({...report,results:[{target:'web',state:'unverified',detail:'Claude page closed',pages:0}]}),/data-browser-cloak="unverified"/);
  assert.doesNotMatch(render({...report,results:[...report.results,{target:'local',state:'failed',detail:'local error',pages:0}]}),/data-browser-cloak="verified"/);
  assert.match(render(null),/未跟随网关/);
});

test('executed limited checks are terminal, while stale and unrun samples remain untested',()=>{
  const {signalResultStatus,cardEvidence}=require(path.join(root,'src/detection/card-evidence.ts'));
  const {mergePointSignals}=require(path.join(root,'src/detection/single-signal.ts'));
  const {nativeClientSignals}=require(path.join(root,'src/detection/simulation-evidence.ts'));
  const empty={...index(buildGatewayCheck(fixtures(),'zh')).dnsConsistency,value:'未测得',assessment:'unknown',testedAt:'now',observation:'unavailable'};
  assert.equal(signalResultStatus(empty),'unavailable');
  assert.equal(cardEvidence(empty.id,undefined,empty).allPassed,false);
  const single={...empty,id:'dnsReview',value:'test completed'};
  const untouched=mergePointSignals([],single,[empty]).find(s=>s.id===empty.id);
  assert.equal(signalResultStatus(untouched),'pending');
  const stale=nativeClientSignals([{...empty,id:'language',sampleKind:'simulation'}],false)[0];
  assert.equal(stale.testedAt,undefined);
  assert.equal(stale.observation,undefined);
  assert.equal(signalResultStatus(stale),'pending');
});

test('target outcomes compare measured settings rather than display summaries or zero points',()=>{
  const {repairChoices}=require(path.join(root,'src/detection/repair-options.ts'));
  const {targetOutcome}=require(path.join(root,'src/detection/target-outcome.ts'));
  const sample=(id,value,score=0,extra={})=>({id,label:id,value,score,weight:signalConfig[id].weight,contribution:Math.round(score*signalConfig[id].weight),assessment:'ok',source:'browser',testedAt:'now',...extra});
  const cases=[
    [sample('chineseFonts','未检测到名单内字体'),/No listed fonts/],
    [sample('chineseFonts','简体字体：SimSun',0.85),/^1 simplified/],
    [sample('vendorFonts','未发现厂商字体'),/^0$/],
    [sample('languageVariant','无中文文字特征',0,{settingValue:'en-US'}),/^en-US$/],
    [sample('language','en-US,en;q=0.9'),/^en-US$/],
    [sample('timezoneOffset','UTC+9'),/^Asia\/Seoul$/],
    [sample('webrtcLeak','WebRTC 已屏蔽（浏览器接口）'),/^禁用 WebRTC/],
    [sample('exitType','数据中心 / 云厂商',1,{assessment:'warning'}),/^数据中心/],
    [sample('multiSourceConsistency','多源一致（KR）'),/consistent sources/],
    [sample('claudeReachability','HTTP 302 · 15 ms'),/^可达/],
    [sample('dnsReview','代理解析已验证 · 本程序未做本机目标查询'),/^代理解析/],
    [sample('country','中国',1,{assessment:'error'}),/Mainland China/],
  ];
  for (const [signal,pattern] of cases) {
    const choice=repairChoices(signal).find(item=>pattern.test(item.value));
    assert.ok(choice,signal.id);
    assert.equal(targetOutcome(signal,choice),'matched',signal.id);
  }
  const english=sample('languageVariant','无中文文字特征',0,{settingValue:'en-US'});
  const korean=repairChoices(english).find(item=>item.value==='ko-KR');
  assert.equal(targetOutcome(english,korean),'mismatch');
  assert.equal(targetOutcome({...english,assessment:'unknown'},korean),'limited');
  const web=sample('webrtcLeak','无公网候选地址');
  assert.equal(targetOutcome(web,repairChoices(web).find(item=>/^禁用 WebRTC/.test(item.value))),'mismatch');
  const fallback=sample('language','ko-KR, ko, en');
  assert.equal(targetOutcome(fallback,repairChoices(fallback).find(item=>item.value==='ko-KR')),'matched');
  const chineseFallback=sample('language','ko-KR, ko, en, zh-CN');
  assert.equal(targetOutcome(chineseFallback,repairChoices(chineseFallback).find(item=>item.value==='ko-KR')),'mismatch');
});

test('gateway access risk cannot infer unreachable or low risk from missing inputs',()=>{
  const {signalResultStatus}=require(path.join(root,'src/detection/card-evidence.ts'));
  const report=fixtures();
  delete report.probes; delete report.exit;
  let signal=index(buildGatewayCheck(report,'zh')).claudeAccessRisk;
  assert.equal(signal.contribution,0);
  assert.equal(signalResultStatus(signal),'pending');
  report.probes={claude:{status:302,elapsedMs:1}};
  report.checkedAt='now'; report.testedSignals=['claudeAccessRisk'];
  signal=index(buildGatewayCheck(report,'zh')).claudeAccessRisk;
  assert.equal(signal.assessment,'unknown');
  assert.equal(signalResultStatus(signal),'inconclusive');
  assert.equal(signal.contribution,0);
});

test('failed native diagnostic requests finish attempted points without marking unrun points complete',async()=>{
  const {checkGateway}=require(path.join(root,'src/detection/gateway-check.ts'));
  const {signalResultStatus}=require(path.join(root,'src/detection/card-evidence.ts'));
  const before=global.fetch;
  global.fetch=async()=>{throw new Error('ECONNREFUSED');};
  try {
    const single=index(await checkGateway('zh','dnsReview'));
    assert.equal(signalResultStatus(single.dnsReview),'failed');
    assert.ok(single.dnsReview.testedAt);
    assert.equal(signalResultStatus(single.dnsConsistency),'pending');
    const full=index(await checkGateway('zh'));
    for (const id of ['dnsReview','dnsConsistency','edgeCity','country','ipv4']) assert.equal(signalResultStatus(full[id]),'failed',id);
    assert.equal(signalResultStatus(full.language),'pending','Native request failure cannot claim a message simulation ran');
  } finally {global.fetch=before;}
});

test('DNS proxy verification is scoped to the app and refreshes all three native sibling results',()=>{
  const {signalResultStatus}=require(path.join(root,'src/detection/card-evidence.ts'));
  const {mergePointCheckSignals}=require(path.join(root,'src/detection/single-signal.ts'));
  const report=fixtures();
  report.checkedAt='now'; report.testedSignals=['dnsMode','dnsReview','dnsConsistency'];
  report.dns={...report.dns,mode:'proxy',localLookupSkipped:true,routeStatus:401,referenceAgreement:true,references:[{source:'test',answers:['1.1.1.1'],error:null}]};
  const next=buildGatewayCheck(report,'zh');
  const rows=index(next);
  for (const id of report.testedSignals) {
    assert.equal(signalResultStatus(rows[id]),'measured',id);
    assert.equal(rows[id].contribution,0,id);
    assert.equal(rows[id].testedAt,'now',id);
  }
  assert.match(rows.dnsReview.detail,/不证明代理内部/);
  const previous=buildGatewayCheck(fixtures(),'zh');
  const merged=index({signals:mergePointCheckSignals(previous,next,rows.dnsReview)});
  assert.equal(merged.dnsConsistency.value,rows.dnsConsistency.value);
  report.dns.referenceAgreement=false;
  const varied=index(buildGatewayCheck(report,'zh')).dnsConsistency;
  assert.equal(signalResultStatus(varied),'inconclusive');
  assert.equal(varied.contribution,0);
});

test('workspace score matches scoped card points and excludes unsupported-side observations',()=>{
  const {measurementPoints}=require(path.join(root,'src/detection/measurement-status.ts'));
  const browser=[{id:'emojiStyle',value:'Windows Emoji',contribution:2},{id:'proxyCountry',value:'KR',contribution:99}];
  const client=[{id:'chineseFonts',value:'Chinese fonts',contribution:13},{id:'emojiStyle',value:'Windows Emoji',contribution:2},{id:'legacy-removed',value:'old data',contribution:50}];
  const score=environmentScores(browser,client);
  assert.deepEqual(score,{browser:2,claude:null,combined:2});
  const {detectionConfig}=require(path.join(root,'src/detection/config/index.ts'));
  const sum=Object.entries(detectionConfig.signals).filter(([,c])=>c.enabled).reduce((n,[id])=>n+measurementPoints(id,browser.find(s=>s.id===id),client.find(s=>s.id===id)),0);
  assert.equal(score.combined,Math.min(100,sum));
});
test('a protected passing client does not hide browser rule points or failures',()=>{
  const {cardEvidence}=require(path.join(root,'src/detection/card-evidence.ts'));
  const browser={id:'language',value:'zh-CN',contribution:5,assessment:'warning',testedAt:'2026-10-24T00:00:00Z'};
  const client={id:'language',value:'ko-KR',contribution:0,assessment:'ok',cloaked:true,testedAt:'2026-10-24T00:00:00Z'};
  assert.equal(cardEvidence('language',browser,client).state,'flagged');
  assert.equal(cardEvidence('language',{...browser,contribution:0,assessment:'error'},client).state,'flagged');
  assert.equal(cardEvidence('language',{...browser,contribution:0,assessment:'ok'},client).state,'simulated');
});

test('inapplicable stale points are excluded from totals, cards and anomaly markers',()=>{
  const {measurementAbnormal,measurementContribution}=require(path.join(root,'src/detection/measurement-status.ts'));
  const {cardEvidence}=require(path.join(root,'src/detection/card-evidence.ts'));
  const sample={id:'emojiStyle',value:'N/A',assessment:'not_applicable',contribution:13};
  assert.equal(measurementContribution(sample),0);
  assert.equal(measurementAbnormal(sample),false);
  assert.deepEqual(environmentScores([sample],[]),{browser:null,claude:null,combined:null});
  assert.equal(cardEvidence(sample.id,sample).state,'inapplicable');
  const card=renderCard(sample,null,{browser:sample});
  assert.doesNotMatch(card,/data-score-side="browser"[^>]*>13</);
});

test('verification score separates full passing credit from provisional half credit',()=>{
  const {verificationPoint,verificationScores} = require(path.join(root,'src/detection/verification-score.ts'));
  const good = {id:'language',value:'ko-KR',testedAt:'2026-10-24T00:00:00Z',assessment:'ok',contribution:0};
  assert.equal(verificationPoint(good),20);
  for (const patch of [{testedAt:undefined},{testedAt:'invalid'},{value:null},{assessment:'unknown'},{observation:'review'},{observation:'inconclusive'},{state:'running'}]) assert.equal(verificationPoint({...good,...patch}),10);
  for (const patch of [{assessment:'error'},{assessment:'warning'},{contribution:5}]) assert.equal(verificationPoint({...good,...patch}),0);
  const passed = Object.keys(signalConfig).map(id=>({...good,id}));
  assert.equal(verificationScores(passed,passed).combined,256);
  const absent = verificationScores(null,null);
  assert.equal(absent.combined,128); assert.equal(absent.coverage.combined.provisional,128); assert.equal(absent.coverage.combined.passed,0);
  const partial = verificationScores([good],null);
  assert.equal(partial.coverage.browser.passed,1);
  assert.equal(partial.coverage.combined.passed,0,'a shared item needs both applicable sides');
  assert.ok(partial.browser<partial.coverage.browser.maximum); assert.ok(partial.coverage.browser.pending>0);
  const both = verificationScores([good],[good]);
  assert.equal(both.coverage.combined.passed,1);
  assert.ok(both.combined>0 && both.combined<both.coverage.combined.maximum);
  const failed = verificationScores(passed,passed.map(s=>s.id==='language'?{...s,contribution:5,assessment:'warning'}:s));
  assert.equal(failed.coverage.combined.passed,48); assert.equal(failed.combined,236);
  const na = verificationScores(passed.map(s=>s.id==='language'?{...s,assessment:'not_applicable'}:s),passed.map(s=>s.id==='language'?{...s,assessment:'not_applicable'}:s));
  assert.equal(na.coverage.combined.possible,48); assert.equal(na.coverage.combined.passed,48); assert.equal(na.combined,236);
  assert.equal(verificationPoint({...good,contribution:NaN}),10);
  assert.equal(verificationPoint({...good,assessment:'not_applicable'}),null);
});

test('overview exposes recheck, monitoring choices and pass coverage without test timestamps',()=>{
  const {ProtectionWorkspace} = require(path.join(root,'src/components/detector/ProtectionWorkspace.tsx'));
  const {verificationScores} = require(path.join(root,'src/detection/verification-score.ts'));
  const props = {locale:'zh',report:{phase:'idle',enabled:false,issues:[],history:[],monitoring:true,intervalMs:300000},connected:true,busy:false,scores:verificationScores(null,null),geo:null,target:null,baseline:null,browser:[],claude:[],signals:[],cards:null,filter:'all',search:'',onFilter:()=>{},onSearch:()=>{},onToggle:()=>{},onMonitor:()=>{},onRefresh:()=>{},onSelect:()=>{}};
  const html = renderToStaticMarkup(React.createElement(ProtectionWorkspace,props));
  assert.ok(html.includes('>重新检测</button>'));
  assert.match(html,/aria-label="自动检测间隔"/);
  assert.match(html,/value="300000" selected=""/);
  assert.match(html,/每30秒/); assert.match(html,/每10分钟/);
  assert.doesNotMatch(html,/最近检测|下次检测|异常分/);
  assert.match(html,/验证得分/); assert.doesNotMatch(html,/暂计|汇总得分|workspace-score-note/); assert.match(html,/环境风险估计/);
  const english = renderToStaticMarkup(React.createElement(ProtectionWorkspace,{...props,locale:'en'}));
  assert.doesNotMatch(english,/Provisional|Total score|workspace-score-note/);
  const busy = renderToStaticMarkup(React.createElement(ProtectionWorkspace,{...props,busy:true,checking:true}));
  assert.match(busy,/disabled=""[^>]*>检测中…/);
  const {ScoreMeter} = require(path.join(root,'src/components/detector/ScoreMeter.tsx'));
  const meter = renderToStaticMarkup(React.createElement(ScoreMeter,{value:75,maximum:150,label:'验证',pending:'未检测'}));
  assert.match(meter,/50%/); assert.match(meter,/aria-valuemax="150"/); assert.match(meter,/aria-valuenow="75"/);
});

test('reference weights, pass credit and card state require the same evidence',()=>{
  const {verificationItem,verificationWeights,verificationPoint,verificationScores}=require(path.join(root,'src/detection/verification-score.ts'));
  const {cardEvidence}=require(path.join(root,'src/detection/card-evidence.ts'));
  assert.deepEqual(verificationWeights,{timezone:26,language:20,languageVariant:12,chineseFonts:16,vendorFonts:10,domesticBrowser:8,domesticDevice:6,locale:6,timezoneOffset:4,emojiStyle:4,country:20});
  const good={id:'language',value:'ko-KR',contribution:0,assessment:'ok',testedAt:'2026-10-24T00:00:00Z'};
  for(const patch of [{testedAt:undefined},{observation:'review'},{assessment:'warning'},{state:'running'}]){
    const sample={...good,...patch};
    assert.notEqual(verificationItem('language',sample,good),'passed');
    assert.notEqual(cardEvidence('language',sample,good).state,'measured');
    assert.notEqual(cardEvidence('language',sample,{...good,cloaked:true}).state,'simulated');
  }
  assert.equal(verificationItem('language',good,undefined),'pending');
  assert.equal(verificationItem('language',good,{...good,assessment:'not_applicable'}),'passed','only applicable sides require evidence');
  assert.equal(cardEvidence('vendorFonts',{...good,id:'vendorFonts',assessment:'warning'}).state,'flagged');
  assert.equal(verificationPoint({...good,id:'requestHeaders'}),1,'extended items receive baseline credit');
  const font={...good,id:'chineseFonts'};
  const result=verificationScores([font,good],[good]);
  assert.equal(result.browser,110.5); assert.equal(result.claude,88.5); assert.equal(result.combined,146,'shared language counted once and pending gets half credit');
  assert.equal(verificationScores([{...good,id:'os'}],null).browser,93,'a measured extended item replaces half credit with full baseline credit');
});

test('double risk rings use the same weighted score deficit as the score meters',()=>{
  const {environmentRiskEstimates}=require(path.join(root,'src/detection/verification-score.ts'));
  const good={id:'language',value:'ko-KR',score:0,weight:20,contribution:0,assessment:'ok',testedAt:'2026-10-24T00:00:00Z'};
  assert.equal(environmentRiskEstimates([],[]).browser.value,null);
  const unknown={...good,id:'timezone',testedAt:undefined};
  const flagged={...good,score:1,contribution:20,assessment:'warning'};
  const estimate=environmentRiskEstimates([flagged,unknown],[]).browser;
  assert.equal(estimate.value,55,'failed language gets zero credit; unresolved items retain half credit');
  assert.equal(estimate.observedWeight,20); assert.equal(estimate.totalWeight,185);
  assert.equal(environmentRiskEstimates([{...flagged,assessment:'error'}],[]).browser.value,55,'failed diagnostics earn zero credit');
  assert.equal(environmentRiskEstimates([good],[]).browser.value,45,'a passed language does not erase unresolved items');
  assert.equal(environmentRiskEstimates([{...flagged,id:'emojiStyle'}],[]).browser.value,51,'emoji uses the same verification weight as the score meter');
});

test('132 out of 157 client points yields 16 percent risk with 13 unresolved items',()=>{
  const {verificationWeight,verificationScores,environmentRiskEstimates}=require(path.join(root,'src/detection/verification-score.ts'));
  const passed=Object.entries(signalConfig).filter(([,config])=>config.enabled).map(([id])=>({id,value:'measured',score:0,weight:signalConfig[id].weight,contribution:0,assessment:'ok',testedAt:'2026-10-24T00:00:00Z'}));
  const unitIds=passed.filter(sample=>signalConfig[sample.id].environment!=='browser'&&verificationWeight(sample.id)===1).map(sample=>sample.id);
  const pendingIds=new Set(['language','languageVariant','locale',...unitIds.slice(0,10)]);
  const client=passed.map(sample=>pendingIds.has(sample.id)?{...sample,assessment:'unknown'}:sample.id===unitIds[10]?{...sample,assessment:'error'}:sample);
  const score=verificationScores(passed,client);
  assert.equal(score.claude,132);
  assert.equal(score.coverage.claude.maximum,157);
  assert.equal(score.coverage.claude.pending,13);
  assert.equal(score.coverage.claude.failed,1);
  const risk=environmentRiskEstimates(passed,client).claude;
  assert.equal(risk.value,16);
  assert.equal(risk.observedWeight,109,'coverage stays separate from the risk denominator');
  assert.equal(risk.totalWeight,157);
  assert.equal(environmentRiskEstimates(passed,passed).claude.value,0);
  assert.equal(environmentRiskEstimates([],client.map(sample=>({...sample,assessment:'not_applicable'}))).claude.value,null);
});

test('untested earns provisional half weight without becoming a measured pass',()=>{
  const {verificationPoint,verificationScores,verificationItem,verificationLabel}=require(path.join(root,'src/detection/verification-score.ts'));
  const pending={id:'timezone',value:null,contribution:0,assessment:'unknown'};
  assert.equal(verificationPoint(pending),13);
  assert.equal(verificationPoint(undefined,'timezone'),13);
  assert.equal(verificationItem('timezone',pending),'pending');
  assert.match(verificationLabel(pending,true),/暂计 \+13/);
  assert.equal(verificationPoint({...pending,assessment:'error'}),0);
  const full={...pending,value:'Asia/Seoul',assessment:'ok',testedAt:'2026-10-24T00:00:00Z'};
  const baseline=verificationScores(null,null);
  assert.equal(verificationScores([full],null).combined,baseline.combined+13);
  assert.equal(verificationScores([{...full,assessment:'warning',contribution:26}],null).combined,baseline.combined-13);
});

test('real browser language scan replaces provisional half credit with measured full or zero credit',async()=>{
  const {runBrowserScan}=require(path.join(root,'src/detection/browser-scan.ts'));
  const {verificationPoint}=require(path.join(root,'src/detection/verification-score.ts'));
  const {detectorLocaleText}=require(path.join(root,'src/detection/locale.ts'));
  const descriptor=Object.getOwnPropertyDescriptor(global,'navigator');
  try{
    for(const [language,expected,assessment] of [['en-US',20,'ok'],['zh-CN',0,'warning']]){
      Object.defineProperty(global,'navigator',{configurable:true,value:{languages:[language],language,userAgent:'Mozilla/5.0 Chrome/130.0',platform:'Linux'}});
      const scan=await runBrowserScan('auto','zh',detectorLocaleText.zh,'language');
      const signal=scan.signals.find(s=>s.id==='language');
      assert.ok(signal.testedAt); assert.equal(signal.assessment,assessment); assert.equal(verificationPoint(signal),expected);
    }
  }finally{if(descriptor)Object.defineProperty(global,'navigator',descriptor);else delete global.navigator;}
});

test('failed enabled reachability lowers credit while removed API evidence is excluded',()=>{
  const {verificationWeight,verificationPoint,verificationScores,environmentRiskEstimates}=require(path.join(root,'src/detection/verification-score.ts'));
  const passed=Object.entries(signalConfig).filter(([,config])=>config.enabled).map(([id])=>({id,value:'measured',score:0,weight:signalConfig[id].weight,contribution:0,assessment:'ok',testedAt:'2026-10-24T00:00:00Z'}));
  const full=verificationScores(passed,passed);
  assert.equal(full.claude,157); assert.equal(full.coverage.claude.maximum,157);
  assert.equal(full.combined,256);
  assert.equal(verificationWeight('apiReachability'),0);
  const removed={id:'apiReachability',value:'old failed API check',assessment:'error',testedAt:'2026-10-24T00:00:00Z',contribution:0};
  assert.equal(verificationScores([...passed,removed],[...passed,removed]).combined,full.combined);
  assert.equal(environmentRiskEstimates([...passed,removed],[...passed,removed]).claude.value,0);
  assert.equal(verificationWeight('webrtcLeak'),19,'existing positive extension weights are retained');
  assert.equal(verificationWeight('unknown-removed-item'),0);
  for(const assessment of ['warning','error']){
    const client=passed.map(sample=>sample.id==='anthropicReachability'?{...sample,assessment}:sample);
    const score=verificationScores(passed,client);
    assert.equal(score.claude,156); assert.equal(score.coverage.claude.failed,1);
    assert.equal(score.combined,255,'the shared failed item is counted once');
    assert.equal(verificationPoint(client.find(sample=>sample.id==='anthropicReachability')),0);
    assert.ok(environmentRiskEstimates(passed,client).claude.value>0,'known failures cannot produce a clear indicator');
  }
  const pending=passed.map(sample=>sample.id==='anthropicReachability'?{...sample,assessment:'unknown',testedAt:undefined}:sample);
  const partial=verificationScores(passed,pending);
  assert.equal(partial.claude,156.5); assert.equal(partial.coverage.claude.provisional,0.5);
  const na=passed.map(sample=>sample.id==='anthropicReachability'?{...sample,assessment:'not_applicable'}:sample);
  assert.equal(verificationScores(null,na).coverage.claude.maximum,156);
  for(const sample of passed){
    assert.ok(verificationWeight(sample.id)>0,sample.id);
    const failed=passed.map(item=>item.id===sample.id?{...item,assessment:'error'}:item);
    const score=verificationScores(failed,failed);
    assert.ok(score.combined<score.coverage.combined.maximum,sample.id+' failure must reduce the total');
  }
});


test('read-only exit type matches inferred network labels and disables target editing',()=>{
  const base={...index(buildGatewayCheck(fixtures(),'zh')).exitType,state:'done',assessment:'warning',score:1};
  for (const value of ['机房网络（推断）','Datacenter (inferred)']) {
    const signal={...base,value};
    const current=repairChoices(signal).filter(choice=>choice.current);
    assert.equal(current.length,1);
    assert.match(current[0].value,/Datacenter/);
    const html=renderToStaticMarkup(React.createElement(RepairDialog,{signal,signals:[signal],claude:signal,locale:'zh',loading:false,onClose:()=>{},onRecheck:async()=>{},onApplyGateway:async()=>{}}));
    assert.match(html,/<fieldset[^>]*disabled/);
    assert.match((html.match(/<input[^>]+>/g)||[]).find(input=>input.includes('Datacenter')),/checked/);
    assert.match(html,/重新检测/);
    assert.doesNotMatch(html,/采用此选项后|确认并重测/);
  }
  const residential=repairChoices({...base,value:'家庭网络（推断）',score:0,assessment:'ok'}).filter(choice=>choice.current);
  assert.equal(residential.length,1);
  assert.match(residential[0].value,/Residential/);
  assert.equal(repairChoices({...base,value:'暂无法判定',assessment:'unknown'}).some(choice=>choice.current),false);
});
