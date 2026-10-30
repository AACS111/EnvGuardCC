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
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, filename);
}
const { ProtectionWorkspace } = require(path.join(root, 'src/components/detector/ProtectionWorkspace.tsx'));
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

test('关闭请求期间保持加载、禁用；结束后才允许再次操作', () => {
  for (const phase of ['active', 'idle']) {
    const html = button(phase, { powerAction: 'stop' });
    assert.match(html, /disabled=""/);
    assert.match(html, /aria-busy="true"/);
    assert.match(html, />关闭保护<\/button>/);
  }
  assert.doesNotMatch(button('idle'), /disabled=""/);
  assert.match(button('idle'), />启动保护<\/button>/);
  assert.doesNotMatch(button('active'), /disabled=""/);
  assert.match(button('active'), />关闭保护<\/button>/);
});

test('启停和检测分阶段显示；启停完成后自动复检期间仍禁止重复操作', () => {
  for (const powerAction of ['start', 'stop']) {
    const html = workspace('active', { powerAction, busy: true, checking: true });
    assert.doesNotMatch(html, /检测中…/);
    assert.match(html, />重新检测<\/button>/);
  }
  for (const phase of ['starting', 'stopping']) {
    assert.doesNotMatch(workspace(phase, { checking: true }), /检测中…/);
  }
  for (const phase of ['active', 'idle']) {
    const props = { busy: true, checking: true };
    assert.match(workspace(phase, props), /aria-busy="true"[^>]*>检测中…<\/button>/);
    const power = button(phase, props);
    assert.match(power, /disabled=""/);
    assert.match(power, /aria-busy="false"/);
    assert.ok(power.includes(phase === 'active' ? '>关闭保护</button>' : '>启动保护</button>'));
  }
});

test('节点变化后仍显示关闭保护，先关闭再启动以重新适配', () => {
  const report = { phase: 'restart_required', enabled: true, issues: [], history: [], testState: 'stale' };
  assert.match(button('restart_required', { report }), />关闭保护<\/button>/);
  assert.doesNotMatch(button('restart_required', { report }), /disabled=""/);
  assert.match(button('restart_required', { report, powerAction: 'start' }), />启动保护<\/button>/);
  assert.match(button('restart_required', { report, powerAction: 'start' }), /disabled=""/);
});

test('页面从服务端读到启动或关闭阶段时仍禁用按钮并提供可访问的加载状态', () => {
  for (const [phase, label] of [['starting', '启动保护'], ['stopping', '关闭保护']]) {
    const html = button(phase);
    assert.match(html, /disabled=""/);
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
    assert.ok(button('partial', { report }).includes(enabled ? '>关闭保护</button>' : '>启动保护</button>'));
    assert.match(html, /浏览器未验证/);
    assert.equal((html.match(/class="repair-button workspace-power"/g) ?? []).length, 1);
  }
  const report = { phase: 'restore_failed', enabled: false, issues: ['恢复失败'], history: [] };
  assert.doesNotMatch(button('restore_failed', { report }), /disabled=""/);
  assert.match(button('restore_failed', { report }), />关闭保护<\/button>/);
  assert.match(workspace('idle', { connected: false }), /本机服务未连接/);
  assert.match(button('idle', { connected: false }), /disabled=""/);
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
  const duplicate = await post('/protection', { action: 'stop' });
  assert.equal(duplicate.status, 409);
  assert.equal((await post('/browser-cloak', {})).status, 409);
  assert.equal(finished, false, 'restoration must wait for the running operation');
  held.end(JSON.stringify({ policy: { country: 'KR' } }));
  assert.equal(await heldResult, 400);
  const stopped = await stopping;
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).phase, 'idle');
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
  return { ...hook, wake: () => wake(), state: () => ({ report: states[0], connected: states[1], error: states[2], busy: states[3] }) };
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
  let report = { enabled: true, desiredEnabled: true, phase: 'active', testState: 'passed' };
  const hook = protectionHook(t, async action => {
    if (action === 'resume') {
      attempts++;
      report = { ...report, testState: attempts === 1 ? 'failed' : 'passed', testError: attempts === 1 ? 'network not ready' : null };
    }
    return report;
  });
  await hook.refresh(); assert.equal(hook.state().error, 'network not ready');
  now += 1000; await hook.refresh(); assert.equal(attempts, 1);
  now += 3000; await hook.refresh(); assert.equal(attempts, 2);
  assert.equal(hook.state().error, ''); assert.equal(hook.state().busy, false);
  await hook.refresh(); assert.equal(attempts, 2);
});

test('服务掉线后恢复自动重连，多个唤醒通知不并发执行保护操作', async t => {
  let offline = true, attempts = 0, release;
  const report = { enabled: true, desiredEnabled: true, phase: 'active', testState: 'passed' };
  const hook = protectionHook(t, async action => {
    if (offline) throw new TypeError('fetch failed');
    if (action === 'resume') { attempts++; await new Promise(resolve => { release = resolve; }); }
    return report;
  });
  await hook.refresh(); assert.equal(hook.state().connected, false);
  offline = false; hook.wake();
  await new Promise(resolve => setImmediate(resolve));
  hook.wake(); await hook.refresh(); assert.equal(attempts, 1);
  release(); await new Promise(resolve => setImmediate(resolve));
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
