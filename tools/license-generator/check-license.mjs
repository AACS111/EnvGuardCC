import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { loadIssuer, issueLicense } from './issuer.mjs';
import { startGenerator } from './server.mjs';
import { accountSubject, verifyLicenseSignature, verifyLicenseForActivation, verifyActivatedLicense } from '../../scripts/license-verifier.mjs';

const accountUuid = '23456789-1234-4321-8765-123456789abc';
const otherAccount = '23456789-1234-4321-8765-123456789abd';
const now = 1800000000;
const keys = generateKeyPairSync('ed25519');
const issue = (options = {}) => issueLicense({ accountUuid, usageHours: 24, now, ...options }, keys.privateKey);
const hasCode = code => error => error.code === code;

async function directory(t) {
  const testRoot = path.resolve('node_modules/.checkcc-license-tests');
  await mkdir(testRoot, { recursive: true });
  const value = await mkdtemp(path.join(testRoot, 'issuer-'));
  t.after(() => {
    if (path.dirname(value) !== testRoot) throw new Error('Refusing to remove a test directory outside its root');
    return rm(value, { recursive: true, force: true });
  });
  return value;
}

test('离线签名绑定账号 UUID，大小写规范化，授权码不包含原始账号或私钥', () => {
  const { code } = issue();
  const result = verifyLicenseForActivation(code, keys.publicKey, { accountUuid: accountUuid.toUpperCase(), now });
  assert.equal(result.claims.subject, accountSubject(accountUuid));
  assert.equal(result.expiresAt, now + 86400);
  assert.equal(result.claims.activateBefore, now + 3600);
  assert.doesNotMatch(Buffer.from(code.split('.')[1], 'base64url').toString(), /PRIVATE KEY|23456789/);
  assert.throws(() => verifyLicenseForActivation(code, keys.publicKey, { accountUuid: otherAccount, now }), hasCode('ACCOUNT_MISMATCH'));
  assert.throws(() => verifyLicenseForActivation(code, keys.publicKey, { now }), hasCode('ACCOUNT_REQUIRED'));
});

test('生成后一小时为激活截止，边界时刻及未来签发时间均被拒绝', () => {
  const { code } = issue();
  assert.ok(verifyLicenseForActivation(code, keys.publicKey, { accountUuid, now: now + 3599 }));
  assert.throws(() => verifyLicenseForActivation(code, keys.publicKey, { accountUuid, now: now + 3600 }), hasCode('ACTIVATION_EXPIRED'));
  assert.throws(() => verifyLicenseForActivation(code, keys.publicKey, { accountUuid, now: now - 1 }), hasCode('CLOCK_ROLLBACK'));
});

test('激活后独立计算使用期限，超过激活窗口仍可用，到期和换号均拒绝', () => {
  const { code } = issue();
  const activatedAt = now + 300;
  const context = { accountUuid, activatedAt, lastSeenAt: activatedAt, now: now + 7200 };
  assert.equal(verifyActivatedLicense(code, keys.publicKey, context).expiresAt, activatedAt + 86400);
  assert.throws(() => verifyActivatedLicense(code, keys.publicKey, { ...context, now: activatedAt + 86400 }), hasCode('LICENSE_EXPIRED'));
  assert.throws(() => verifyActivatedLicense(code, keys.publicKey, { ...context, accountUuid: otherAccount }), hasCode('ACCOUNT_MISMATCH'));
  assert.throws(() => verifyActivatedLicense(code, keys.publicKey, { ...context, activatedAt: now + 3600, lastSeenAt: now + 3600 }), hasCode('INVALID_ACTIVATION'));
  assert.throws(() => verifyActivatedLicense(code, keys.publicKey, { ...context, lastSeenAt: now + 8000 }), hasCode('CLOCK_ROLLBACK'));
  assert.throws(() => verifyActivatedLicense(code, keys.publicKey, { ...context, lastSeenAt: undefined }), hasCode('INVALID_ACTIVATION'));
});

test('更换公钥、篡改期限、非法编码及跨协议内容不能通过验签', () => {
  const { code } = issue();
  const parts = code.split('.');
  const forged = JSON.parse(Buffer.from(parts[1], 'base64url'));
  forged.usageSeconds += 86400;
  const payload = Buffer.from(JSON.stringify(forged)).toString('base64url');
  assert.throws(() => verifyLicenseSignature(`CCL1.${payload}.${parts[2]}`, keys.publicKey), hasCode('INVALID_SIGNATURE'));
  const another = generateKeyPairSync('ed25519');
  assert.throws(() => verifyLicenseSignature(code, another.publicKey), hasCode('INVALID_SIGNATURE'));
  for (const value of ['', 'CCL2.' + parts.slice(1).join('.'), code + '.', code + '=', 'x'.repeat(4097)]) {
    assert.throws(() => verifyLicenseSignature(value, keys.publicKey), hasCode('INVALID_LICENSE'));
  }
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url')); claims.app = 'another-app';
  const otherPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const otherSignature = sign(null, Buffer.from(`CCL1.${otherPayload}`), keys.privateKey).toString('base64url');
  assert.throws(() => verifyLicenseSignature(`CCL1.${otherPayload}.${otherSignature}`, keys.publicKey), hasCode('INVALID_LICENSE'));
});

