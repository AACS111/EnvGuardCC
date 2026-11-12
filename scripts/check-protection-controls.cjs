/* eslint-disable @typescript-eslint/no-require-imports -- Exercise real TSX without adding a test dependency. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const test = require('node:test');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const root = path.resolve(__dirname, '..');
const nativeResolve = Module._resolveFilename;
Module._resolveFilename = function(id, parent, ...rest) {
  return nativeResolve.call(this, id.startsWith('@/') ? path.join(root, 'src', id.slice(2)) : id, parent, ...rest);
};
for (const extension of ['.ts', '.tsx']) {
  require.extensions[extension] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, filename);
}
const { ProtectionWorkspace } = require(path.join(root, 'src/components/detector/ProtectionWorkspace.tsx'));
const { AppUpdateDialog } = require(path.join(root, 'src/components/detector/AppUpdateNotice.tsx'));
const { HostAuthorizationDialog } = require(path.join(root, 'src/components/detector/HostAuthorizationDialog.tsx'));
const { ReleaseNotes } = require(path.join(root, 'src/components/detector/ReleaseNotes.tsx'));
test('防火墙确认界面说明系统范围、持久影响，并提供取消与明确开启按钮', () => {
  const props = { locale: 'zh', platform: 'win32', mode: 'firewall', error: '', busy: false, onAuthorize() {}, onClose() {} };
  const html = renderToStaticMarkup(React.createElement(HostAuthorizationDialog, props));
  assert.match(html, /开启 Windows 防火墙/);
  assert.match(html, /域网络、专用网络和公用网络/);
  assert.match(html, /退出 EnvGuardCC 后防火墙仍保持开启/);
  assert.match(html, /暂不/);
  assert.match(html, /确认开启并继续/);
  const busy = renderToStaticMarkup(React.createElement(HostAuthorizationDialog, { ...props, busy: true }));
  assert.match(busy, /disabled=""/);
});
test('前端只在显式确认后发送 confirmed:true，缺省值不能代表同意', async () => {
  const { controlNetCore } = require(path.join(root, 'src/detection/gateway-check.ts'));
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true }) }; };
  try {
    await controlNetCore('enable-firewall');
    await controlNetCore('enable-firewall', undefined, { confirmed: true });
    assert.deepEqual(requests, [{ action: 'enable-firewall', confirmed: false }, { action: 'enable-firewall', confirmed: true }]);
  } finally { globalThis.fetch = original; }
});
const { verificationScores } = require(path.join(root, 'src/detection/verification-score.ts'));
const workspace = (phase, props = {}) => {
  const html = renderToStaticMarkup(React.createElement(ProtectionWorkspace, {
    locale: 'zh', connected: true, busy: false, report: { phase, enabled: phase === 'active', issues: [], history: [] },
    browser: [], claude: [], signals: [], scores: verificationScores([], []), baseline: null, geo: null, target: null,
    cards: null, filter: 'all', search: '', ...props,
  }));
  return html;
};
const button = (phase, props = {}) => workspace(phase, props).match(/<button[^>]*class="repair-button workspace-power"[^>]*>[^<]*<\/button>/)[0];

test('网络自动恢复告警始终提供立即复检，忙碌时禁用并保留失败原因', () => {
  const props = {
    netCore: { state: 'running', nodes: [], regionLock: { locked: true, type: 'network', autoRecover: true, recheckAttempts: 3 } },
    onNetCoreUnlockRegion: () => {},
  };
  const html = workspace('active', props);
  assert.match(html, /也可点击.*立即复检/);
  assert.match(html, /<button[^>]*>立即复检<\/button>/);
  const notice = html.match(/<div class="workspace-notices" data-tone="error" role="alert">([\s\S]*?)<\/div>/)?.[1];
  assert.ok(notice);
  assert.doesNotMatch(notice, /无需手动操作/);
  const pending = workspace('active', { ...props, netCoreBusy: true });
  assert.match(pending, /<button[^>]*disabled=""[^>]*aria-busy="true"[^>]*>复检中…<\/button>/);
  const failed = workspace('active', { ...props, netCoreError: '固定出口探测超时' });
  assert.match(failed, /固定出口探测超时/);
  assert.match(failed, /<button[^>]*>立即复检<\/button>/);
  assert.match(workspace('active', { ...props, locale: 'en' }), /Recheck now/);
});

test('侧栏提供更新入口与当前版本，未检查时不宣称已是最新或可更新', () => {
  const html = workspace('idle');
  assert.match(html, /class="workspace-text-link workspace-update__button" aria-haspopup="dialog"/);
  assert.match(html, /检查更新/);
  assert.match(html, new RegExp(`workspace-update__version">v${require('../package.json').version.replaceAll('.', '\\.')}`));
  assert.doesNotMatch(html, /可更新|当前无需更新/);
});

test('更新弹窗仅在匹配安装包可用时提供下载，版本说明不执行 HTML', () => {
  const report = { currentVersion: '0.1.3', latestVersion: '0.2.0', status: 'available',
    downloadUrl: 'https://github.com/community/EnvGuardCC/releases/download/v0.2.0/EnvGuardCC-Setup-0.2.0.exe',
    releaseUrl: 'https://github.com/community/EnvGuardCC/releases/tag/v0.2.0', notes: '<script>run()</script>',
  };
  const render = value => renderToStaticMarkup(React.createElement(AppUpdateDialog, { locale: 'zh', report: value, busy: false, failed: false }));
  const html = render(report);
  assert.match(html, /发现新版本 v0.2.0/);
  assert.ok(html.includes(`href="${report.downloadUrl}"`));
  assert.match(html, /等待配置恢复完成/);
  assert.doesNotMatch(html, /<script>/);
  for (const status of ['pending', 'unsupported', 'current', 'no-release']) {
    assert.doesNotMatch(render({ ...report, status }), /下载新版本/);
  }
});

test('真实发布说明渲染为标题、列表与行内代码，不再显示 Markdown 标记', () => {
  const notes = fs.readFileSync(path.join(root, 'docs/releases/v0.1.3.md'), 'utf8');
  const html = renderToStaticMarkup(React.createElement(ReleaseNotes, { baseUrl: 'https://github.com/AACS111/EnvGuardCC/releases/tag/v0.1.3' }, notes));
  assert.match(html, /<h1>EnvGuardCC 0\.1\.3<\/h1>/);
  assert.match(html, /<h2>下载与安装<\/h2>/);
  assert.match(html, /<h2>验证范围<\/h2>/);
  assert.match(html, /<ul>\s*<li>桌面宿主/);
  assert.match(html, /<code>EnvGuardCC-Setup-0\.1\.3\.exe<\/code>/);
  assert.doesNotMatch(html, /# EnvGuardCC|## 下载与安装|`EnvGuardCC-Setup/);
});

test('发布说明支持 GFM 表格、任务列表、引用、代码块和安全链接', () => {
  const notes = '**修复**与~~旧行为~~\n\n> 升级说明\n\n1. 下载\n2. 安装\n\n- [x] 完成\n\n| 平台 | 状态 |\n| --- | --- |\n| Mac | 支持 |\n\n```sh\npnpm build\n```\n\n[反馈](../../issues/1)';
  const html = renderToStaticMarkup(React.createElement(ReleaseNotes, { baseUrl: 'https://github.com/community/EnvGuardCC/releases/tag/v0.2.0' }, notes));
  for (const tag of ['strong', 'del', 'blockquote', 'ol', 'table', 'th', 'td', 'pre']) assert.ok(html.includes(`<${tag}`), tag);
  assert.match(html, /type="checkbox" disabled="" checked=""/);
  assert.match(html, /<code class="language-sh">pnpm build\n<\/code>/);
  assert.match(html, /href="https:\/\/github.com\/community\/EnvGuardCC\/issues\/1" target="_blank" rel="noreferrer"/);
});

test('Markdown 不执行原始 HTML，不生成危险协议链接或自动请求外部图片', () => {
  const notes = '<script>alert(1)</script>\n\n<img src="https://tracking.example/pixel" onerror="alert(2)">\n\n[脚本](javascript:alert%281%29) [数据](data:text/html,hello) [凭据](https://user:password@example.com)\n\n![说明图](https://tracking.example/image.png)';
  const html = renderToStaticMarkup(React.createElement(ReleaseNotes, {}, notes));
  assert.doesNotMatch(html, /<script|<img|onerror|href="(?:javascript:|data:)|user:password|tracking\.example/);
  assert.match(html, /说明图/);
});

test('更新检查失败与限流可见，不冒充无需更新；英文界面有对应提示', () => {
  for (const [locale, expected] of [['zh', 'GitHub 请求受限'], ['en', 'GitHub is limiting requests']]) {
    const html = renderToStaticMarkup(React.createElement(AppUpdateDialog, {
      locale, report: { currentVersion: '0.1.3', status: 'error', error: 'rate-limit' }, busy: false, failed: true,
    }));
    assert.ok(html.includes(expected));
    assert.match(html, /role="alert"/);
    assert.doesNotMatch(html, /当前无需更新|No update is needed|下载新版本|Download update/);
  }
});

test('Windows 与 IANA 时区按同一地区比较，真实不匹配仍提醒', () => {
  const report = { phase: 'active', enabled: true, issues: [], history: [], systemTimezone: 'Korea Standard Time' };
  assert.doesNotMatch(workspace('active', { report, target: { timezone: 'Asia/Seoul' } }), /系统时区是/);
  assert.match(workspace('active', { report, target: { timezone: 'America/New_York' } }), /系统时区是/);
});

test('IPv6 状态放在出口结论内，区分双栈、降级及失败', () => {
  const report = { phase: 'active', enabled: true, issues: [], history: [] };
  const render = ipv6 => workspace('active', { report, netCore: { state: 'running', tunEnabled: true, ipv6 } });
  const unknown = render({ supported: null, system: 'unknown', protected: false, reason: 'TLS failed' });
  assert.match(unknown, /IPv6.*未确认/);
  assert.doesNotMatch(unknown, /已关闭系统 IPv6/);
  assert.equal((unknown.match(/class="workspace-alert"/g) ?? []).length, 0);
  const conclusion = unknown.match(/class="netcore-conclusion__body">([\s\S]*?)class="netcore-conclusion__state"/);
  assert.ok(conclusion, '出口结论卡片必须存在');
  assert.match(conclusion[1], /class="netcore-ipv6" data-tone="danger" role="alert"/);
  assert.match(conclusion[1], /IPv6.*未确认/);
  const disabled = render({ supported: false, system: 'disabled', protected: false });
  assert.match(disabled, /class="netcore-ipv6" data-tone="muted"/);
  assert.match(disabled, /已关闭系统 IPv6/);
  const protectedHtml = render({ supported: true, system: 'unchanged', protected: true });
  assert.match(protectedHtml, /class="netcore-ipv6" data-tone="muted"/);
  assert.match(protectedHtml, /IPv6.*保护隧道/);
});

test('关闭请求期间保持加载并允许用户重试', () => {
  for (const phase of ['active', 'idle']) {
    const html = button(phase, { powerAction: 'stop' });
    assert.doesNotMatch(html, /disabled=""/);
    assert.match(html, /aria-busy="true"/);
    assert.match(html, />重试关闭<\/button>/);
  }
  assert.doesNotMatch(button('idle'), /disabled=""/);
  assert.match(button('idle'), />启动环境防护<\/button>/);
  assert.doesNotMatch(button('active'), /disabled=""/);
  assert.match(button('active'), />关闭环境防护<\/button>/);
});

test('启停和检测分阶段显示，保护按钮始终保留操作入口', () => {
  for (const powerAction of ['start', 'stop']) {
    const html = workspace('active', { powerAction, busy: true, checking: true });
    assert.doesNotMatch(html, /检测中…/);
    assert.match(html, />检测<\/button>/);
  }
  for (const phase of ['starting', 'stopping']) {
    assert.doesNotMatch(workspace(phase, { checking: true }), /检测中…/);
  }
  for (const phase of ['active', 'idle']) {
    const props = { busy: true, checking: true };
    assert.match(workspace(phase, props), /aria-busy="true"[^>]*>检测中…<\/button>/);
    const power = button(phase, props);
    assert.doesNotMatch(power, /disabled=""/);
    assert.match(power, /aria-busy="false"/);
    assert.ok(power.includes(phase === 'active' ? '>关闭环境防护</button>' : '>启动环境防护</button>'));
  }
});

test('后台检测不改变检测按钮文案，不禁用保护和网络模式；主动检测仅锁本按钮', () => {
  const report = { phase: 'active', enabled: true, testing: true, issues: [], history: [] };
  for (const checking of [false, true]) {
    const html = workspace('active', { report, checking, busy: false });
    assert.doesNotMatch(button('active', { report, checking, busy: false }), /disabled=""/);
    const modes = html.match(/<button[^>]*class="netcore-mode"[^>]*>/g) ?? [];
    assert.equal(modes.length, 3);
    for (const mode of modes) assert.doesNotMatch(mode, /disabled=""/);
    if (checking) assert.match(html, /disabled="" aria-busy="true"[^>]*>检测中…<\/button>/);
    else { assert.match(html, />检测<\/button>/); assert.doesNotMatch(html, /检测中…/); }
  }
});

test('下降提醒使用固定文案，持续低分不因百分比变化反复播报', () => {
  const report = { phase: 'active', enabled: true, issues: [], history: [], alarm: true };
  assert.equal(workspace('active', { report: { ...report, scoreDropPercent: 40 } }), workspace('active', { report: { ...report, scoreDropPercent: 60 } }));
  assert.match(workspace('active', { report }), /下降至少40%/);
});

test('节点变化后仍显示关闭保护，先关闭再启动以重新适配', () => {
  const report = { phase: 'restart_required', enabled: true, issues: [], history: [], testState: 'stale' };
  assert.match(button('restart_required', { report }), />关闭环境防护<\/button>/);
  assert.doesNotMatch(button('restart_required', { report }), /disabled=""/);
  assert.match(button('restart_required', { report, powerAction: 'start' }), />启动中<\/button>/);
  assert.doesNotMatch(button('restart_required', { report, powerAction: 'start' }), /disabled=""/);
});

test('启动和关闭期间按钮可重试，同时保留可访问的加载状态', () => {
  for (const [phase, label] of [['starting', '启动中'], ['stopping', '重试关闭']]) {
    const html = button(phase);
    assert.doesNotMatch(html, /disabled=""/);
    assert.match(html, /aria-busy="true"/);
    assert.ok(html.includes(`>${label}</button>`));
  }
});

test('保护控制只有一个按钮和两种文案，部分验证不新增状态，恢复失败仍可重试关闭', () => {
  for (const enabled of [true, false]) {
    const report = { phase: 'partial', enabled, issues: ['浏览器未验证'], history: [] };
    const html = workspace('partial', { report });
    assert.doesNotMatch(html, /部分生效|Partially verified|workspace-state/);
    assert.match(button('partial', { report }), new RegExp(`data-enabled="${enabled}"`));
    assert.ok(button('partial', { report }).includes(enabled ? '>关闭环境防护</button>' : '>启动环境防护</button>'));
    assert.match(html, /浏览器未验证/);
    assert.equal((html.match(/class="repair-button workspace-power"/g) ?? []).length, 1);
  }
  const report = { phase: 'restore_failed', enabled: false, issues: ['恢复失败'], history: [] };
  assert.doesNotMatch(button('restore_failed', { report }), /disabled=""/);
  assert.match(button('restore_failed', { report }), />关闭环境防护<\/button>/);
  assert.match(workspace('idle', { connected: false }), /本机服务未连接/);
  assert.doesNotMatch(button('idle', { connected: false }), /disabled=""/);
});

test('单按钮文案与动作一致，节点变化和恢复失败时点击关闭不会误启动', () => {
  const jsxRuntime = require('react/jsx-runtime');
  const nativeJsx = jsxRuntime.jsx;
  let click;
  jsxRuntime.jsx = (type, props, ...rest) => {
    if (type === 'button' && props.className === 'repair-button workspace-power') click = props.onClick;
    return nativeJsx(type, props, ...rest);
  };
  try {
    for (const phase of ['idle', 'active', 'partial', 'restart_required', 'restore_failed']) {
      let action;
      const report = { phase, enabled: ['active', 'partial', 'restart_required'].includes(phase), issues: [], history: [] };
      workspace(phase, { report, onToggle: () => { action = 'start'; }, onStop: () => { action = 'stop'; } });
      click();
      assert.equal(action, phase === 'idle' ? 'start' : 'stop');
    }
  } finally { jsxRuntime.jsx = nativeJsx; }
});

test('保护操作等待配置锁，重复浏览器同步共享进行中的结果', { timeout: 15000 }, async t => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkcc-stop-lock-'));
  const previous = process.env.CHECKCC_STATE_DIR;
  const previousGateway = process.env.CHECKCC_GATEWAY_URL;
  let releaseGateway, gatewaySeen;
  let holdGateway = false;
  const gateway = http.createServer((_request, response) => {
    const reply = () => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ version: 1, cloak: { enabled: false, updatedAt: 'one' } })); };
    if (holdGateway) { holdGateway = false; releaseGateway = reply; gatewaySeen?.(); }
    else reply();
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  process.env.CHECKCC_GATEWAY_URL = 'http://127.0.0.1:' + gateway.address().port;
  process.env.CHECKCC_STATE_DIR = stateDir;
  const { startRepairHelper } = await import(pathToFileURL(path.join(root, 'scripts/local-repair.mjs')));
  const helper = await startRepairHelper(0);
  let held;
  t.after(async () => {
    held?.end(); releaseGateway?.();
    await helper.closeRuntime();
    gateway.closeAllConnections();
    await new Promise(resolve => gateway.close(resolve));
    if (previousGateway === undefined) delete process.env.CHECKCC_GATEWAY_URL; else process.env.CHECKCC_GATEWAY_URL = previousGateway;
    helper.server.closeAllConnections();
    await new Promise(resolve => helper.server.close(resolve));
    if (previous === undefined) delete process.env.CHECKCC_STATE_DIR; else process.env.CHECKCC_STATE_DIR = previous;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  const headers = { Origin: 'http://localhost:3000', 'X-CheckCC-Client': 'repair-ui', 'Content-Type': 'application/json' };
  const session = await (await fetch(helper.url + '/session', { headers })).json();
  const lightweight = await (await fetch(helper.url + '/session?tokenOnly=1', { headers })).json();
  assert.deepEqual(lightweight, { token: session.token });
  assert.equal((await fetch(helper.url + '/session?tokenOnly=1')).status, 403);
  headers['X-CheckCC-Token'] = session.token;
  const inactive = await fetch(helper.url + '/protection', { method: 'POST', headers, body: JSON.stringify({ action: 'resume' }) });
  assert.equal(inactive.status, 200); assert.equal((await inactive.json()).enabled, false);
  const requestSeen = () => new Promise(resolve => helper.server.once('request', resolve));
  const heldSeen = requestSeen();
  const heldResult = new Promise((resolve, reject) => {
    held = http.request(helper.url + '/environment', { method: 'POST', headers }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    held.on('error', reject);
    held.flushHeaders();
  });
  await heldSeen;
  const stopSeen = requestSeen();
  let finished = false;
  const post = (endpoint, body) => fetch(helper.url + endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
  const stopping = post('/protection', { action: 'stop' }).then(response => { finished = true; return response; });
  await stopSeen;
  const duplicateSeen = requestSeen();
  const duplicate = post('/protection', { action: 'stop' });
  await duplicateSeen;
  assert.equal((await post('/browser-cloak', {})).status, 409);
  assert.equal(finished, false, 'restoration must wait for the running operation');
  held.end(JSON.stringify({ policy: { country: 'KR' } }));
  assert.equal(await heldResult, 400);
  const stopped = await stopping;
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).phase, 'idle');
  assert.equal((await duplicate).status, 200, '重复关闭也可重试，但必须等待系统写入结束');
  holdGateway = true;
  const seen = new Promise(resolve => { gatewaySeen = resolve; });
  const firstSync = post('/browser-cloak', { force: true });
  await seen;
  const secondSeen = requestSeen();
  const secondSync = post('/browser-cloak', { force: true });
  await secondSeen;
  releaseGateway(); releaseGateway = null;
  const [first, second] = await Promise.all([firstSync, secondSync]);
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.deepEqual(await first.json(), await second.json());
});

function protectionHook(t, request) {
  const states = [], effects = [];
  let wake;
  const nativeLoad = Module._load;
  const hookPath = path.join(root, 'src/components/detector/useProtection.ts');
  delete require.cache[hookPath];
  Module._load = function(id, ...args) {
    if (id === 'react') return {
      useState: value => { const index = states.push(value) - 1; return [value, next => { states[index] = next; }]; },
      useRef: current => ({ current }), useCallback: fn => fn, useEffect: fn => effects.push(fn),
    };
    if (id === '@/detection/protection') return { protectionRequest: request };
    if (id === '@/detection/protection-connection.mjs') return { watchProtectionConnection: fn => { wake = fn; return () => {}; } };
    return nativeLoad.call(this, id, ...args);
  };
  let hook;
  try { hook = require(hookPath).useProtection(); }
  finally { Module._load = nativeLoad; delete require.cache[hookPath]; }
  const originalTimeout = global.setTimeout, originalInterval = global.setInterval;
  let cleanups;
  try {
    global.setTimeout = () => 0; global.setInterval = () => 0;
    cleanups = effects.map(effect => effect());
  } finally { global.setTimeout = originalTimeout; global.setInterval = originalInterval; }
  t.after(() => cleanups.forEach(cleanup => cleanup?.()));
  return { ...hook, wake: (resume = true) => wake({ resume }), state: () => ({ report: states[0], connected: states[1], error: states[2], busy: states[3] }) };
}

test('页面重开读取保护意愿，自动恢复保护并清除错误', async t => {
  const calls = [];
  const active = { enabled: true, desiredEnabled: true, phase: 'active', testState: 'passed' };
  const hook = protectionHook(t, async action => {
    calls.push(action);
    return action === 'resume' ? active : { enabled: false, desiredEnabled: true, phase: 'idle' };
  });
  await hook.refresh();
  assert.deepEqual(calls, [undefined, 'resume']);
  assert.deepEqual(hook.state(), { report: active, connected: true, error: '', busy: false });
});

test('重连失败按退避间隔重试，成功后解除重连状态', async t => {
  const originalNow = Date.now;
  let now = 1000, attempts = 0;
  Date.now = () => now; t.after(() => { Date.now = originalNow; });
  let report = { enabled: false, desiredEnabled: true, phase: 'idle', testState: 'pending' };
  const hook = protectionHook(t, async action => {
    if (action === 'resume') {
      attempts++;
      report = { ...report, enabled: attempts > 1, phase: attempts === 1 ? 'idle' : 'active', testState: attempts === 1 ? 'failed' : 'passed', testError: attempts === 1 ? 'network not ready' : null };
    }
    return report;
  });
  await hook.refresh(); assert.equal(hook.state().error, 'network not ready');
  now += 1000; await hook.refresh(); assert.equal(attempts, 1);
  now += 3000; await hook.refresh(); assert.equal(attempts, 2);
  assert.equal(hook.state().error, ''); assert.equal(hook.state().busy, false);
  await hook.refresh(); assert.equal(attempts, 2);
});

test('服务恢复或普通检测失败时保护仍启用，只读刷新不重新应用配置或锁按钮', async t => {
  let offline = true, attempts = 0;
  const report = { enabled: true, desiredEnabled: true, phase: 'partial', testState: 'failed' };
  const hook = protectionHook(t, async action => {
    if (offline) throw new TypeError('fetch failed');
    if (action === 'resume') attempts++;
    return report;
  });
  await hook.refresh(); assert.equal(hook.state().connected, false);
  offline = false; hook.wake(false);
  await new Promise(resolve => setImmediate(resolve));
  hook.wake(false); await hook.refresh(); assert.equal(attempts, 0);
  assert.equal(hook.state().busy, false);
  assert.equal(hook.state().connected, true); assert.equal(hook.state().error, '');
});

test('手动关闭成功后忽略先前轮询的旧结果，唤醒不重新开启', async t => {
  let release, hold = true, attempts = 0;
  const inactive = { enabled: false, desiredEnabled: false, phase: 'idle' };
  const active = { enabled: true, desiredEnabled: true, phase: 'active', testState: 'passed' };
  const hook = protectionHook(t, async action => {
    if (action === 'stop') return inactive;
    if (action === 'resume') { attempts++; return active; }
    if (hold) return new Promise(resolve => { release = resolve; });
    return inactive;
  });
  const poll = hook.refresh(); await hook.act('stop'); release(active); await poll;
  assert.equal(hook.state().report.enabled, false); assert.equal(attempts, 0);
  hold = false; hook.wake(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 0); assert.equal(hook.state().report.enabled, false);
});

test('休眠唤醒时保护仍显示开启，也重新建立网络并适配环境', async t => {
  let attempts = 0;
  const active = { enabled: true, desiredEnabled: true, phase: 'active', testState: 'passed' };
  const hook = protectionHook(t, async action => { if (action === 'resume') attempts++; return active; });
  await hook.refresh(); assert.equal(attempts, 0);
  hook.wake(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1, '开启状态不能跳过唤醒恢复');
  await hook.refresh(); assert.equal(attempts, 1, '普通轮询不重复适配');
});

test('唤醒时网络未就绪且保护仍开启，继续重试直至恢复', async t => {
  const originalNow = Date.now;
  let now = 1000, attempts = 0;
  Date.now = () => now; t.after(() => { Date.now = originalNow; });
  let report = { enabled: true, desiredEnabled: true, phase: 'active', testState: 'passed' };
  const hook = protectionHook(t, async action => {
    if (action === 'resume') {
      attempts++;
      report = { ...report, phase: attempts > 1 ? 'active' : 'partial', testState: attempts > 1 ? 'passed' : 'failed', testError: attempts > 1 ? null : 'network not ready' };
    }
    return report;
  });
  await hook.refresh(); hook.wake(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1);
  assert.equal(hook.state().error, 'network not ready');
  now += 1000; await hook.refresh(); assert.equal(attempts, 1);
  now += 3000; await hook.refresh(); assert.equal(attempts, 2);
  assert.equal(hook.state().error, '');
});

test('真正唤醒会取消睡眠前未结束的检测，立即请求恢复', async t => {
  let attempts = 0;
  const active = { enabled: true, desiredEnabled: true, phase: 'active', testState: 'passed' };
  const hook = protectionHook(t, async action => {
    if (action === 'resume') { attempts++; return active; }
    return { ...active, testing: true };
  });
  await hook.refresh(); assert.equal(attempts, 0, '普通刷新不打断检测');
  hook.wake(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1);
});

test('恢复过程中再次上线，旧响应不能吞掉新网络的恢复请求', async t => {
  let attempts = 0, release;
  const active = { enabled: true, desiredEnabled: true, phase: 'active', testState: 'passed' };
  const hook = protectionHook(t, async action => {
    if (action === 'resume') {
      attempts++;
      if (attempts === 1) return new Promise(resolve => { release = resolve; });
    }
    return active;
  });
  await hook.refresh(); hook.wake(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1);
  hook.wake(); release(active); await new Promise(resolve => setImmediate(resolve));
  await hook.refresh(); assert.equal(attempts, 2);
  await hook.refresh(); assert.equal(attempts, 2, '成功覆盖最新网络后不重复适配');
});


test('工作台不显示连接、代理选择或时区服务管理面板', () => {
  const html = workspace('active');
  assert.doesNotMatch(html, /连接设置|连接方式|保存连接方式|指定 HTTP|系统时区授权|安装并授权|卸载时区服务/);
});


test('桌面行为开关集中在设置弹窗，网页模式不冒充可修改系统登录项', () => {
  assert.doesNotMatch(workspace('active'), /开机自启动|启动后自动开启保护|workspace-preferences/);
  const {WorkspaceSettingsDialog} = require(path.join(root, 'src/components/detector/WorkspaceSettingsDialog.tsx'));
  const html = renderToStaticMarkup(React.createElement(WorkspaceSettingsDialog, { locale: 'zh', connected: true, busy: false, report: { enabled: true, monitoring: true, intervalMs: 300000 }, network: { locale: 'zh', report: null, busy: false }, dismissedNoticeCount: 0 }));
  assert.doesNotMatch(html, /关闭窗口后保持后台运行|settings-panel-browser|选择浏览器/);
  for (const label of ['开机自启动', '启动后自动开启保护']) {
    assert.ok(html.includes(label));
    assert.ok(html.includes('aria-label="' + label + '" disabled'));
  }
});

test('网络配置集中到设置，保护占用隧道时仍禁止单独切换接管', () => {
  const {NetCoreSettings} = require(path.join(root, 'src/components/detector/NetCoreSettings.tsx'));
  const props = { locale: 'zh', busy: false, tunnelLocked: true, report: { enabled: true, state: 'running', nodes: ['node'], tunEnabled: true, elevation: { platform: 'darwin', elevated: true } }, onTunnelChange: () => {}, onStrictChange: () => {}, onManageSources: () => {}, onAddSource: () => {}, onOpenNetworkConfig: () => {}, onStart: () => {}, onStop: () => {}, onRestart: () => {} };
  const html = renderToStaticMarkup(React.createElement(NetCoreSettings, props));
  assert.match(html, /管理配置/); assert.match(html, /内网直连/);
  const tunnel = html.match(/<button[^>]*role="switch"[^>]*>关闭接管<\/button>/)?.[0];
  assert.ok(tunnel); assert.match(tunnel, /disabled/);
  assert.match(html, /环境防护正在使用隧道/);
  assert.doesNotMatch(workspace('active'), />管理配置<|诊断与高级操作|aria-label="自动检测间隔"/);
  assert.match(workspace('active'), />选择浏览器</);
});

test('已开启的严格模式在平台或节点不可用时仍可从设置恢复联网', () => {
  const {NetCoreSettings} = require(path.join(root, 'src/components/detector/NetCoreSettings.tsx'));
  const props = { locale: 'zh', busy: false, tunnelLocked: false, report: { state: 'unavailable', nodes: [], strictMode: true, guard: { armed: true, phase: 'blocked' }, elevation: { platform: 'win32', elevated: false } }, onStrictChange: () => {} };
  const html = renderToStaticMarkup(React.createElement(NetCoreSettings, props));
  const recovery = html.match(/<button[^>]*role="switch"[^>]*>关闭严格模式并恢复联网<\/button>/)?.[0];
  assert.ok(recovery); assert.doesNotMatch(recovery, /disabled/);
  assert.match(html, /退出应用或异常崩溃后仍保留阻断/);
  assert.match(html, /使用效果/);
  assert.doesNotMatch(html, /出差时让 EGCC|Keep EGCC running/);
  const busy = renderToStaticMarkup(React.createElement(NetCoreSettings, { ...props, busy: true }));
  assert.match(busy.match(/<button[^>]*role="switch"[^>]*>关闭严格模式并恢复联网<\/button>/)?.[0] ?? '', /disabled/);
});

test('应用启动自动开启保护后立即补一轮检测，首屏不会停在尚未检测', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/local-repair.mjs'), 'utf8');
  const startup = source.slice(source.indexOf("if (body.action === 'startup')"), source.indexOf("if (body.action === 'test')"));
  assert.match(startup, /protection\.start\(origin\)/, '启动策略必须真正开启保护');
  assert.match(startup, /protection\.retest\(\)/, '自动启动没有页面参与，必须补一轮检测才能产生得分');
});

test('传输记录卡片与详情固定说明本机存储，支持空状态与真实元数据', () => {
  const { TransferLogCard, TransferRecordDetails, TransferLogDialog } = require(path.join(root, 'src/components/detector/TransferLog.tsx'));
  const record = {id:'conn-a',host:'api.anthropic.com',ip:'203.0.113.4',port:443,chains:['Seoul','CLAUDE-PIN'],rule:'DomainSuffix',rulePayload:'anthropic.com',upload:123,download:4567,startedAt:'2026-11-08T00:00:00Z',endedAt:'2026-11-08T00:00:05Z',isClaude:true,route:'proxied',viaExit:true};
  const data = {ok:true,available:true,storageError:false,retentionHours:48,stats:{active:0,ended:1,total:1},items:[record],recent:[record],total:1,offset:0,limit:50};
  const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, {locale:'zh',...props}));
  const card = render(TransferLogCard,{data,onOpen:()=>{}});
  assert.match(card,/传输记录/); assert.match(card,/数据只存放在本机，不会上传/);
  assert.match(card,/活动 0 条 · 48 小时 1 条/); assert.match(card,/最近 3 条/);
  assert.match(card,/api\.anthropic\.com/); assert.match(card,/已结束/);
  const empty = render(TransferLogCard,{data:null,onOpen:()=>{}});
  assert.match(empty,/暂无传输记录/); assert.doesNotMatch(empty,/role="alert"/);
  const details = render(TransferRecordDetails,{record});
  for (const field of ['数据只存放在本机，不会上传','连接详情','123 B','4567 B','是否 Claude','是否走出口','已走代理出口','命中规则','开始时间','结束时间']) assert.ok(details.includes(field),field);
  assert.doesNotMatch(details,/processPath|authorization|token=/);
  const dialog = render(TransferLogDialog,{data,selected:record,host:'',claude:false,viaExit:'all',offset:0,clearing:false,error:'',onHost:()=>{},onClaude:()=>{},onExit:()=>{},onPage:()=>{},onSelect:()=>{},onClear:()=>{},onClose:()=>{}});
  assert.match(dialog,/仅 Claude/); assert.match(dialog,/清空记录/); assert.match(dialog,/上一页/);
  assert.equal((dialog.match(/数据只存放在本机，不会上传/g)??[]).length,2);
  for (const [route,heading] of [['proxied','代理出口连接'],['direct','直连连接'],['blocked','已拦截连接']]) {
    const collection = render(TransferLogDialog,{data,selected:null,host:'',claude:false,route,recordState:route==='blocked'?'all':'active',offset:0,clearing:false,error:'',onHost:()=>{},onClaude:()=>{},onPage:()=>{},onSelect:()=>{},onClear:()=>{},onClose:()=>{}});
    assert.match(collection,new RegExp('>'+heading+'</h2>'));
    assert.match(collection,/连接路径/); assert.match(collection,/连接状态/);
  }
  const en = render(TransferLogCard,{locale:'en',data,onOpen:()=>{}});
  assert.match(en,/Transfer log/); assert.match(en,/never uploaded/);
});

test('请求详情、导出和回放提供真实元数据与覆盖边界，设置包含仅 Claude/全部', () => {
  const { TransferRecordDetails, TransferLogDialog } = require(path.join(root, 'src/components/detector/TransferLog.tsx'));
  const { ConnectionLogSettings } = require(path.join(root, 'src/components/detector/ConnectionLogSettings.tsx'));
  const record = { id:'request-a',kind:'request',host:'api.anthropic.com',ip:null,port:443,chains:[],rule:'',rulePayload:'',upload:123,download:456,startedAt:'2026-11-08T00:00:00Z',endedAt:'2026-11-08T00:00:01Z',isClaude:true,route:'unknown',viaExit:null,method:'POST',endpoint:'/v1/messages',status:201,elapsedMs:1000,error:null };
  const details = renderToStaticMarkup(React.createElement(TransferRecordDetails, { record,locale:'zh' }));
  for (const content of ['POST','/v1/messages','201','1000 ms','HTTP 网关','不解密','未知']) assert.ok(details.includes(content),content);
  const at = '2026-11-08T00:00:00.500Z';
  const data = {available:false,stats:{active:0,ended:1,total:1},total:1,offset:0,limit:50,items:[record],recent:[record],at};
  const dialog = renderToStaticMarkup(React.createElement(TransferLogDialog, { locale:'zh',data,selected:record,host:'',claude:false,viaExit:'all',offset:0,clearing:false,error:'',kind:'request',at,replayBase:Date.parse('2026-11-08T00:01:00Z'),replayPosition:172740,playing:false,onHost:()=>{},onClaude:()=>{},onExit:()=>{},onPage:()=>{},onSelect:()=>{},onClear:()=>{},onClose:()=>{} }));
  for (const content of ['导出 JSON','导出 CSV','回放时间轴','当时活动 1 条','不解密','最后采样的累计值']) assert.ok(dialog.includes(content),content);
  const settings = renderToStaticMarkup(React.createElement(ConnectionLogSettings,{locale:'zh'}));
  assert.match(settings,/仅 Claude/); assert.match(settings,/>全部</); assert.match(settings,/数据只存放在本机，不会上传/);
});
