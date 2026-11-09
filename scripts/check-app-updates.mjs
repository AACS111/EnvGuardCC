import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateChecker, compareVersions } from './app-updates.mjs';
import { createGateway } from './claude-gateway.mjs';

const repository = 'community/EnvGuardCC';
const asset = (name, tag = 'v0.2.0') => ({ name, state: 'uploaded', size: 1024, browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${name}` });
const release = (extra = {}) => ({ tag_name: 'v0.2.0', draft: false, prerelease: false, body: 'New version\nRelease notes', assets: [asset('EnvGuardCC-Setup-0.2.0.exe'), asset('EnvGuardCC-0.2.0-arm64.dmg')], ...extra });
const checker = (options = {}) => createUpdateChecker({ currentVersion: '0.1.3', repository, platform: 'win32', arch: 'x64', loadRelease: async () => release(), ...options });

test('按 SemVer 比较版本，处理两位数、预发布与构建元数据，不降级', () => {
  for (const [left, right, result] of [
    ['v0.1.10', '0.1.9', 1], ['1.0.0', '0.99.99', 1], ['1.0.0', '1.0.0-beta.3', 1],
    ['1.0.0-beta.10', '1.0.0-beta.2', 1], ['1.0.0-beta', '1.0.0-beta.1', -1],
    ['1.0.0-1', '1.0.0-alpha', -1], ['1.0.0+release.7', '1.0.0+build.1', 0],
    ['0.1.3', '0.2.0', -1], ['0.1.3', '0.1.3', 0], ['0.01.3', '0.1.3', null],
    ['1.0.0-beta.01', '1.0.0', null], ['latest', '0.1.3', null],
  ]) assert.equal(compareVersions(left, right), result, `${left} vs ${right}`);
});

test('为 Windows x64 和 Apple Silicon 选择正确安装包，可回退到便携包', async () => {
  const windows = await checker().check();
  assert.equal(windows.status, 'available');
  assert.equal(windows.currentVersion, '0.1.3');
  assert.equal(windows.assetName, 'EnvGuardCC-Setup-0.2.0.exe');
  assert.equal(windows.releaseUrl, `https://github.com/${repository}/releases/tag/v0.2.0`);
  assert.equal((await checker({ platform: 'darwin', arch: 'arm64' }).check()).assetName, 'EnvGuardCC-0.2.0-arm64.dmg');
  for (const [platform, arch, name] of [['win32', 'x64', 'EnvGuardCC-Windows-x64.zip'], ['darwin', 'arm64', 'EnvGuardCC-macOS-arm64.zip']]) {
    const result = await checker({ platform, arch, loadRelease: async () => release({ assets: [asset(name)] }) }).check();
    assert.equal(result.status, 'available'); assert.equal(result.assetName, name);
  }
  const unsupported = await checker({ platform: 'darwin', arch: 'x64' }).check();
  assert.equal(unsupported.status, 'unsupported');
  assert.equal(unsupported.downloadUrl, undefined);
});

test('草稿、预发布和缺失版本不误报；相同或旧版本不建议更新', async () => {
  for (const value of [null, release({ draft: true }), release({ prerelease: true }), release({ tag_name: 'v0.3.0-beta.1' })]) {
    const result = await checker({ loadRelease: async () => value }).check();
    assert.equal(result.status, 'no-release'); assert.equal(result.downloadUrl, undefined);
  }
  for (const tag of ['v0.1.3', 'v0.1.2']) {
    const result = await checker({ loadRelease: async () => release({ tag_name: tag }) }).check();
    assert.equal(result.status, 'current'); assert.equal(result.downloadUrl, undefined);
  }
  assert.equal((await checker({ currentVersion: '0.2.0-beta.1' }).check()).status, 'available');
});

test('只有完整且属于目标仓库与当前版本的已上传安装包才显示可更新', async () => {
  const correct = asset('EnvGuardCC-Setup-0.2.0.exe');
  for (const assets of [[], [{ ...correct, size: 0 }], [{ ...correct, state: 'new' }],
    [{ ...correct, browser_download_url: 'https://evil.example/install.exe' }],
    [{ ...correct, browser_download_url: correct.browser_download_url.replace('/v0.2.0/', '/v0.1.0/') }],
    [{ ...correct, browser_download_url: correct.browser_download_url + '?redirect=elsewhere' }],
    [asset('EnvGuardCC-Setup-0.1.3.exe')],
  ]) {
    const result = await checker({ loadRelease: async () => release({ assets }) }).check();
    assert.equal(result.status, 'pending'); assert.equal(result.downloadUrl, undefined);
  }
  const result = await checker({ loadRelease: async () => release({ html_url: 'javascript:alert(1)' }) }).check();
  assert.equal(result.releaseUrl, `https://github.com/${repository}/releases/tag/v0.2.0`);
});

test('网络、限流与无效数据明确报错，不冒充已是最新；错误不包含敏感异常文本', async () => {
  for (const [loadRelease, expected] of [
    [async () => { throw new Error('network details with proxy-password'); }, 'network'],
    [async () => { throw new Error('rate-limit'); }, 'rate-limit'],
    [async () => release({ tag_name: 'bad-tag' }), 'invalid-release'],
    [async () => ({}), 'invalid-release'],
  ]) {
    const result = await checker({ loadRelease }).check();
    assert.equal(result.status, 'error'); assert.equal(result.error, expected);
    assert.doesNotMatch(JSON.stringify(result), /proxy-password/);
  }
  let calls = 0;
  const result = await checker({ repository: '../elsewhere', loadRelease: async () => { calls++; } }).check();
  assert.equal(result.error, 'configuration'); assert.equal(calls, 0);
});

test('自动检查缓存、手动刷新最小间隔、并发合并与失败后重试', async () => {
  let time = 0, calls = 0, failed = false;
  const updates = checker({ now: () => time, cacheMs: 300000, retryMs: 60000, loadRelease: async () => {
    calls++; if (failed) throw new Error('offline'); return release();
  } });
  const [first, second] = await Promise.all([updates.check(), updates.check({ force: true })]);
  assert.equal(calls, 1); assert.deepEqual(first, second);
  time = 59999; await updates.check({ force: true }); assert.equal(calls, 1);
  time = 60000; await updates.check(); assert.equal(calls, 1);
  await updates.check({ force: true }); assert.equal(calls, 2);
  time = 360000; failed = true;
  assert.equal((await updates.check()).status, 'error'); assert.equal(calls, 3);
  time += 59999; await updates.check(); assert.equal(calls, 3);
  time++; failed = false;
  assert.equal((await updates.check()).status, 'available'); assert.equal(calls, 4);
});

test('更新 API 使用现有本机来源与客户端校验，只允许读取，不允许调用者改写更新源', async t => {
  let calls = 0;
  const server = createGateway({ updates: { check: async options => { calls++; return { status: 'current', options }; } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/__checkcc/updates`;
  const headers = { Origin: 'http://localhost:3000', 'X-CheckCC-Client': 'gateway-ui' };
  assert.equal((await fetch(url)).status, 403);
  assert.equal((await fetch(url, { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers })).status, 405);
  assert.equal(calls, 0);
  const response = await fetch(url + '?force=1&repository=evil/repo', { headers });
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), headers.Origin);
  assert.deepEqual(await response.json(), { status: 'current', options: { force: true } });
  assert.equal(calls, 1);
});
