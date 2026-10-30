import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { link, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { ACTIVATION_WINDOW_SECONDS, MAX_USAGE_SECONDS, accountSubject, validateLicenseClaims } from '../../scripts/license-verifier.mjs';

async function createExclusive(file, contents) {
  const pending = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(pending, contents, { flag: 'wx', mode: 0o600 });
    // Linking publishes a complete file without replacing another process's existing key.
    try { await link(pending, file); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally { await rm(pending, { force: true }); }
}

export async function loadIssuer(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const keyFile = path.join(directory, 'issuer-private.pem');
  let pem;
  try { pem = await readFile(keyFile, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const { privateKey } = generateKeyPairSync('ed25519');
    const passphrase = process.env.CHECKCC_ISSUER_PASSPHRASE;
    const generated = privateKey.export({ type: 'pkcs8', format: 'pem', ...(passphrase ? { cipher: 'aes-256-cbc', passphrase } : {}) });
    await createExclusive(keyFile, generated);
    pem = await readFile(keyFile, 'utf8');
  }
  const privateKey = createPrivateKey({ key: pem, passphrase: process.env.CHECKCC_ISSUER_PASSPHRASE });
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('签发私钥必须为 Ed25519。');
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  const exportFile = path.join(directory, 'issuer-public.pem');
  await createExclusive(exportFile, publicKey);
  if (await readFile(exportFile, 'utf8') !== publicKey) throw new Error('导出公钥与签发私钥不匹配，请检查密钥备份。');
  return { privateKey, publicKey };
}

export function issueLicense({ accountUuid, usageHours, now = Math.floor(Date.now() / 1000) }, privateKey) {
  if (typeof usageHours !== 'number' || !Number.isFinite(usageHours) || usageHours < 1 || usageHours * 3600 > MAX_USAGE_SECONDS
    || !Number.isSafeInteger(usageHours * 3600)) throw new Error('使用时长须为 1 小时至 3650 天，精确到秒。');
  if (privateKey?.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw new Error('签发需要 Ed25519 私钥。');
  const claims = validateLicenseClaims({ v: 1, app: 'checkcc', id: randomUUID(), subject: accountSubject(accountUuid),
    issuedAt: now, activateBefore: now + ACTIVATION_WINDOW_SECONDS, usageSeconds: usageHours * 3600 });
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const code = `CCL1.${encoded}.${sign(null, Buffer.from(`CCL1.${encoded}`), privateKey).toString('base64url')}`;
  return { code, id: claims.id, issuedAt: new Date(now * 1000).toISOString(), activateBefore: new Date(claims.activateBefore * 1000).toISOString(), usageHours };
}
