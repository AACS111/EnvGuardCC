import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function buildTimezoneService(destination = path.join(root, 'node_modules/.checkcc-timezone-service')) {
  if (process.platform !== 'darwin') return;
  const source = path.join(root, 'desktop/macos/timezone-service');
  const names = ['Shared.swift', 'Bridge.swift', 'Daemon.swift'];
  const stamp = createHash('sha256').update(process.arch + (await Promise.all(names.map(name => readFile(path.join(source, name), 'utf8')))).join('\n')).digest('hex');
  try {
    if ((await readFile(path.join(destination, 'build-id'), 'utf8')) === stamp) {
      await access(path.join(destination, 'bridge')); await access(path.join(destination, 'daemon')); await access(path.join(destination, 'client-cdhash')); return;
    }
  } catch { /* Build missing or changed sources. */ }
  await mkdir(destination, { recursive: true });
  const common = ['-swift-version', '5', '-parse-as-library', '-O', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.0`, path.join(source, 'Shared.swift')];
  const bridge = path.join(destination, 'bridge');
  const daemon = path.join(destination, 'daemon');
  await exec('/usr/bin/xcrun', ['swiftc', ...common, path.join(source, 'Bridge.swift'), '-o', bridge], { timeout: 120000, maxBuffer: 1024 * 1024 });
  await exec('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'io.github.aacs111.envguardcc.timezone.bridge', bridge]);
  const { stderr } = await exec('/usr/bin/codesign', ['-d', '--verbose=4', bridge]);
  const cdhash = stderr.match(/^CDHash=([a-f0-9]+)$/m)?.[1];
  if (!cdhash) throw new Error('无法读取时区服务客户端签名。');
  const requirement = path.join(destination, 'ClientRequirement.swift');
  await writeFile(requirement, `let clientRequirement = ${JSON.stringify('cdhash H"' + cdhash + '"')}\n`);
  await exec('/usr/bin/xcrun', ['swiftc', ...common, path.join(source, 'Daemon.swift'), requirement, '-framework', 'SystemConfiguration', '-o', daemon], { timeout: 120000, maxBuffer: 1024 * 1024 });
  await exec('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'io.github.aacs111.envguardcc.timezone.daemon', daemon]);
  await writeFile(path.join(destination, 'client-cdhash'), cdhash);
  await writeFile(path.join(destination, 'build-id'), stamp);
  console.log('[timezone-service] Native client and restricted daemon compiled and signed.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildTimezoneService(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
}
