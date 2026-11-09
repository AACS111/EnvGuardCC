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
test('节点及供应商切换等待后台完成，避免请求超时后实际已切换', async t => {
  const { controlNetCore, netCoreSourceAction } = require(path.join(root, 'src/detection/gateway-check.ts'));
  const timeouts = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    timeouts.push(milliseconds);
    return new AbortController().signal;
  });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ ok: true }) }));
  await controlNetCore('select', 'test-node');
  await netCoreSourceAction('activate', 'src_test');
  await netCoreSourceAction('refresh', 'src_test');
  assert.deepEqual(timeouts, [180000, 180000, 180000]);
});

test('节点延迟颜色区分低、中、高、超时与未测量', async () => {
  const { nodeLatencyTone } = await import('../src/detection/net-core-view.mjs');
  for (const [delay, tone] of [[0, 'ok'], [199, 'ok'], [200, 'warn'], [499, 'warn'], [500, 'danger'], [null, 'danger'], [undefined, 'muted'], [-1, 'muted'], [Infinity, 'muted']]) {
    assert.equal(nodeLatencyTone(delay), tone);
  }
});

test('节点测量标识随供应商和配置更新时间变化，改名不影响测量归属', async () => {
  const { nodeMeasurementScope } = await import('../src/detection/net-core-view.mjs');
  const report = { activeId: 'src_a', source: { url: 'https://example.com/sub', updatedAt: 'first' } };
  assert.notEqual(nodeMeasurementScope(report), nodeMeasurementScope({ ...report, activeId: 'src_b' }));
  assert.notEqual(nodeMeasurementScope(report), nodeMeasurementScope({ ...report, source: { ...report.source, updatedAt: 'second' } }));
  assert.equal(nodeMeasurementScope(report), nodeMeasurementScope({ ...report, sources: [{ id: 'src_a', name: 'renamed' }] }));
});

test('切换供应商前发出的慢轮询不得恢复旧报告及旧测速结果', async () => {
  const { nodeMeasurementScope } = await import('../src/detection/net-core-view.mjs');
  const source = fs.readFileSync(path.join(root, 'src/components/detector/Detector.tsx'), 'utf8');
  const file = ts.createSourceFile('Detector.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'refreshNetCore') callback = node.initializer.arguments[0].getText(file);
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(callback);
  const scope = { current: 'old-source' };
  const reports = [], samples = [], pending = [];
  const refresh = require('node:vm').runInNewContext(`(${callback})`, {
    latestSourceScope: scope, nodeMeasurementScope,
    readNetCore: () => new Promise(resolve => pending.push(resolve)),
    setNetCore: report => reports.push(report), setNetCoreDelaySample: sample => samples.push(sample),
    setExitHistory() {}, setNetCoreError() {},
  });
  const oldRequest = refresh();
  scope.current = 'new-source';
  pending.shift()({ netCore: { activeId: 'old-source', delays: { same: 1 } } });
  await oldRequest;
  assert.equal(reports.length, 0);
  assert.equal(samples.length, 0);
  const freshRequest = refresh();
  const external = { activeId: 'external-source', delays: { same: 200 } };
  pending.shift()({ netCore: external });
  await freshRequest;
  assert.equal(reports[0], external);
  assert.equal(scope.current, nodeMeasurementScope(external));
});

test('超时按真实出口地区区分同地区备用与跨地区，未测量节点不当作可用', async () => {
  const { nodeSelectionState, netCoreView } = await import('../src/detection/net-core-view.mjs');
  const nodes = ['Japan 01', 'Taiwan 02', 'Taiwan 03', 'Japan 04', '未知节点', 'Japan 05'];
  const delays = { 'Japan 01': null, 'Taiwan 02': 100, 'Taiwan 03': 200, 'Japan 04': null, '未知节点': 300 };
  const exits = { 'Japan 01': { countryCode: 'TW' }, 'Taiwan 03': { countryCode: 'JP' } };
  const state = nodeSelectionState({ nodes, selected: 'Japan 01', delays, exits });
  assert.equal(state.recovery.tone, 'warn');
  assert.deepEqual(state.recovery.sameRegion.map(node => node.name), ['Taiwan 02']);
  assert.deepEqual(state.recovery.otherRegions.map(node => node.name), ['Taiwan 03', '未知节点']);
  assert.equal(state.nodes.find(node => node.name === 'Taiwan 03').switchTone, 'danger');
  assert.equal(nodeSelectionState({ nodes, selected: 'Japan 01', delays: { ...delays, 'Taiwan 02': null }, exits }).recovery.tone, 'danger');
  assert.equal(nodeSelectionState({ nodes, selected: 'Japan 01', delays: {}, exits }).recovery, null);
  assert.equal(netCoreView({ enabled: true, state: 'unavailable', nodes, selected: 'Japan 01' }).actions.canSelect, true);
});

test('节点卡片显示延迟色阶，超时有同地区备用时显示黄色并保留选择入口', () => {
  const { NetCorePanel } = require(path.join(root, 'src/components/detector/NetCorePanel.tsx'));
  const report = { enabled: true, state: 'unavailable', nodes: ['Taiwan 01', 'Taiwan 02', 'Japan 01', 'US 01'], selected: 'Taiwan 01', mode: 'rule' };
  const props = { locale: 'zh', report, delays: { 'Taiwan 01': null, 'Taiwan 02': 100, 'Japan 01': 300, 'US 01': 700 }, onRefresh() {}, onRestart() {}, onSelectNode() {}, onMeasure() {}, onModeChange() {} };
  const html = renderToStaticMarkup(React.createElement(NetCorePanel, props));
  assert.doesNotMatch(html, /延迟分级|低延迟|中延迟|高延迟/);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(NetCorePanel, { ...props, locale: 'en' })), /Latency levels|Low &lt; 200 ms|Medium 200–499 ms|High ≥ 500 ms/);
  assert.match(html, /class="netcore-recovery" data-tone="warn"/);
  assert.match(html, /同地区有 1 个可用备用节点/);
  assert.match(html, /class="netcore-node__latency" data-tone="ok"[^>]*>100 ms/);
  assert.match(html, /class="netcore-node__latency" data-tone="warn"[^>]*>300 ms/);
  assert.match(html, /class="netcore-node__latency" data-tone="danger"[^>]*>700 ms/);
  assert.match(html, /class="netcore-node__latency" data-tone="danger"[^>]*>超时/);
  const cards = html.slice(html.indexOf('<ul class="netcore-nodes">'));
  assert.doesNotMatch(cards, /disabled=""/);
  const crossRegion = renderToStaticMarkup(React.createElement(NetCorePanel, { ...props, delays: { ...props.delays, 'Taiwan 02': null } }));
  assert.match(crossRegion, /class="netcore-recovery" data-tone="danger"/);
  assert.match(crossRegion, /跨地区切换需要确认/);
});