test('签发拒绝邮箱、空账号、非法使用时长及无私钥调用', () => {
  for (const value of ['user@example.com', '', '00000000-0000-0000-0000-000000000000']) assert.throws(() => issue({ accountUuid: value }));
  for (const value of [0, -1, Infinity, NaN, '24', 87601, 1.00001]) assert.throws(() => issue({ usageHours: value }));
  assert.throws(() => issueLicense({ accountUuid, usageHours: 24, now }, keys.publicKey));
});

test('签发私钥跨重启保持一致，已有损坏密钥不会被静默替换', async t => {
  const dir = await directory(t);
  const first = await loadIssuer(dir), second = await loadIssuer(dir);
  assert.equal(first.publicKey, second.publicKey);
  assert.equal(await readFile(path.join(dir, 'issuer-public.pem'), 'utf8'), first.publicKey);
  const { code } = issueLicense({ accountUuid, usageHours: 24, now }, first.privateKey);
  assert.ok(verifyLicenseSignature(code, second.publicKey));
  await writeFile(path.join(dir, 'issuer-private.pem'), 'damaged-key');
  await assert.rejects(loadIssuer(dir));
  assert.equal(await readFile(path.join(dir, 'issuer-private.pem'), 'utf8'), 'damaged-key');
});

test('并行首次初始化不轮换密钥', async t => {
  const dir = await directory(t);
  const results = await Promise.all([loadIssuer(dir), loadIssuer(dir), loadIssuer(dir)]);
  assert.equal(new Set(results.map(value => value.publicKey)).size, 1);
});

test('口令加密的私钥可复用，错误口令不会重置密钥', async t => {
  const dir = await directory(t), original = process.env.CHECKCC_ISSUER_PASSPHRASE;
  try {
    process.env.CHECKCC_ISSUER_PASSPHRASE = 'checkcc-test-passphrase';
    const first = await loadIssuer(dir);
    const pem = await readFile(path.join(dir, 'issuer-private.pem'), 'utf8');
    assert.match(pem, /BEGIN ENCRYPTED PRIVATE KEY/);
    process.env.CHECKCC_ISSUER_PASSPHRASE = 'wrong-test-passphrase';
    await assert.rejects(loadIssuer(dir));
    assert.equal(await readFile(path.join(dir, 'issuer-private.pem'), 'utf8'), pem);
    process.env.CHECKCC_ISSUER_PASSPHRASE = 'checkcc-test-passphrase';
    assert.equal((await loadIssuer(dir)).publicKey, first.publicKey);
  } finally {
    if (original === undefined) delete process.env.CHECKCC_ISSUER_PASSPHRASE;
    else process.env.CHECKCC_ISSUER_PASSPHRASE = original;
  }
});

function rawRequest(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('独立生成器提供本机表单、公钥和真实签发，响应中不泄漏私钥', async t => {
  const app = await startGenerator({ directory: await directory(t) });
  t.after(app.close);
  const page = await fetch(app.url);
  const html = await page.text(), token = html.match(/name="issuer-token" content="([\w-]+)"/)[1];
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const headers = { 'X-CheckCC-Issuer-Token': token, Origin: app.url, 'Content-Type': 'application/json' };
  const info = await (await fetch(app.url + '/api/info', { headers })).json();
  assert.match(info.publicKey, /BEGIN PUBLIC KEY/);
  assert.doesNotMatch(JSON.stringify(info), /PRIVATE KEY/);
  const response = await fetch(app.url + '/api/issue', { method: 'POST', headers, body: JSON.stringify({ accountUuid, usageHours: 720 }) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal((Date.parse(result.activateBefore) - Date.parse(result.issuedAt)) / 1000, 3600);
  assert.ok(verifyLicenseForActivation(result.code, info.publicKey, { accountUuid }));
  for (const asset of ['/app.js', '/style.css']) assert.equal((await fetch(app.url + asset)).status, 200);
  assert.equal((await fetch(app.url + '/issuer-private.pem', { headers })).status, 404);
  assert.equal((await fetch(app.url + '/api/issue', { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(app.url + '/api/issue', { method: 'POST', headers, body: JSON.stringify({ accountUuid, usageHours: 24, now: 1 }) })).status, 400);
  assert.equal((await fetch(app.url + '/api/issue', { method: 'POST', headers, body: 'x'.repeat(4097) })).status, 413);
});

test('生成器拒绝跨站请求、DNS 重绑定、缺少会话标识和非法令牌', async t => {
  const app = await startGenerator({ directory: await directory(t) });
  t.after(app.close);
  const html = await (await fetch(app.url)).text(), token = html.match(/name="issuer-token" content="([\w-]+)"/)[1];
  assert.equal((await fetch(app.url + '/api/info')).status, 403);
  assert.equal((await fetch(app.url, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await rawRequest(app.url, { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await rawRequest(app.url, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(app.url + '/api/info', { headers: { 'X-CheckCC-Issuer-Token': '!'.repeat(43) } })).status, 403);
  assert.equal((await fetch(app.url + '/api/issue', { method: 'POST', headers: { 'X-CheckCC-Issuer-Token': token, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
});
