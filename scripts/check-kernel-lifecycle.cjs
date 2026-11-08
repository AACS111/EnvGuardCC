/* eslint-disable @typescript-eslint/no-require-imports -- Node test runner uses CommonJS. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const binary = path.resolve(__dirname, '../node_modules/.checkcc-kernel', process.platform === 'win32' ? 'mihomo.exe' : 'mihomo');
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } }
/**
 * 内核刚退出时监听套接字可能还没释放。这里重试到超时，而不是把正常的关闭延迟
 * 当成失败——并行跑多个测试文件时，这种竞态会让整条用例随机红。
 */
async function waitPortReleased(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    const server = net.createServer();
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      await new Promise(resolve => server.close(resolve));
      return;
    } catch (error) { lastError = error; server.close(); }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw lastError;
}
async function assertPortsFree(ports) { for (const port of ports) await waitPortReleased(port); }

test('真实内核反复启停、并发启停、崩溃恢复和启动失败均回收进程与端口', { timeout: 90000 }, async t => {
  try { await fs.access(binary); } catch { t.skip('当前平台未准备内核，执行 pnpm kernel:fetch 后重试'); return; }
  const { createNetCore } = await import('./net-core.mjs');
  const { ensureKernel } = await import('./net-core/vendor.mjs');
  await ensureKernel();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'checkcc-real-kernel-'));
  const apiPort = await freePort(), mixedPort = await freePort();
  const configPath = path.join(directory, 'config.yaml');
  const config = `mixed-port: ${mixedPort}\nmode: direct\nlog-level: warning\nipv6: false\ntun:\n  enable: false\ndns:\n  enable: false\n`;
  await fs.writeFile(configPath, config);
  const pids = [];
  const core = createNetCore({ binary, homeDir: directory, configPath, apiPort, readyTimeoutMs: 10000 });
  async function assertStopped(pid) {
    assert.equal(alive(pid), false, `内核 PID ${pid} 必须消失`);
    await assertPortsFree([apiPort, mixedPort]);
  }
  try {
    for (let i = 0; i < 5; i++) {
      await core.start();
      const pid = core.state().pid; pids.push(pid);
      assert.ok((await core.status()).version);
      await core.stop(); await assertStopped(pid);
      assert.equal(await core.health(), false);
    }
    await Promise.all([core.start(), core.start(), core.restart(), core.stop()]);
    assert.equal(core.state().pid, null);
    await core.start();
    const crashed = core.state().pid; pids.push(crashed);
    process.kill(crashed, 'SIGKILL');
    for (let i = 0; i < 50 && core.state().running; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(await core.health(), true);
    const recovered = core.state().pid; pids.push(recovered);
    assert.notEqual(recovered, crashed);
    await core.stop(); await assertStopped(recovered);
    await fs.writeFile(configPath, 'invalid: [');
    await assert.rejects(core.start(), /启动失败|超时/);
    assert.equal(core.state().pid, null);
    await fs.writeFile(configPath, config);
    await core.start(); const last = core.state().pid; pids.push(last);
    await core.stop(); await assertStopped(last);
  } finally {
    await core.stop();
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('父应用被强杀后守护进程自动回收真实内核', { timeout: 20000 }, async t => {
  try { await fs.access(binary); } catch { t.skip('当前平台未准备内核'); return; }
  const { spawn } = require('node:child_process');
  const { pathToFileURL } = require('node:url');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'checkcc-crash-kernel-'));
  const apiPort = await freePort(), mixedPort = await freePort();
  const configPath = path.join(directory, 'config.yaml');
  await fs.writeFile(configPath, `mixed-port: ${mixedPort}\nmode: direct\nlog-level: warning\ntun:\n  enable: false\ndns:\n  enable: false\n`);
  const moduleUrl = pathToFileURL(path.resolve(__dirname, 'net-core.mjs')).href;
  const source = `import {createNetCore} from ${JSON.stringify(moduleUrl)}; const core=createNetCore(${JSON.stringify({binary,homeDir:directory,configPath,apiPort})}); await core.start(); process.send(core.state()); setInterval(()=>{},1000);`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore','ignore','inherit','ipc'] });
  let state;
  try {
    state = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('parent startup timeout')), 12000);
      parent.once('message', value => { clearTimeout(timer); resolve(value); });
      parent.once('exit', () => { clearTimeout(timer); reject(Error('parent exited before ready')); });
    });
    const exited = new Promise(resolve => parent.once('exit', resolve)); parent.kill('SIGKILL'); await exited;
    for (let i=0; i<100 && (alive(state.pid) || alive(state.supervisorPid)); i++) await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(alive(state.pid), false, '强杀应用后不得遗留内核');
    assert.equal(alive(state.supervisorPid), false, '守护进程也必须回收');
    await assertPortsFree([apiPort, mixedPort]);
  } finally {
    if (parent.exitCode===null && parent.signalCode===null) parent.kill('SIGKILL');
    for (const pid of [state?.pid,state?.supervisorPid]) if(pid && alive(pid)) process.kill(pid,'SIGKILL');
    await fs.rm(directory,{recursive:true,force:true});
  }
});