test('跨地区选择必须确认，同地区手动切换，供应商变化后旧确认失效', t => {
  const { NetCorePanel } = require(path.join(root, 'src/components/detector/NetCorePanel.tsx'));
  const states = [];
  let hook = 0;
  t.mock.method(React, 'useState', initial => {
    const index = hook++;
    if (!(index in states)) states[index] = initial;
    return [states[index], value => { states[index] = value; }];
  });
  t.mock.method(React, 'useId', () => 'node-test');
  const triggerRef = { current: null };
  t.mock.method(React, 'useRef', () => triggerRef);
  const trigger = { focus: t.mock.fn() };
  const selected = [];
  const report = { enabled: true, state: 'running', activeId: 'src_a', nodes: ['Taiwan 01', 'Taiwan 02', 'Japan 01'], selected: 'Taiwan 01', mode: 'rule' };
  const props = { locale: 'zh', report, delays: { 'Taiwan 01': null, 'Taiwan 02': 100, 'Japan 01': 200 }, onRefresh() {}, onRestart() {}, onSelectNode: name => selected.push(name), onMeasure() {}, onModeChange() {} };
  const render = (next = props) => { hook = 0; return NetCorePanel(next); };
  const elements = tree => {
    const result = [];
    React.Children.forEach(tree, element => {
      if (!React.isValidElement(element)) return;
      result.push(element, ...elements(element.props.children));
    });
    return result;
  };
  const findCard = (tree, name) => elements(tree).find(element => element.type === 'button' && element.props.className === 'netcore-node' && elements(element.props.children).some(child => child.props.className === 'netcore-node__name' && child.props.children === name));
  const findConfirm = tree => elements(tree).find(element => element.type === 'button' && element.props.children === '确认切换');
  findCard(render(), 'Japan 01').props.onClick({ currentTarget: trigger });
  assert.deepEqual(selected, []);
  let tree = render();
  assert.ok(elements(tree).some(element => element.props.className === 'netcore-confirm' && element.props['data-tone'] === 'danger'));
  assert.ok(findConfirm(tree));
  elements(tree).find(element => element.type === 'button' && element.props.children === '取消').props.onClick();
  assert.equal(trigger.focus.mock.callCount(), 1);
  assert.deepEqual(selected, []);
  findCard(render(), 'Japan 01').props.onClick({ currentTarget: trigger });
  tree = render();
  assert.equal(findConfirm(render({ ...props, report: { ...report, activeId: 'src_b' } })), undefined);
  findConfirm(tree).props.onClick();
  assert.deepEqual(selected, ['Japan 01']);
  findCard(render(), 'Taiwan 02').props.onClick({ currentTarget: trigger });
  assert.deepEqual(selected, ['Japan 01', 'Taiwan 02']);
});

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
  // 只有一家情报源时无法交叉核对：显式标为「不适用」，而不是长期挂在「待处理」。
  assert.equal(signals.proxyCountry.assessment,'not_applicable');
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
    assert.equal(scan.signals[0].assessment,'not_applicable');
    assert.equal(scan.signals[0].observation,undefined);
    assert.equal(scan.signals[0].contribution,0);
    assert.match(scan.signals[0].value,/浏览器跨站探测受限/);
    assert.match(scan.signals[0].detail,/CORP\/COEP/);
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
      assert.equal(reach.assessment,'not_applicable');
      assert.equal(reach.observation,undefined);
      assert.equal(reach.contribution,0);
      assert.equal(signalScoreLabel(reach,true),'不适用');
      assert.equal(risk.assessment,'ok');
      assert.equal(risk.contribution,0);
      assert.equal(signalScoreLabel(risk,true),'0');
      const html=renderCard(reach,null,{browser:reach,claude:gateway});
      assert.match(html,/HTTP 302/);
      assert.match(html,/不适用/);
      assert.doesNotMatch(html,/测试失败|无法判定/);
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
  assert.equal(rows.edgeCity.assessment,'not_applicable');
  assert.match(rows.edgeCity.value,/不提供城市/);
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
  assert.equal(rows.edgeCity.observation,undefined);
  assert.equal(signalScoreLabel(rows.edgeCity,true),'不适用');
  assert.equal(signalScoreLabel(rows.edgeCity,false),'N/A');
  assert.match(renderCard(rows.edgeCity,null,{claude:rows.edgeCity}),/不适用/);
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
      assert.match(card,/data-score-side="claude"[^>]*>\+20</);
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

