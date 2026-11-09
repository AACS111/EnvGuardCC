import { cp, mkdir, readFile, writeFile, access, rm, readdir, rename, chmod, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { projectRoot as root, run, tauriCli } from './tauri-tools.mjs';
import { ensureKernel } from './net-core/vendor.mjs';

// Finder can recreate .DS_Store in an emptied directory while rm() walks it, which
// surfaces as ENOTEMPTY. Retry instead of failing the whole package build.
async function removeDirectory(target) {
  for (let attempt = 0; ; attempt += 1) {
    try { await rm(target, { recursive: true, force: true }); return; }
    catch (error) {
      if (!['ENOTEMPTY', 'EBUSY', 'ENOTDIR'].includes(error.code) || attempt >= 5) throw error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}
const tools = path.join(root, 'node_modules/.tauri-tools');
const stage = path.join(root, 'node_modules/.checkcc-tauri-backend');
const output = path.join(root, 'node_modules/.checkcc-dist');
const isMac = process.platform === 'darwin' && process.arch === 'arm64';
const nodeVersion = 'v22.23.2';
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (!isMac && (process.platform !== 'win32' || process.arch !== 'x64')) throw new Error('打包需要 Windows x64 或 macOS arm64。');
if (!process.env.CHECKCC_EXPORT_DIR) throw new Error('请使用 pnpm desktop:package 构建最新页面后打包。');
const exported = path.resolve(process.env.CHECKCC_EXPORT_DIR);
const kernel = await ensureKernel();
await access(path.join(exported, 'index.html'));
const provenance = JSON.parse(await readFile(path.join(exported, 'checkcc-build.json'), 'utf8'));
for (const [file, hash] of Object.entries(provenance.sources)) {
  if (createHash('sha256').update(await readFile(path.join(root, file))).digest('hex') !== hash) throw new Error('构建后源码已变化，请重新构建：' + file);
}
let hasPorts = false;
for (const file of await readdir(path.join(exported, '_next/static/chunks'))) {
  if (file.endsWith('.js') && (await readFile(path.join(exported, '_next/static/chunks', file), 'utf8')).includes('__CHECKCC_PORTS__')) hasPorts = true;
}
if (!hasPorts) throw new Error('构建产物缺少桌面端口配置。');
await mkdir(tools, { recursive: true });
await mkdir(output, { recursive: true });

async function bytes(directory) {
  const info = await stat(directory);
  if (!info.isDirectory()) return info.size;
  return (await Promise.all((await readdir(directory)).map(name => bytes(path.join(directory, name))))).reduce((a, b) => a + b, 0);
}
const platformName = isMac ? 'macOS-arm64' : 'Windows-x64';
const archive = path.join(output, `EnvGuardCC-${platformName}.zip`);
// Keep migration outputs separate from an Electron build that may still be running.
const legacyRoot = path.join(output, isMac ? 'EnvGuardCC-darwin-arm64' : 'EnvGuardCC-win32-x64');
const appRoot = path.join(output, isMac ? 'EnvGuardCC-tauri-darwin-arm64' : 'EnvGuardCC-tauri-win32-x64');
const reportFile = path.join(output, `tauri-size-${platformName}.json`);
let previous = {};
try { previous = JSON.parse(await readFile(reportFile, 'utf8')); } catch { /* First migration build. */ }
try {
  const reference = JSON.parse(await readFile(path.join(output, `electron-reference-${platformName}.json`), 'utf8'));
  if (reference.version === manifest.version) previous.electron = reference;
} catch { /* Optional same-version reference built independently from the old host. */ }
if (!previous.electron) {
  try {
    const oldManifest = path.join(legacyRoot, isMac ? 'EnvGuardCC.app/Contents/Resources/app/package.json' : 'resources/app/package.json');
    const oldVersion = JSON.parse(await readFile(oldManifest, 'utf8')).version;
    previous.electron = { version: oldVersion, zipBytes: await bytes(archive), installedBytes: await bytes(isMac ? path.join(legacyRoot, 'EnvGuardCC.app') : legacyRoot) };
    await writeFile(reportFile, JSON.stringify(previous, null, 2));
  } catch { /* A clean CI runner has no Electron reference artifact. */ }
}

// Guard every recursive removal with a repository-owned absolute path.
if (stage !== path.join(root, 'node_modules', '.checkcc-tauri-backend')) throw new Error('无效的后台暂存目录。');
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp(exported, path.join(stage, 'out'), { recursive: true });
for (const directory of ['scripts', 'desktop', 'public', 'src/detection', 'src/i18n', 'src/regions']) {
  await cp(path.join(root, directory), path.join(stage, directory), { recursive: true });
}
await cp(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
await cp(path.join(root, 'third_party/mihomo'), path.join(stage, 'third_party/mihomo'), { recursive: true });
await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'envguardcc-backend', version: manifest.version, type: 'module', license: 'MIT' }));
await mkdir(path.join(stage, 'runtime'), { recursive: true });

async function download(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status} ${url}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}
const nodeName = `node-${nodeVersion}-${isMac ? 'darwin-arm64' : 'win-x64'}`;
const nodeArchive = nodeName + (isMac ? '.tar.gz' : '.zip');
const nodeDirectory = path.join(tools, nodeName);
const runtime = path.join(nodeDirectory, isMac ? 'bin/node' : 'node.exe');
const base = `https://nodejs.org/dist/${nodeVersion}`;
const checksumResponse = await fetch(`${base}/SHASUMS256.txt`, { signal: AbortSignal.timeout(15000) });
if (!checksumResponse.ok) throw new Error('无法下载 Node 运行时校验值。');
const expected = (await checksumResponse.text()).split('\n').find(line => line.trim().endsWith(' ' + nodeArchive))?.trim().split(/\s+/)[0];
if (!/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('未找到 Node 运行时校验值。');
const tarball = path.join(tools, nodeArchive);
try { await access(tarball); } catch { await download(`${base}/${nodeArchive}`, tarball); }
if (createHash('sha256').update(await readFile(tarball)).digest('hex') !== expected) throw new Error('Node 运行时校验失败，请删除工具目录中的下载包后重试。');
if (isMac) {
  await mkdir(nodeDirectory, { recursive: true });
  await run('tar', ['-xzf', tarball, '-C', nodeDirectory, '--strip-components=1']);
} else {
  await run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:CHECKCC_NODE_ARCHIVE -DestinationPath $env:CHECKCC_NODE_DESTINATION -Force'], { env: { ...process.env, CHECKCC_NODE_ARCHIVE: tarball, CHECKCC_NODE_DESTINATION: tools } });
}
await cp(runtime, path.join(stage, 'runtime', isMac ? 'node' : 'node.exe'));
await cp(path.join(nodeDirectory, 'LICENSE'), path.join(stage, 'runtime/LICENSE'));
if (isMac) {
  await chmod(path.join(stage, 'runtime/node'), 0o755);
  await run(process.execPath, [path.join(root, 'scripts/build-timezone-service.mjs'), path.join(stage, 'runtime/timezone-service')]);
}
await mkdir(path.join(stage, 'node_modules'), { recursive: true });
await mkdir(path.join(stage, 'node_modules/.checkcc-kernel'), { recursive: true });
await cp(kernel.file, path.join(stage, 'node_modules/.checkcc-kernel', path.basename(kernel.file)));
await chmod(path.join(stage, 'node_modules/.checkcc-kernel', path.basename(kernel.file)), 0o755);
await cp(path.join(root, 'node_modules/typescript'), path.join(stage, 'node_modules/typescript'), { recursive: true, dereference: true });
const copied = new Map();
async function copyRuntime(name, resolver = createRequire(path.join(root, 'package.json'))) {
  const metadataFile = resolver.resolve(name + '/package.json');
  const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
  if (copied.has(name)) { if (copied.get(name) !== metadata.version) throw new Error('后台依赖版本冲突：' + name); return; }
  copied.set(name, metadata.version);
  const destination = path.join(stage, 'node_modules', name);
  await cp(path.dirname(metadataFile), destination, { recursive: true, dereference: true });
  if (name === 'classic-level') {
    for (const prebuild of await readdir(path.join(destination, 'prebuilds'))) {
      const [platform, architectures = ''] = prebuild.split('-');
      if (platform !== process.platform || !architectures.split('+').includes(process.arch)) await rm(path.join(destination, 'prebuilds', prebuild), { recursive: true, force: true });
    }
  }
  for (const dependency of Object.keys(metadata.dependencies || {})) await copyRuntime(dependency, createRequire(metadataFile));
}
await copyRuntime('classic-level');
await copyRuntime('yaml');
await writeFile(path.join(stage, '使用说明.txt'), 'EnvGuardCC 使用系统 WebView，不再包含 Electron。\nWindows 需要 WebView2；安装器会在缺失时联网安装，便携版请先安装 WebView2。\n已包含 Node，无需另行安装。关闭窗口保留后台运行；请从托盘退出并等待原始配置恢复。\n');

// Tauri embeds no duplicate frontend assets; the Node sidecar serves the exported site.
await run(process.execPath, [tauriCli(), 'build', '--no-bundle', '--', '--locked']);
const pendingRoot = path.join(output, `.tauri-${platformName}`);
if (path.dirname(pendingRoot) !== output) throw new Error('无效的产物目录。');
await removeDirectory(pendingRoot);
await mkdir(pendingRoot, { recursive: true });
let application;
if (isMac) {
  await run(process.execPath, [tauriCli(), 'bundle', '--bundles', 'app', '--no-sign']);
  application = path.join(pendingRoot, 'EnvGuardCC.app');
  await cp(path.join(root, 'src-tauri/target/release/bundle/macos/EnvGuardCC.app'), application, { recursive: true, verbatimSymlinks: true });
  // Sign enclosing code without --deep: the timezone daemon pins the bridge's exact cdhash.
  await run('codesign', ['--force', '--sign', '-', path.join(application, 'Contents/Resources/backend/runtime/node')]);
  await run('codesign', ['--force', '--sign', '-', application]);
  await run('codesign', ['--verify', '--deep', '--strict', application]);
  const service = path.join(application, 'Contents/Resources/backend/runtime/timezone-service');
  await run(process.execPath, [path.join(root, 'scripts/verify-timezone-signature.mjs'), service]);
} else {
  application = path.join(pendingRoot, 'EnvGuardCC-win32-x64');
  await mkdir(application);
  await cp(path.join(root, 'src-tauri/target/release/envguardcc.exe'), path.join(application, 'EnvGuardCC.exe'));
  await cp(stage, path.join(application, 'backend'), { recursive: true });
}
const pendingArchive = archive.replace(/\.zip$/, '.pending.zip');
await rm(pendingArchive, { force: true });
if (isMac) await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', application, pendingArchive]);
else await run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:CHECKCC_ARCHIVE_SOURCE, $env:CHECKCC_ARCHIVE_DESTINATION, [IO.Compression.CompressionLevel]::Optimal, $true)'], { env: { ...process.env, CHECKCC_ARCHIVE_SOURCE: application, CHECKCC_ARCHIVE_DESTINATION: pendingArchive } });
if (path.dirname(appRoot) !== output) throw new Error('无效的交付目录。');
await removeDirectory(appRoot);
if (isMac) { await mkdir(appRoot); await rename(application, path.join(appRoot, 'EnvGuardCC.app')); }
else await rename(application, appRoot);
await rename(pendingArchive, archive);
const installedBytes = await bytes(isMac ? path.join(appRoot, 'EnvGuardCC.app') : appRoot);
const zipBytes = await bytes(archive);
await writeFile(reportFile, JSON.stringify({ ...previous, version: manifest.version, nodeVersion, platform: platformName, tauri: { installedBytes, zipBytes }, referenceIsSameVersion: previous.electron?.version === manifest.version,
  ...(previous.electron ? { reduction: { zipPercent: 100 * (1 - zipBytes / previous.electron.zipBytes), installedPercent: 100 * (1 - installedBytes / previous.electron.installedBytes) } } : {}), builtAt: new Date().toISOString() }, null, 2));
await writeFile(path.join(output, `tauri-build-${platformName}.json`), JSON.stringify({ version: manifest.version, sources: provenance.sources }));
console.log(`Tauri ${platformName}: ZIP ${(zipBytes / 1048576).toFixed(1)} MiB / 安装体积 ${(installedBytes / 1048576).toFixed(1)} MiB`);
console.log('应用：' + appRoot + '\n压缩包：' + archive);