test('特权宿主心跳失联后自动回收真实内核', { timeout: 20000 }, async t => {
  try { await fs.access(binary); } catch { t.skip('当前平台未准备内核'); return; }
  const { createKernelHost, HOST_TOKEN_HEADER } = await import('./net-core/host.mjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'checkcc-lease-kernel-'));
  const apiPort = await freePort(), mixedPort = await freePort();
  const configPath = path.join(directory,'net-core','config.yaml');
  await fs.mkdir(path.dirname(configPath));
  await fs.writeFile(configPath,`secret: ${'test-controller-secret-'.repeat(3)}\nmixed-port: ${mixedPort}\nmode: direct\nlog-level: warning\ntun:\n  enable: false\ndns:\n  enable: false\n`);
  const host = createKernelHost({ token:'test-lease-token-123456789', binary,stateDir:directory,apiPort,port:0,leaseTimeoutMs:500 });
  const {url}=await host.listen();
  try {
    const response=await fetch(url+'/kernel',{method:'POST',headers:{[HOST_TOKEN_HEADER]:host.token,'Content-Type':'application/json'},body:JSON.stringify({action:'start',configPath})});
    assert.equal(response.status,200);
    assert.equal(host.status().running,true);
    for(let i=0;i<100&&host.status().running;i++) await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(host.status().running,false);
    await assertPortsFree([apiPort]);
  } finally { await host.close(); await fs.rm(directory,{recursive:true,force:true}); }
});

test('真实内核控制器要求密钥，热加载保持原选择', { timeout: 20000 }, async t => {
  try { await fs.access(binary); } catch { t.skip('当前平台未准备内核'); return; }
  const { createNetCore } = await import('./net-core.mjs');
  const { buildKernelConfig, serializeKernelConfig } = await import('./net-core/config.mjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'checkcc-controller-'));
  const apiPort = await freePort(), mixedPort = await freePort();
  const configPath = path.join(directory, 'config.yaml');
  const secret = 'controller-test-secret-'.repeat(3);
  const proxies = ['a', 'b'].map(name => ({ name, type:'http', server:'127.0.0.1', port:9 }));
  const config = buildKernelConfig({ proxies, selected:'a', apiPort, mixedPort, secret });
  config.authentication = [`egcc:${secret}`];
  config.tun.enable = false; config.dns.enable = false;
  await fs.writeFile(configPath, serializeKernelConfig(config));
  const core = createNetCore({ binary, homeDir:directory, configPath, apiPort, secret });
  try {
    await core.start();
    assert.equal((await fetch(`http://127.0.0.1:${apiPort}/proxies`)).status, 401);
    const { fetchTextViaProxy } = await import('./net-core/subscription.mjs');
    await assert.rejects(fetchTextViaProxy('http://203.0.113.77/',{proxy:`http://127.0.0.1:${mixedPort}`}), /407|PROXY_AUTH/);
    await core.selectProxy('CLAUDE-PIN', 'b');
    await fs.writeFile(configPath, serializeKernelConfig(config));
    await core.reloadFromFile();
    assert.equal((await core.request('/proxies/CLAUDE-PIN')).now, 'b');
  } finally { await core.stop(); await fs.rm(directory, {recursive:true,force:true}); }
});

test('固定出口探测使用明确节点，不借普通流量组的出口冒充', { timeout:30000 }, async t => {
  try { await fs.access(binary); } catch { t.skip('当前平台未准备内核'); return; }
  const http = require('node:http');
  const { createKernelRuntime } = await import('./net-core/runtime.mjs');
  const { fetchTextViaProxy } = await import('./net-core/subscription.mjs');
  async function proxy(ip, countryCode) {
    const body = JSON.stringify({ip,country_code:countryCode,success:true});
    const server = http.createServer((_, response) => response.end(body));
    const sockets = new Set();
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.destroyConnections = () => { for (const socket of sockets) socket.destroy(); };
    server.on('connect', (_, socket, head) => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      let received = head.toString();
      const respond = chunk => {
        received += chunk.toString();
        if (received.includes('\r\n\r\n')) {
          socket.removeListener('data', respond);
          socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
        }
      };
      socket.on('data', respond);
      socket.on('error', () => {});
      socket.setTimeout(5000, () => socket.destroy());
      // CONNECT 的 head 可能已携带完整请求，不能只等下一次 data。
      respond(Buffer.alloc(0));
    });
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    return server;
  }
  const a = await proxy('203.0.113.1','JP'), b = await proxy('203.0.113.2','KR');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'checkcc-pinned-exit-'));
  const apiPort = await freePort(), mixedPort = await freePort();
  const endpoint = 'http://203.0.113.77/';
  // 固定出口探测必须复用主内核（FlClash 式入站），不能为了一次探测再起临时内核。
  let cores = 0;
  const { createNetCore } = await import('./net-core.mjs');
  const runtime = await createKernelRuntime({stateDir:directory, createCore: (...args) => { cores += 1; return createNetCore(...args); }, env:{
    CHECKCC_NET_CORE_BINARY:binary,CHECKCC_NET_CORE_TUN:'0',CHECKCC_NET_CORE_DNS:'https://192.0.2.53/dns-query',
    CHECKCC_NET_CORE_API_PORT:String(apiPort),CHECKCC_NET_CORE_MIXED_PORT:String(mixedPort),CHECKCC_NET_CORE_EXIT_PROBE_URL:endpoint,
  }});
  try {
    await runtime.importNodes([{name:'a',type:'http',server:'127.0.0.1',port:a.address().port},{name:'b',type:'http',server:'127.0.0.1',port:b.address().port}],{selected:'b'});
    // 普通流量走 AUTO-PROXY（node a）；探测主机 203.0.113.77 被专门钉到 CLAUDE-PIN（node b）。
    const ordinary = JSON.parse(await fetchTextViaProxy('http://203.0.113.78/',{proxy:`http://127.0.0.1:${mixedPort}`}));
    assert.equal(ordinary.ip,'203.0.113.1');
    assert.equal(cores, 1, '主内核应当只启动一次');
    const selected = await runtime.probeSelectedExit();
    assert.equal(selected.ip,'203.0.113.2');
    assert.equal(selected.countryCode,'KR');
    assert.equal(cores, 1, '固定出口探测不得另起临时内核');
    assert.equal((await runtime.report()).selected,'b');
  } finally {
    await runtime.stop();
    for(const server of [a,b]) await new Promise(resolve=>{server.destroyConnections();server.closeAllConnections();server.close(resolve);});
    await fs.rm(directory,{recursive:true,force:true});
  }
});