test('overview exposes recheck and pass coverage while configuration moves to settings',()=>{
  const {ProtectionWorkspace} = require(path.join(root,'src/components/detector/ProtectionWorkspace.tsx'));
  const {verificationScores} = require(path.join(root,'src/detection/verification-score.ts'));
  const props = {locale:'zh',report:{phase:'idle',enabled:false,issues:[],history:[],monitoring:true,intervalMs:300000},connected:true,busy:false,scores:verificationScores(null,null),geo:null,target:null,baseline:null,browser:[],claude:[],signals:[],cards:null,filter:'all',search:'',onFilter:()=>{},onSearch:()=>{},onToggle:()=>{},onMonitor:()=>{},onRefresh:()=>{},onSelect:()=>{}};
  const html = renderToStaticMarkup(React.createElement(ProtectionWorkspace,props));
  // 复检入口现在落在顶部「检测」与出口环境「刷新」两处；文案变更后仍必须可见。
  assert.ok(html.includes('>检测</button>'));
  assert.ok(html.includes('>刷新</button>'));
  assert.doesNotMatch(html,/自动检测间隔|开机自启动|workspace-preferences/);
  assert.match(html,/aria-haspopup="dialog"[^>]*>[\s\S]*?设置/);
  assert.doesNotMatch(html,/最近检测|下次检测|异常分/);
  assert.doesNotMatch(html,/查看防护状态和待处理事项/);
  assert.match(html,/环境检测得分/); assert.match(html,/满分 100/); assert.match(html,/未判定项暂计半分/); assert.match(html,/环境风险估计/);
  assert.doesNotMatch(html,/aria-valuenow=/,'without samples, provisional credit is not displayed as a measured score');
  const english = renderToStaticMarkup(React.createElement(ProtectionWorkspace,{...props,locale:'en'}));
  assert.doesNotMatch(english,/Review protection and items that need attention/);
  assert.match(english,/Weighted score out of 100/); assert.match(english,/unresolved items receive half credit/);
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

test('derived gateway values are measured, hosting orgs classify, and dialog separates risk from verification',()=>{
  const rows=index(buildGatewayCheck(fixtures(),'zh'));
  const {verificationLabel}=require(path.join(root,'src/detection/verification-score.ts'));
  assert.equal(rows.gatewayProfile.label,'网关出口目标配置');
  assert.ok(rows.gatewayProfile.testedAt);
  assert.equal(verificationLabel(rows.gatewayProfile,true),'通过 +1');
  const {exitNetworkType}=require(path.join(root,'src/detection/network-type.ts'));
  assert.equal(exitNetworkType('Akari Networks Limited','zh').kind,'datacenter');
  const emoji={id:'emojiStyle',label:'Emoji 渲染风格',value:'Apple Emoji 风格',score:0.5,weight:2,contribution:1,assessment:'warning',testedAt:new Date().toISOString(),source:'browser'};
  const html=renderToStaticMarkup(React.createElement(RepairDialog,{signal:emoji,browser:emoji,signals:[emoji],locale:'zh',loading:false,onClose:()=>{},onRecheck:async()=>{},onApplyGateway:async()=>{}}));
  assert.match(html,/风险 \+1/);
  assert.match(html,/未达标/);
});


test('网络内核面板：只给证据，不给未经证实的通过结论',()=>{
  const {NetCorePanel}=require(path.join(root,'src/components/detector/NetCorePanel.tsx'));
  const render=(report,locale='zh')=>renderToStaticMarkup(React.createElement(NetCorePanel,{locale,report,busy:false,onRefresh:()=>{},onRestart:()=>{},onSelectNode:()=>{},onStrictChange:()=>{}}));
  const running={enabled:true,state:'running',tunEnabled:true,tunCaptured:true,demo:false,version:'v1.19.33',restarts:0,nodes:['住宅-东京-01','住宅-新加坡-01'],selected:'住宅-东京-01',
    routing:{state:'verified',claude:12,pinned:12,direct:0,total:20,violations:[],sampledAt:new Date().toISOString()},detail:'12 条 Claude 连接全部命中 CLAUDE-PIN，无直连。'};

  const ok=render(running);
  assert.match(ok,/出口结论/);
  assert.match(ok,/已观察到的 Claude 连接走专用出口/);
  assert.match(ok,/Claude 连接/);
  assert.match(ok,/data-tone="ok"/);
  assert.doesNotMatch(ok,/netcore-violations/);
  assert.match(ok,/aria-pressed="true"/);

  // 无流量：不得出现通过态。
  const unknown=render({...running,routing:{state:'unknown',claude:0,pinned:0,direct:0,total:0,violations:[]}});
  assert.match(unknown,/未观察到 Claude 连接/);
  assert.match(unknown, /class="netcore-conclusion" data-tone="warn"/);

  // 违规：列出主机与代理链。
  const violation=render({...running,routing:{state:'violation',claude:2,pinned:1,direct:1,total:3,violations:[{host:'api.anthropic.com',chains:['DIRECT']}]}});
  assert.match(violation,/netcore-violations/);
  assert.match(violation,/api\.anthropic\.com/);
  assert.match(violation,/DIRECT/);
  assert.match(violation,/data-tone="danger"/);

  // 演示模式必须标注，且不能是 ok。
  const demo=render({...running,demo:true});
  assert.match(demo,/演示节点/);
  assert.match(demo, /class="netcore-conclusion" data-tone="warn"/);

  // 未配置：空态与原因，不出现任何出口结论指标。
  const disabled=render({enabled:false,state:'disabled',reason:'尚未配置出口节点'});
  assert.match(disabled,/尚未配置出口节点/);
  assert.match(disabled,/先配置出口节点/);
  assert.doesNotMatch(disabled,/netcore-strip/);

  // 英文文案。
  const en=render(running,'en');
  assert.match(en,/Exit conclusion/);
  assert.match(en,/Observed Claude connections use the dedicated exit/);
  const blocked=render({...running,strictMode:true,guard:{armed:true,phase:'blocked'},capabilities:{strictTravel:false}});
  assert.match(blocked,/严格连接尚未放行/);
  assert.doesNotMatch(blocked, /class="netcore-conclusion" data-tone="ok"/);
  for(const mode of blocked.match(/<button[^>]*class="netcore-mode"[^>]*>/g)??[]) assert.match(mode,/disabled=""/);
});

test('配置与供应商：列表展示名称/类型/节点数/更新时间，长链接只露域名',()=>{
  const {SourcesDialog}=require(path.join(root,'src/components/detector/SourcesDialog.tsx'));
  const sources=[
    {id:'src_a',name:'首尔机场',mode:'url',url:'https://a.example.com/s.yaml',nodeCount:3,selected:'n1',updatedAt:'2026-11-05T00:00:00.000Z',intervalHours:6,active:true},
    {id:'src_b',name:'备用机场',mode:'manual',url:null,nodeCount:1,selected:'m1',updatedAt:'2026-11-04T00:00:00.000Z',intervalHours:6,active:false},
  ];
  const props={locale:'zh',busy:false,sources,activeId:'src_a',onClose:()=>{},onImport:async()=>({ok:true,imported:1}),onAction:async()=>({ok:true}),onChanged:()=>{}};
  const html=renderToStaticMarkup(React.createElement(SourcesDialog,props));
  assert.match(html,/配置与供应商/);
  assert.match(html,/首尔机场/);
  assert.match(html,/备用机场/);
  assert.match(html,/订阅链接/);
  assert.match(html,/3 个节点/);
  assert.match(html,/更新于/);
  assert.match(html,/>编辑</);
  assert.match(html,/>删除</);
  assert.match(html,/>设为当前</);
  // 订阅令牌只在编辑表单里出现：列表只显示域名，截图分享不会泄露完整链接。
  assert.doesNotMatch(html,/https:\/\/a\.example\.com\/s\.yaml/);
  assert.match(html,/a\.example\.com/);
  const en=renderToStaticMarkup(React.createElement(SourcesDialog,{...props,locale:'en'}));
  assert.match(en,/Configurations/);
  assert.match(en,/In use/);
  assert.match(en,/Use/);
});

test('添加配置表单：四种来源都可见，链接与自定义表单可渲染',()=>{
  const {SourcesDialog}=require(path.join(root,'src/components/detector/SourcesDialog.tsx'));
  const base={sources:[],activeId:null,busy:false,onClose:()=>{},onImport:async()=>({ok:true,imported:1,selected:'x'}),onAction:async()=>({ok:true}),onChanged:()=>{}};
  const html=renderToStaticMarkup(React.createElement(SourcesDialog,{...base,locale:'zh',initialView:'add'}));
  assert.match(html,/添加配置/);
  assert.match(html,/订阅 \/ 分享链接/);
  assert.match(html,/>链接</);
  assert.match(html,/>本地代理</);
  assert.match(html,/>文件</);
  assert.match(html,/>自定义</);
  assert.match(html,/placeholder="https:\/\/example\.com\/sub\.yaml"/);
  assert.match(html,/导入会替换这条配置原有的节点快照/);
  const en=renderToStaticMarkup(React.createElement(SourcesDialog,{...base,locale:'en',initialView:'add'}));
  assert.match(en,/Add configuration/);
  assert.match(en,/Subscription or share link/);
});

test('内网直连弹窗：字段分组、保存与重启入口、双语标题均可渲染',()=>{
  const {NetworkExemptDialog}=require(path.join(root,'src/components/detector/NetworkExemptDialog.tsx'));
  const html=renderToStaticMarkup(React.createElement(NetworkExemptDialog,{locale:'zh',busy:false,onClose:()=>{},onSaved:()=>{}}));
  assert.match(html,/内网直连（VPN \/ 公司网络）/);
  assert.match(html,/域名后缀/); assert.match(html,/IP \/ CIDR/); assert.match(html,/DNS 解析/);
  assert.match(html,/严格路由（推荐）/);
  assert.match(html,/>保存并重启内核</);
  assert.match(html,/>关闭</);
  const en=renderToStaticMarkup(React.createElement(NetworkExemptDialog,{locale:'en',busy:false,onClose:()=>{},onSaved:()=>{}}));
  assert.match(en,/Local network direct \(VPN \/ corporate\)/);
  assert.match(en,/Save &amp; restart kernel/);
});

test('内网直连摘要：只说人话，不泄露内核规则语法',()=>{
  const {exemptSummary}=require(path.join(root,'src/components/detector/NetworkExemptDialog.tsx'));
  const full=exemptSummary(true,{domains:['onmicro.ic'],addresses:['203.0.113.7'],dnsServers:['10.10.10.5#ENVGUARD-LOCAL-DNS'],directInterface:'以太网 2'});
  assert.equal(full,'内网域名 onmicro.ic · 豁免 IP 1 个 · 内网 DNS 10.10.10.5 · 走网卡 以太网 2');
  assert.doesNotMatch(full,/DOMAIN-SUFFIX|IP-CIDR|ENVGUARD-LOCAL/);
  // 没有配置时给结论与下一步，而不是一排 0。
  const empty=exemptSummary(true,{domains:[],addresses:[],dnsServers:[],directInterface:''});
  assert.match(empty,/会被当成公网/);
  assert.doesNotMatch(empty,/0 个/);
  const many=exemptSummary(false,{domains:['a.example','b.example','c.example'],addresses:[],dnsServers:[],directInterface:''});
  assert.match(many,/Internal domains a\.example, b\.example \+1/);
  assert.match(many,/DNS follows system/);
});

test('内网直连弹窗：域名区有「测试解析」入口，且默认不暴露规则语法',()=>{
  const {NetworkExemptDialog}=require(path.join(root,'src/components/detector/NetworkExemptDialog.tsx'));
  const html=renderToStaticMarkup(React.createElement(NetworkExemptDialog,{locale:'zh',busy:false,onClose:()=>{},onSaved:()=>{}}));
  assert.match(html,/>测试解析</);
  assert.doesNotMatch(html,/DOMAIN-SUFFIX|IP-CIDR,/);
  const en=renderToStaticMarkup(React.createElement(NetworkExemptDialog,{locale:'en',busy:false,onClose:()=>{},onSaved:()=>{}}));
  assert.match(en,/Test resolution/);
});

test('检测项分层：环境固有与链路项不计入「异常项目」，但仍在保护范围外边列出',()=>{
  const { signalRequirement, partitionIssues, requirementLabel } = require(path.join(root,'src/detection/signal-requirement.ts'));
  assert.equal(signalRequirement('chineseFonts'),'environment');
  assert.equal(signalRequirement('emojiStyle'),'environment');
  assert.equal(signalRequirement('claudeReachability'),'link');
  assert.equal(signalRequirement('country'),'link');
  assert.equal(signalRequirement('language'),'rewritable');
  assert.equal(signalRequirement('timezone'),'rewritable');
  const parts = partitionIssues([{id:'language'},{id:'chineseFonts'},{id:'emojiStyle'},{id:'claudeReachability'}]);
  assert.deepEqual(parts.actionable.map((item)=>item.id),['language']);
  assert.deepEqual(parts.environment.map((item)=>item.id),['chineseFonts','emojiStyle']);
  assert.deepEqual(parts.link.map((item)=>item.id),['claudeReachability']);
  assert.equal(requirementLabel(true,'environment'),'环境固有限制');

  const {ProtectionWorkspace} = require(path.join(root,'src/components/detector/ProtectionWorkspace.tsx'));
  const {verificationScores} = require(path.join(root,'src/detection/verification-score.ts'));
  const flagged = (id,label)=>({id,label,value:'命中',score:1,weight:16,contribution:16,assessment:'warning',source:'browser',testedAt:new Date().toISOString()});
  const browserSignals=[flagged('chineseFonts','字体地区特征'),flagged('emojiStyle','Emoji 渲染风格')];
  const html = renderToStaticMarkup(React.createElement(ProtectionWorkspace,{
    locale:'zh',report:{phase:'idle',enabled:false,issues:[],history:[],monitoring:true,intervalMs:300000},connected:true,busy:false,
    scores:verificationScores(null,null),geo:null,target:null,baseline:null,browser:browserSignals,claude:[],signals:browserSignals,cards:null,
    filter:'all',search:'',onFilter:()=>{},onSearch:()=>{},onToggle:()=>{},onMonitor:()=>{},onRefresh:()=>{},onSelect:()=>{},
  }));
  // 两项都属于环境固有：异常项目计数为 0，但它们仍会在「保护范围外」出现。
  assert.match(html,/workspace-heading-count">0</);
  assert.match(html,/保护范围外 · 2/);
  assert.match(html,/环境固有限制/);
});

test('检测项分层：出口类型与 IP 情报交叉核对属于链路项',()=>{
  const { signalRequirement } = require(path.join(root,'src/detection/signal-requirement.ts'));
  for (const id of ['exitType','multiSourceConsistency','asn','gatewayAsn','webrtcRegion','proxyCountry']) assert.equal(signalRequirement(id),'link',id);
  for (const id of ['language','languageVariant','locale','timezone','timezoneOffset','webrtcLeak','dnsConsistency']) assert.equal(signalRequirement(id),'rewritable',id);
  for (const id of ['chineseFonts','emojiStyle','vendorFonts','domesticDevice']) assert.equal(signalRequirement(id),'environment',id);
});

test('保护检测采样前自动同步浏览器环境，普通扫描保持原样，同步失败可重试', async () => {
  const source = fs.readFileSync(path.join(root, 'src/components/detector/Detector.tsx'), 'utf8');
  const file = ts.createSourceFile('Detector.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'runAll') callback = node.initializer.arguments[0].getText(file);
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(callback);
  const script = ts.transpile(`const scan = ${callback}`, { target: ts.ScriptTarget.ES2022 }) + '\nscan;';
  for (const scenario of ['protected', 'ordinary', 'failed']) {
    const events = [];
    const scanTask = { current: null }, scanLock = { current: false };
    let fail = scenario === 'failed';
    const scan = require('node:vm').runInNewContext(script, {
      scanTask, scanLock, scanVersion: { current: 0 },
      async synchronizeBrowserCloak() {
        events.push('sync');
        if (fail) throw new Error('browser sync failed');
        await Promise.resolve();
        events.push('synced');
        return { enabled: true };
      },
      setBrowserCloak: () => events.push('report'),
      async runBrowserScan() { events.push('scan'); return { signals: [] }; },
      async checkGateway() { return { signals: [] }; },
      normalizeRegion: value => value, locale: 'zh', detectorText: {},
      crypto: { randomUUID: () => 'sample' },
      setRunning() {}, setCheckError() {}, setBrowserScan() {}, setClaudeCheck() {},
      setOptimization() {}, setPointResults() {}, setExitGeo() {}, setCompletedSample() {},
    });
    const options = scenario === 'ordinary' ? {} : { runId: 'startup-run' };
    if (fail) {
      await assert.rejects(scan(options), /browser sync failed/);
      assert.deepEqual(events, ['sync']);
      assert.equal(scanTask.current, null);
      assert.equal(scanLock.current, false);
      fail = false;
      events.length = 0;
    }
    await scan(options);
    assert.deepEqual(events, scenario === 'ordinary' ? ['scan'] : ['sync', 'synced', 'report', 'scan']);
  }
});

test('浏览器迷惑层：概览里能看见状态与「启动保护浏览器」入口',()=>{
  const {ProtectionWorkspace} = require(path.join(root,'src/components/detector/ProtectionWorkspace.tsx'));
  const {verificationScores} = require(path.join(root,'src/detection/verification-score.ts'));
  const props = {locale:'zh',report:{phase:'idle',enabled:false,issues:[],history:[],monitoring:true,intervalMs:300000},connected:true,busy:false,scores:verificationScores(null,null),geo:null,target:null,baseline:null,browser:[],claude:[],signals:[],cards:null,filter:'all',search:'',onFilter:()=>{},onSearch:()=>{},onToggle:()=>{},onMonitor:()=>{},onRefresh:()=>{},onSelect:()=>{}};
  const html = renderToStaticMarkup(React.createElement(ProtectionWorkspace,props));
  assert.match(html,/浏览器模拟保护/);
  assert.match(html,/启动保护浏览器/);
  // 未接入时不冒充已验证。
  assert.match(html,/未跟随网关/);
  const en = renderToStaticMarkup(React.createElement(ProtectionWorkspace,{...props,locale:'en'}));
  assert.match(en,/Launch protected browser/);
});

test('本地浏览器弹窗：说明边界、列出选项、双语可渲染',()=>{
  const {BrowserPickerDialog}=require(path.join(root,'src/components/detector/BrowserPickerDialog.tsx'));
  const html=renderToStaticMarkup(React.createElement(BrowserPickerDialog,{locale:'zh',busy:false,onClose:()=>{},onSaved:()=>{},onLink:()=>{}}));
  assert.match(html,/本地浏览器/);
  // 边界必须写明：接管的是受管实例，不动正在用的窗口。
  assert.match(html,/不会被接管，也不会被改动/);
  assert.match(html,/正在识别本机浏览器/);
  const en=renderToStaticMarkup(React.createElement(BrowserPickerDialog,{locale:'en',busy:false,onClose:()=>{},onSaved:()=>{},onLink:()=>{}}));
  assert.match(en,/Local browsers/);
  assert.match(en,/neither taken over nor modified/);
});

test('reference result table keeps failed, passing and inapplicable sides independent', () => {
  const {SignalTable} = require(path.join(root,'src/components/detector/SignalTable.tsx'));
  const at = '2026-11-08T00:00:00Z';
  const language = {id:'language',label:'Language',value:'ko-KR',testedAt:at,assessment:'ok',contribution:0};
  const timezone = {...language,id:'timezone',label:'Timezone',value:'Asia/Seoul'};
  const html = renderToStaticMarkup(React.createElement(SignalTable, {
    locale:'en',signals:[language,timezone],browser:[{...language,value:'zh-CN',assessment:'warning',contribution:20},timezone],claude:[language,timezone],onSelect:()=>{},
  }));
  assert.match(html, /zh-CN<\/span><span[^>]*data-result="failed"/);
  assert.match(html, /ko-KR<\/span><span[^>]*data-result="passed"/);
  assert.equal((html.match(/Asia\/Seoul/g) ?? []).length, 1, 'browser-only timezone must not acquire a client observation');
  assert.match(html, /data-result="not_applicable"[^>]*>N\/A/);
  assert.match(html, /aria-haspopup="dialog"/);
});

test('normalized score display preserves the original weighted measurement and empty state', () => {
  const {ScoreMeter} = require(path.join(root,'src/components/detector/ScoreMeter.tsx'));
  const render = value => renderToStaticMarkup(React.createElement(ScoreMeter,{value,maximum:150,normalized:true,label:'Weighted score',pending:'Not tested'}));
  const measured = render(75);
  assert.match(measured, /<strong>50<small> \/ 100/);
  assert.match(measured, /aria-valuemax="150" aria-valuenow="75"/);
  assert.match(measured, /width:50%/);
  assert.doesNotMatch(render(null), /aria-valuenow/);
  assert.match(render(null), /Not tested/);
});

test('manual exit probing shows IP and region even when the region matches the node name', () => {
  const {NetCorePanel} = require(path.join(root,'src/components/detector/NetCorePanel.tsx'));
  const report = { enabled:true, state:'running', nodes:['Japan 01','Korea 01'], selected:'Japan 01', mode:'rule', routing:{state:'unknown',claude:0,pinned:0,direct:0,total:0,violations:[]} };
  const props = { locale:'en',report,onRefresh:()=>{},onRestart:()=>{},onSelectNode:()=>{},onMeasure:()=>{},onProbeExits:()=>{},onModeChange:()=>{},exitsAt:'2026-11-08T00:00:00Z',exits:{'Japan 01':{ip:'203.0.113.10',countryCode:'JP',country:'Japan'},'Korea 01':{ip:'203.0.113.20',countryCode:'US',country:'United States'}} };
  const html = renderToStaticMarkup(React.createElement(NetCorePanel, props));
  const cards = html.slice(html.indexOf('<ul class="netcore-nodes">'));
  assert.match(cards, /Exit IP<\/span><span>203\.0\.113\.10/);
  assert.match(cards, /Exit region<\/span><span>Japan/);
  assert.match(cards, /Exit IP<\/span><span>203\.0\.113\.20/);
  assert.match(cards, /Exit region<\/span><span>United States/);
  assert.ok(html.indexOf('netcore-scope') < html.indexOf('netcore-nodes'), 'proxy scope must remain above a long node list');
  assert.match(html, /role="tooltip"[^>]*>Measure response latency/);
  assert.match(html, /role="tooltip"[^>]*>Query each node/);
  const unavailable = renderToStaticMarkup(React.createElement(NetCorePanel, {...props,exits:{}}));
  assert.equal((unavailable.match(/data-state="unavailable"/g) ?? []).length, 2);
  assert.match(unavailable, /No exit IP was returned/);
  const before = renderToStaticMarkup(React.createElement(NetCorePanel, {...props,exitsAt:null,exits:{}}));
  assert.doesNotMatch(before, /class="netcore-node__exit"/);
});

test('路径图独立显示普通代理采样，不依赖 Claude 活动，也不按全局模式伪造动效', () => {
  const {TrafficFlow} = require(path.join(root,'src/components/detector/TrafficFlow.tsx'));
  const originalHook = React.useSyncExternalStore;
  const originalWindow = global.window, originalDocument = global.document;
  let reduced = false;
  React.useSyncExternalStore = (_subscribe, snapshot) => snapshot();
  global.window = { matchMedia: () => ({ matches: reduced }) };
  global.document = { hidden: false };
  const report = { state:'running',mode:'global',tunEnabled:true,tunCaptured:true,
    routing:{state:'unknown',claude:0,pinned:0,direct:0,violations:[],sampledAt:new Date().toISOString(),traffic:{proxied:3,direct:0,blocked:0,unknown:0}},
    connectionLog:{available:true,sampledAt:new Date().toISOString(),scope:'all',activeTotal:30,active:Array.from({length:30},(_,i)=>({id:`flow${i}`,host:`site${i}.example.com`,kind:'connection',route:'proxied',chains:['node','AUTO-PROXY'],isClaude:false,endedAt:null}))} };
  const render = (value, locale='zh') => renderToStaticMarkup(React.createElement(TrafficFlow,{report:value,locale,onDetails:()=>{}}));
  try {
    const html = render(report);
    const classifiedReport = { ...report, connectionLog: { ...report.connectionLog, active: [
      { ...report.connectionLog.active[0], id: 'claude-proxy', host: 'api.anthropic.com', isClaude: true },
      { ...report.connectionLog.active[1], id: 'claude-direct', host: 'claude.ai', route: 'direct', isClaude: true },
      { ...report.connectionLog.active[2], id: 'ordinary-proxy', isClaude: false },
    ] } };
    const classified = render(classifiedReport);
    assert.match(classified, /workspace-flow__connection--proxy" data-claude="true"/);
    assert.match(classified, /workspace-flow__connection--direct" data-claude="true"/);
    assert.match(classified, /workspace-flow__connection--proxy" data-claude="false"/);
    assert.match(classified, /<title>Claude · api\.anthropic\.com · 代理出口<\/title>/);
    const flowCss = fs.readFileSync(path.join(root, 'src/components/detector/workspace.css'), 'utf8');
    assert.match(flowCss, /\.workspace-flow__caption\s*\{[^}]*text-align:\s*right/);
    assert.match(flowCss, /--workspace-flow-claude:\s*#2d67a3\b/);
    assert.match(flowCss, /\.workspace-flow__connection\[data-claude="true"\]\s*\{\s*fill:\s*var\(--workspace-flow-claude\)/);
    assert.match(html, /workspace-flow__filament/);
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'src/components/detector/TrafficFlow.tsx'), 'utf8'), /\.pauseAnimations\(/);
    assert.match(html, /代理出口 · 3 条/);
    assert.match(html, /直连 · 0 条/);
    assert.match(html, /workspace-flow__path--proxy" data-verified="true"/);
    assert.doesNotMatch(html, /workspace-flow__path--overseas/);
    assert.match(html, /workspace-flow__connection--proxy/);
    assert.doesNotMatch(html, /workspace-flow__connection--overseas|国内直连/);
    assert.match(html, /<title>site0\.example\.com · 代理出口<\/title>/); assert.doesNotMatch(html, /workspace-flow__more/);
    // 每个粒子带一段名字显隐动画：离开本机后短暂显示、2 秒时隐藏；30 条连接按 10 轮错开，避免同时挤满起点。
    assert.equal((html.match(/attributeName="opacity" values="0;0;1;1;0;0"/g) ?? []).length, 30);
    assert.match(html, /keyTimes="0;0\.0058;0\.0083;0\.0342;0\.0392;1" dur="60s" begin="0\.00s"/);
    assert.match(html, /网络连接流向 · 悬停查看信息，点击打开详情/);
    assert.doesNotMatch(html, /光效为路径示意|光点离开本机时短暂显示主机名/);
    assert.equal((html.match(/role="button"/g) ?? []).length, 30);
    const merged = render({...report,routing:{...report.routing,state:'verified',claude:2,pinned:2,traffic:{proxied:27,direct:1,blocked:0,unknown:0},paths:{proxied:29,direct:1,blocked:0,unknown:0}},connectionLog:{...report.connectionLog,activeTotal:30,active:report.connectionLog.active.map((record,i)=>i===0?{...record,host:'claude.ai',isClaude:true,chains:['node','CLAUDE-PIN']}:record)}});
    assert.match(merged, /代理出口 · 29 条/);
    assert.equal((merged.match(/workspace-flow__node--proxy"/g) ?? []).length, 1);
    assert.doesNotMatch(merged, /workspace-flow__node--overseas|workspace-flow__connection--overseas/);
    assert.doesNotMatch(merged, /workspace-flow__more/);
    assert.equal((merged.match(/role="button"/g) ?? []).length, 30);
    for (const node of ['proxy','direct','gateway']) assert.match(merged, new RegExp('workspace-flow__node--' + node + '[^>]*aria-haspopup="dialog"'));
    assert.match(merged, /点击查看已拦截连接/);
    assert.match(merged, /claude\.ai/);
    const stale = render({...report,connectionLog:{...report.connectionLog,sampledAt:new Date(Date.now()-60000).toISOString()},routing:{...report.routing,sampledAt:new Date(Date.now()-60000).toISOString()}});
    assert.match(stale, /代理出口 · 待采样/);
    assert.doesNotMatch(stale, /workspace-flow__connection--|data-verified="true"/);
    assert.match(stale, /workspace-flow__photon--proxy/);
    assert.match(stale, /网络连接流向 · 悬停查看信息，点击打开详情/);
    const absent = render({...report,connectionLog:undefined,routing:{...report.routing,traffic:undefined}});
    assert.match(absent, /代理出口 · 待采样/);
    assert.doesNotMatch(absent, /workspace-flow__connection--/);
    assert.match(absent, /workspace-flow__photon--direct/);
    assert.doesNotMatch(render({...report,state:'idle'}), /animateMotion/);
    reduced = true;
    const stillClassified = render(classifiedReport);
    assert.match(stillClassified, /workspace-flow__connection--proxy" data-claude="true"/);
    assert.match(stillClassified, /workspace-flow__connection--direct" data-claude="true"/);
    assert.doesNotMatch(stillClassified, /animateMotion/);
    const still = render(report,'en');
    assert.match(still, /Network connection flow · hover for info, select for details/);
    assert.match(still, /Proxy exit · 3 conn\./);
    assert.match(still, /data-verified="true"/);
    assert.doesNotMatch(still, /animateMotion/);
    assert.doesNotMatch(still, /attributeName="opacity" values="0;0;1;1;0;0"/);
  } finally {
    React.useSyncExternalStore = originalHook;
    if (originalWindow === undefined) delete global.window; else global.window = originalWindow;
    if (originalDocument === undefined) delete global.document; else global.document = originalDocument;
  }
});
