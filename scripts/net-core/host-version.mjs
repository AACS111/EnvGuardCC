import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// One manifest for staging and version negotiation. UI-only changes do not require UAC.
export const HOST_BUNDLE_FILES = ['scripts/net-core/host-version.mjs', 'scripts/net-core/host.mjs', 'scripts/net-core/log-limiter.mjs', 'scripts/net-core/loopback-fetch.mjs', 'scripts/net-core/rotating-log.mjs', 'scripts/net-core.mjs', 'scripts/net-core/config.mjs', 'scripts/net-core/public-dns.mjs', 'scripts/net-core/ports.mjs', 'scripts/net-core/guardian.cjs', 'scripts/net-core/firewall.mjs', 'scripts/net-core/claude-guard.mjs', 'scripts/net-core/host-protocol.mjs', 'scripts/net-core/system-ipv6.mjs', 'scripts/windows-timezone.mjs', 'scripts/windows-claude-targets.mjs', 'scripts/net-core/firewall-rule-check.mjs'];

export async function hostBuildVersion(root = fileURLToPath(new URL('../../', import.meta.url))) {
  const digest = createHash('sha256');
  for (const file of HOST_BUNDLE_FILES) {
    const content = await readFile(path.join(root, file));
    digest.update(file).update('\0').update(String(content.length)).update('\0').update(content);
  }
  return digest.digest('hex');
}

// Compute once at process startup, never during /health. A running old process
// retains its original identity even if files elsewhere are replaced.
export const HOST_BUILD_VERSION = await hostBuildVersion();
