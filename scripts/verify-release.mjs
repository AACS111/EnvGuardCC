import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const version = manifest.version;
if (process.env.RELEASE_TAG !== `v${version}`) throw new Error('Release tag does not match package.json');
const directory = path.resolve(process.argv[2] || 'release-assets');
const files = [`EnvGuardCC-Setup-${version}.exe`, 'EnvGuardCC-Windows-x64.zip', `EnvGuardCC-${version}-arm64.dmg`, 'EnvGuardCC-macOS-arm64.zip'];
const checksums = [];
for (const name of files) {
  const file = path.join(directory, name);
  if (!(await stat(file)).size) throw new Error('Empty release asset: ' + name);
  checksums.push(`${createHash('sha256').update(await readFile(file)).digest('hex')}  ${name}`);
}
await writeFile(path.join(directory, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
console.log('Verified all four Windows/macOS release assets for v' + version);
