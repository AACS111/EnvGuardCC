import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';

export const ACTIVATION_WINDOW_SECONDS = 3600;
export const MAX_USAGE_SECONDS = 3650 * 86400;
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const claimKeys = ['v', 'app', 'id', 'subject', 'issuedAt', 'activateBefore', 'usageSeconds'].sort();

export class LicenseError extends Error {
  constructor(code, message) { super(message); this.name = 'LicenseError'; this.code = code; }
}
function reject(code, message) { throw new LicenseError(code, message); }
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }

export function normalizeAccountUuid(value) {
  if (typeof value !== 'string' || !uuidPattern.test(value.trim()) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value.trim())) {
    reject('ACCOUNT_REQUIRED', '请输入 Claude 桌面账号的 UUID，不能使用邮箱或组织 UUID。');
  }
  return value.trim().toLowerCase();
}

export function accountSubject(accountUuid) {
  return createHash('sha256').update(`checkcc:claude-desktop-account:v1:${normalizeAccountUuid(accountUuid)}`).digest('base64url');
}

export function validateLicenseClaims(claims) {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims) || Object.keys(claims).sort().join() !== claimKeys.join()
    || claims.v !== 1 || claims.app !== 'checkcc' || typeof claims.id !== 'string' || !uuidPattern.test(claims.id)
    || typeof claims.subject !== 'string' || !/^[\w-]{43}$/.test(claims.subject)
    || !integer(claims.issuedAt) || !integer(claims.activateBefore) || claims.activateBefore - claims.issuedAt !== ACTIVATION_WINDOW_SECONDS
    || !integer(claims.usageSeconds) || claims.usageSeconds < 3600 || claims.usageSeconds > MAX_USAGE_SECONDS) {
    reject('INVALID_LICENSE', '授权码内容无效或版本不受支持。');
  }
  return claims;
}

function decode(segment) {
  if (!segment || !/^[\w-]+$/.test(segment)) reject('INVALID_LICENSE', '授权码格式无效。');
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) reject('INVALID_LICENSE', '授权码编码无效。');
  return bytes;
}

// Only the public key is needed here. Issuing code lives outside the desktop packaging tree.
export function verifyLicenseSignature(code, publicKey) {
  if (typeof code !== 'string' || code.length > 4096) reject('INVALID_LICENSE', '授权码格式无效。');
  const parts = code.trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'CCL1') reject('INVALID_LICENSE', '授权码格式无效。');
  const payload = decode(parts[1]), signature = decode(parts[2]);
  let key;
  try { key = publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey); }
  catch { reject('PUBLIC_KEY_INVALID', '授权验签公钥无效。'); }
  if (key.asymmetricKeyType !== 'ed25519') reject('PUBLIC_KEY_INVALID', '授权验签必须使用 Ed25519 公钥。');
  if (signature.length !== 64 || !verify(null, Buffer.from(`CCL1.${parts[1]}`), key, signature)) {
    reject('INVALID_SIGNATURE', '授权码签名无效，或不是由当前签发密钥生成。');
  }
  let claims;
  try { claims = JSON.parse(payload.toString('utf8')); }
  catch { reject('INVALID_LICENSE', '授权码内容无效。'); }
  return validateLicenseClaims(claims);
}

function checkContext(claims, accountUuid, now) {
  if (!integer(now)) reject('INVALID_TIME', '本机时间无效。');
  const subject = accountSubject(accountUuid);
  if (!timingSafeEqual(Buffer.from(subject), Buffer.from(claims.subject))) reject('ACCOUNT_MISMATCH', '当前 Claude 桌面账号与授权码不匹配。');
  if (now < claims.issuedAt) reject('CLOCK_ROLLBACK', '本机时间早于签发时间，请检查系统时间。');
}

export function verifyLicenseForActivation(code, publicKey, { accountUuid, now = Math.floor(Date.now() / 1000) } = {}) {
  const claims = verifyLicenseSignature(code, publicKey);
  checkContext(claims, accountUuid, now);
  if (now >= claims.activateBefore) reject('ACTIVATION_EXPIRED', '授权码已超过一小时激活期限，请重新签发。');
  return { claims, activatedAt: now, expiresAt: now + claims.usageSeconds };
}

// The caller must load activatedAt/lastSeenAt from OS-protected local storage, not user input.
export function verifyActivatedLicense(code, publicKey, { accountUuid, activatedAt, lastSeenAt, now = Math.floor(Date.now() / 1000) } = {}) {
  const claims = verifyLicenseSignature(code, publicKey);
  checkContext(claims, accountUuid, now);
  if (!integer(activatedAt) || activatedAt < claims.issuedAt || activatedAt >= claims.activateBefore
    || !integer(lastSeenAt) || lastSeenAt < activatedAt) reject('INVALID_ACTIVATION', '本地激活记录无效，请检查授权数据。');
  if (now < lastSeenAt || now < activatedAt) reject('CLOCK_ROLLBACK', '检测到本机时间回退，请校正系统时间。');
  const expiresAt = activatedAt + claims.usageSeconds;
  if (now >= expiresAt) reject('LICENSE_EXPIRED', '授权使用期限已结束。');
  return { claims, activatedAt, expiresAt, lastSeenAt: now };
}
