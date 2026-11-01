import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { probe } from './gateway-diagnostics.mjs';
import { EnvironmentRuntime } from './environment-runtime.mjs';
import { browserPageState, httpReachability, networkFailure, inspectClaudePage } from './claude-reachability.mjs';
import vm from 'node:vm';

test('HTTP challenge evidence is explicit and never contains response cookies', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(403, { 'cf-mitigated': 'challenge', 'Set-Cookie': 'private-cookie', 'x-private': 'private-value' });
    response.end('private-body');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await probe(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(result.status, 403);
    assert.equal(result.outcome, 'challenge');
    assert.equal(result.challenge, true);
    assert.doesNotMatch(JSON.stringify(result), /private-cookie|private-value|private-body/);
    assert.equal(httpReachability(403), 'access_denied');
    assert.equal(httpReachability(401), 'authentication_required');
    assert.equal(httpReachability(429), 'rate_limited');
    assert.equal(httpReachability(502), 'http_error');
    for (const [code, kind] of [['CERT_HAS_EXPIRED', 'certificate'], ['ENOTFOUND', 'dns'], ['ETIMEDOUT', 'timeout'], ['PROXY_CONNECT_FAILED', 'proxy']]) assert.equal(networkFailure(code), kind);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('DOM classification is origin-bound and cannot manufacture a successful navigation', () => {
  const evaluate = (origin, pathname, title, readyState, selectors = []) => vm.runInNewContext(`(${inspectClaudePage.toString()})()`, {
    location: { origin, pathname }, document: { title, readyState, querySelectorAll: selector => selectors.some(value => selector.includes(value)) ? [{getClientRects: () => [1]}] : [] },
  });
  assert.equal(evaluate('https://evil.example', '/login', '', 'complete', ['form']).state, 'unavailable');
  assert.equal(evaluate('https://claude.ai', '/', 'Just a moment...', 'complete').state, 'challenge');
  assert.equal(evaluate('https://claude.ai', '/login', '', 'complete', ["input[type='email']"]).state, 'login_page');
  assert.equal(evaluate('https://claude.ai', '/', '', 'loading').state, 'loading');
  assert.equal(browserPageState({state:'login_page'}, null), 'loading');
  assert.equal(browserPageState({state:'login_page'}, {status:403}), 'access_denied');
  assert.equal(browserPageState({state:'page_loaded'}, {status:200,error:'dns'}), 'network_error');
});

test('real Chromium updates challenge → login → app → error, reuses the tab, and discards stale route evidence', { timeout: 25000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'checkcc-reachability-'));
  const server = http.createServer((_request, response) => { response.end('<html><body>checker</body></html>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const runtime = new EnvironmentRuntime({stateDir:directory,headless:true,networkProxy:null});
  try {
    assert.equal((await runtime.claudeBrowser(origin)).state, 'unavailable');
    assert.equal(runtime.clients.size, 0, 'read-only checks never launch a browser');
    const instance = await runtime.launch('web', origin);
    const [sessionId] = [...instance.sessions].find(([,item]) => item.type === 'page');
    let status = 403, challenge = true, fail = false;
    let html = '<html><title>Just a moment...</title><body>challenge</body></html>';
    instance.client.listeners.add(event => {
      if (event.method !== 'Fetch.requestPaused') return;
      const params = fail ? { requestId:event.params.requestId,errorReason:'NameNotResolved' } : {
        requestId:event.params.requestId, responseCode:status,
        responseHeaders:[{name:'Content-Type',value:'text/html'}, ...(challenge ? [{name:'cf-mitigated',value:'challenge'}] : [])],
        body:Buffer.from(html).toString('base64'),
      };
      void instance.client.send(fail ? 'Fetch.failRequest' : 'Fetch.fulfillRequest', params, event.sessionId).catch(() => {});
    });
    await instance.client.send('Fetch.enable', {patterns:[{urlPattern:'https://claude.ai/*',resourceType:'Document'}]}, sessionId);
    const navigate = async (url, expected) => {
      await instance.client.send('Page.navigate', {url}, sessionId);
      let result;
      for (let i=0;i<50;i++) {
        result = await runtime.claudeBrowser(origin);
        if (result.state === expected) break;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      assert.equal(result.state,expected,JSON.stringify(result));
      assert.doesNotMatch(JSON.stringify(result), /private-account|private-conversation|claude\.ai/);
      return result;
    };
    await navigate('https://claude.ai/', 'challenge');
    status=200;challenge=false;html="<html><body><form><input type='email'></form>private-account</body></html>";
    await navigate('https://claude.ai/login', 'login_page');
    const before = (await instance.client.send('Target.getTargets')).targetInfos.length;
    assert.equal((await runtime.claudeBrowser(origin,{open:true})).state,'login_page');
    assert.equal((await instance.client.send('Target.getTargets')).targetInfos.length,before,'rechecking reuses the existing session');
    html="<html><body><button data-testid='user-menu-button'>private-account</button><div role='textbox' contenteditable='true'>private-conversation</div></body></html>";
    await navigate('https://claude.ai/new', 'app_ready');
    fail=true;
    const failed = await navigate('https://claude.ai/broken', 'network_error');
    assert.equal(failed.failureKind,'dns');
    runtime.networkProxy={url:new URL('http://127.0.0.1:9')};
    assert.equal((await runtime.claudeBrowser(origin)).state,'route_changed');
    runtime.networkProxy=null;
    await instance.client.send('Target.closeTarget',{targetId:instance.claudeVerificationTarget});
    let closed;
    for (let i=0;i<30;i++) { closed=await runtime.claudeBrowser(origin); if(closed.state==='unavailable') break; await new Promise(resolve=>setTimeout(resolve,50)); }
    assert.equal(closed.state,'unavailable');
  } finally {
    await runtime.close(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
    await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});
