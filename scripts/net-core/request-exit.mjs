import { isIP } from 'node:net';
import { DEFAULT_GROUP } from './config.mjs';
import { isClaudeHost } from './routes.mjs';

function verifiedExitIp(evidence, now) {
  if (!evidence?.running || !evidence.stable || evidence.blocked || evidence.verificationPending || evidence.probeFailures > 0 || !evidence.matches || !isIP(evidence.ip ?? '')) return null;
  const age = now - evidence.at;
  return Number.isFinite(age) && age >= 0 && age <= 60000 ? evidence.ip : null;
}

/** 请求使用已核验固定出口时记下归属。 */
export function verifiedRequestExit(info, evidence, now = Date.now()) {
  if (!isClaudeHost(info?.host)) return null;
  const ip = verifiedExitIp(evidence, now);
  if (!ip) return null;
  if (info.transport?.mode === 'direct') return evidence.tunCaptured ? ip : null;
  if (info.transport?.mode !== 'http-connect') return null;
  try {
    const proxy = new URL(info.transport.address);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(proxy.hostname);
    return loopback && ['http:', 'https:'].includes(proxy.protocol) && Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80)) === evidence.proxyPort ? ip : null;
  } catch { return null; }
}

export function verifiedConnectionExit(record, evidence, now = Date.now()) {
  const ip = verifiedExitIp(evidence, now);
  const start = Date.parse(record.startedAt);
  if (!ip || !record.isClaude || record.route !== 'proxied' || !(start >= evidence.at && start <= now)) return null;
  return record.chains.includes(DEFAULT_GROUP) && record.chains.includes(evidence.node) ? ip : null;
}
