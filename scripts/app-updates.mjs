import { readFileSync } from 'node:fs';
import { transportRequest } from './gateway-diagnostics.mjs';

const defaultRepository = 'AACS111/EnvGuardCC';

function runtimeVersion() {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; }
  catch { return null; }
}

function versionParts(value) {
  if (typeof value !== 'string' || value.length > 128) return null;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(value);
  if (!match) return null;
  const pre = match[4]?.split('.') ?? [];
  if (pre.some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) return null;
  return { core: match.slice(1, 4).map(BigInt), pre };
}

// SemVer precedence, including development builds; build metadata does not affect ordering.
export function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function fetchLatestRelease(repository) {
  return new Promise((resolve, reject) => {
    const request = transportRequest(new URL(`https://api.github.com/repos/${repository}/releases/latest`), {
      method: 'GET', signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'EnvGuardCC-Update-Check', 'X-GitHub-Api-Version': '2022-11-28' },
    }, response => {
      if (response.statusCode === 404) { response.resume(); resolve(null); return; }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error([403, 429].includes(response.statusCode) ? 'rate-limit' : 'network'));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 512 * 1024) { reject(new Error('invalid-release')); response.destroy(); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('invalid-release')); }
      });
      response.on('error', () => reject(new Error('network')));
      response.on('aborted', () => reject(new Error('network')));
    });
    request.on('error', () => reject(new Error('network')));
    request.end();
  });
}

export function createUpdateChecker({
  currentVersion,
  repository = process.env.CHECKCC_UPDATE_REPOSITORY || defaultRepository,
  platform = process.platform, arch = process.arch,
  loadRelease = fetchLatestRelease, now = Date.now,
  cacheMs = 30 * 60 * 1000, retryMs = 60 * 1000,
} = {}) {
  let cached = null, inFlight = null;
  const validRepository = typeof repository === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repository) && !repository.split('/').some(part => /^\.+$/.test(part));
  const releasesUrl = validRepository ? `https://github.com/${repository}/releases` : null;
  const inspect = (release, installedVersion) => {
    if (release === null) return { status: 'no-release' };
    const tag = release?.tag_name;
    const parsed = versionParts(tag);
    if (!parsed || !Array.isArray(release.assets) || typeof release.draft !== 'boolean' || typeof release.prerelease !== 'boolean') throw new Error('invalid-release');
    if (release.draft || release.prerelease || parsed.pre.length) return { status: 'no-release' };
    const latestVersion = tag.replace(/^v/, '');
    const info = {
      latestVersion, releaseUrl: `${releasesUrl}/tag/${encodeURIComponent(tag)}`,
      notes: typeof release.body === 'string' ? release.body.slice(0, 20000) : '',
    };
    if (compareVersions(latestVersion, installedVersion) <= 0) return { ...info, status: 'current' };
    const names = platform === 'win32' && arch === 'x64'
      ? [`EnvGuardCC-Setup-${latestVersion}.exe`, 'EnvGuardCC-Windows-x64.zip']
      : platform === 'darwin' && arch === 'arm64'
        ? [`EnvGuardCC-${latestVersion}-arm64.dmg`, 'EnvGuardCC-macOS-arm64.zip'] : [];
    if (!names.length) return { ...info, status: 'unsupported' };
    for (const name of names) {
      const downloadUrl = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
      const asset = release.assets.find(asset => asset?.name === name && asset.state === 'uploaded' && Number.isFinite(asset.size) && asset.size > 0 && asset.browser_download_url === downloadUrl);
      if (asset) return { ...info, status: 'available', downloadUrl, assetName: name };
    }
    return { ...info, status: 'pending' };
  };
  return {
    check({ force = false } = {}) {
      if (inFlight) return inFlight;
      const age = cached ? now() - cached.at : Infinity;
      if (cached && age >= 0 && age < (force || cached.value.status === 'error' ? retryMs : cacheMs)) return Promise.resolve(cached.value);
      inFlight = (async () => {
        // Metadata is read only when checking updates; a missing file must not
        // prevent the gateway or its configuration-restoration path from starting.
        const installedVersion = currentVersion ?? runtimeVersion();
        let result;
        try {
          if (!validRepository || !versionParts(installedVersion)) throw new Error('configuration');
          result = inspect(await loadRelease(repository), installedVersion);
        } catch (error) {
          result = { status: 'error', error: ['rate-limit', 'invalid-release', 'configuration'].includes(error.message) ? error.message : 'network' };
        }
        const at = now();
        const value = { currentVersion: installedVersion, platform, arch, releasesUrl, ...result, checkedAt: new Date(at).toISOString() };
        cached = { at, value };
        return value;
      })().finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}
