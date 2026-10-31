import { cp, mkdir, readFile, writeFile, access, rm, readdir, rename, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolsDir = path.join(root, 'node_modules', '.checkcc-desktop-build');
const stage = path.join(root, 'node_modules', '.checkcc-desktop-app');
const output = path.join(root, 'node_modules', '.checkcc-dist');
const isMac = process.platform === 'darwin' && process.arch === 'arm64';
const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: 'inherit', ...options });
  child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Build step failed: ${code}`)));
});
if (!process.env.CHECKCC_EXPORT_DIR) throw new Error('请使用 npm run desktop:package 生成最新页面后打包。');
const exportRoot = path.resolve(process.env.CHECKCC_EXPORT_DIR);
await access(path.join(exportRoot, 'index.html'));
const provenance = JSON.parse(await readFile(path.join(exportRoot, 'checkcc-build.json'), 'utf8'));
for (const [file, expected] of Object.entries(provenance.sources)) {
  const actual = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
  if (actual !== expected) throw new Error('构建后源码已变化，请重新构建：' + file);
}
const chunks = path.join(exportRoot, '_next/static/chunks');
let hasRuntimePorts = false;
for (const name of await readdir(chunks)) if (name.endsWith('.js') && (await readFile(path.join(chunks, name), 'utf8')).includes('__CHECKCC_PORTS__')) hasRuntimePorts = true;
if (!hasRuntimePorts) throw new Error('构建产物缺少桌面端口配置，拒绝打包旧页面。');
await mkdir(toolsDir, { recursive: true });
const packagerVersion = isMac ? '20.3.0' : '19.1.1';
let installedPackager = null;
try { installedPackager = JSON.parse(await readFile(path.join(toolsDir, 'node_modules', '@electron', 'packager', 'package.json'), 'utf8')).version; } catch { /* install below */ }
if (installedPackager !== packagerVersion) {
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  // 19.1.1 leaves the zip extraction pending on Node 26; macOS uses 20.3.0.
  await run(process.execPath, [npmCli, 'install', '--prefix', toolsDir, '--save-exact', 'electron@42.11.18', `@electron/packager@${packagerVersion}`], { env: { ...process.env, npm_config_cache: path.join(toolsDir, 'cache'), ELECTRON_CACHE: path.join(toolsDir, 'electron-cache') } });
}
// The staging tree is disposable and must resolve inside this repository's node_modules.
if (!stage.startsWith(path.join(root, 'node_modules') + path.sep)) throw new Error('Invalid packaging directory');
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp(exportRoot, path.join(stage, 'out'), { recursive: true });
await cp(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
for (const dir of [ 'scripts', 'desktop', 'public', 'src/detection', 'src/i18n', 'src/regions']) await cp(path.join(root, dir), path.join(stage, dir), { recursive: true });
await mkdir(path.join(stage, 'node_modules'), { recursive: true });
if (!isMac && (process.platform !== 'win32' || process.arch !== 'x64')) throw new Error('打包需使用 macOS arm64 或 Windows x64 Node。');
await mkdir(path.join(stage, 'runtime'), { recursive: true });
if (isMac) {
  // Homebrew node is a thin binary linked to libnode; use the official self-contained runtime.
  const nodeVersion = process.version;
  const nodeDir = path.join(toolsDir, `node-${nodeVersion}-darwin-arm64`);
  const nodeBin = path.join(nodeDir, 'bin', 'node');
  try { await access(nodeBin); }
  catch {
    const nodeArchive = `node-${nodeVersion}-darwin-arm64.tar.gz`;
    const base = `https://nodejs.org/dist/${nodeVersion}`;
    const expected = (await (await fetch(`${base}/SHASUMS256.txt`)).text()).split('\n').find(line => line.endsWith(`  ${nodeArchive}`))?.split(/\s+/)[0];
    if (!expected) throw new Error('未找到 Node 运行时校验值');
    const tarball = path.join(toolsDir, nodeArchive);
    const response = await fetch(`${base}/${nodeArchive}`);
    if (!response.ok) throw new Error(`下载 Node 运行时失败：HTTP ${response.status}`);
    await writeFile(tarball, Buffer.from(await response.arrayBuffer()));
    if (createHash('sha256').update(await readFile(tarball)).digest('hex') !== expected) throw new Error('Node 运行时校验失败');
    await mkdir(nodeDir, { recursive: true });
    await run('tar', ['-xzf', tarball, '-C', nodeDir, '--strip-components=1']);
  }
  await cp(nodeBin, path.join(stage, 'runtime', 'node'));
  await chmod(path.join(stage, 'runtime', 'node'), 0o755);
  try { await cp(path.join(nodeDir, 'LICENSE'), path.join(stage, 'runtime', 'LICENSE')); } catch { /* optional */ }
} else {
  await cp(process.execPath, path.join(stage, 'runtime', 'node.exe'));
  try { await cp(path.join(path.dirname(process.execPath), 'LICENSE'), path.join(stage, 'runtime', 'LICENSE')); } catch { /* NVM distributions may not have a separate license file. */ }
}
await cp(path.join(root, 'node_modules', 'typescript'), path.join(stage, 'node_modules', 'typescript'), { recursive: true });
// The locale transaction uses LevelDB's supported writer; include its native runtime and dependencies.
const copiedRuntime = new Map();
async function copyRuntime(name, resolver = createRequire(path.join(root, 'package.json'))) {
  const packageFile = resolver.resolve(name + '/package.json');
  const metadata = JSON.parse(await readFile(packageFile, 'utf8'));
  if (copiedRuntime.has(name)) {
    if (copiedRuntime.get(name) !== metadata.version) throw new Error('Conflicting desktop runtime dependency: ' + name);
    return;
  }
  copiedRuntime.set(name, metadata.version);
  await cp(path.dirname(packageFile), path.join(stage, 'node_modules', name), { recursive: true, dereference: true });
  for (const dependency of Object.keys(metadata.dependencies ?? {})) await copyRuntime(dependency, createRequire(packageFile));
}
await copyRuntime('classic-level');
await copyRuntime('js-yaml');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'envguardcc-desktop', productName: 'EnvGuardCC', version: manifest.version, main: 'desktop/main.mjs', description: '环境检测与模拟保护工作台', author: 'EnvGuardCC', license: 'MIT' }, null, 2));
const guide = isMac
  ? '双击 EnvGuardCC.app 启动。应用使用本地 3030 页面端口，助手与网关使用独立端口，可与开发服务同时运行。\n启动模拟保护会备份配置并按当前 IP 适配；关闭保护或正常退出应用时自动恢复。\n系统时区变更需要 macOS 授权，失败会显示待处理状态。\n异常分越低越好，高于 50 分报警。强制结束进程或断电后，下次启动会尝试恢复未完成的配置。\n受控网页使用本机 Chrome 或 Edge；不会安装或更换浏览器。\n'
  : '双击 EnvGuardCC.exe 启动。应用使用本地 3030 页面端口，助手与网关使用独立端口，可与开发服务同时运行。\r\n启动模拟保护会备份配置并按当前 IP 适配；关闭保护或正常退出应用时自动恢复。\r\n系统时区变更需要 Windows 授予相应权限，失败会显示待处理状态。\r\n异常分越低越好，高于 50 分报警。强制结束进程或断电后，下次启动会尝试恢复未完成的配置。\r\n受控网页使用本机 Edge 或 Chrome；不会安装或更换浏览器。\r\n';
await writeFile(path.join(stage, '使用说明.txt'), guide);
const require = createRequire(path.join(toolsDir, 'package.json'));
const packagerModule = await import(pathToFileURL(require.resolve('@electron/packager')).href);
const packager = packagerModule.default ?? packagerModule.packager;
process.env.electron_config_cache ||= path.join(toolsDir, 'electron-cache');
require('electron');
const version = JSON.parse(await readFile(path.join(toolsDir, 'node_modules/electron/package.json'), 'utf8')).version;
const { downloadArtifact } = createRequire(require.resolve('electron/package.json'))('@electron/get');
const platform = isMac ? 'darwin' : 'win32';
const arch = isMac ? 'arm64' : 'x64';
const zip = await downloadArtifact({ version, platform, arch, artifactName: 'electron', cacheRoot: path.join(root, 'node_modules', '.checkcc-electron-cache'), checksums: JSON.parse(await readFile(path.join(toolsDir, 'node_modules/electron/checksums.json'), 'utf8')) });
let icon = path.join(root, 'desktop', 'envguardcc.ico');
if (isMac) {
  const iconset = path.join(toolsDir, 'envguardcc.iconset');
  const icns = path.join(toolsDir, 'envguardcc.icns');
  await rm(iconset, { recursive: true, force: true }); await rm(icns, { force: true });
  await mkdir(iconset, { recursive: true });
  for (const [size, name] of [[16, 'icon_16x16'], [32, 'icon_16x16@2x'], [32, 'icon_32x32'], [64, 'icon_32x32@2x'], [128, 'icon_128x128'], [256, 'icon_128x128@2x'], [256, 'icon_256x256'], [512, 'icon_256x256@2x'], [512, 'icon_512x512'], [1024, 'icon_512x512@2x']]) {
    await run('sips', ['-z', String(size), String(size), path.join(root, 'public', 'envguardcc-icon.png'), '--out', path.join(iconset, `${name}.png`)]);
  }
  await run('iconutil', ['-c', 'icns', iconset, '-o', icns]);
  icon = icns;
}
const artifacts = await packager({ dir: stage, out: output, name: 'EnvGuardCC', executableName: 'EnvGuardCC', appBundleId: 'io.github.aacs111.envguardcc', icon, platform, arch, electronVersion: version, electronZipDir: path.dirname(zip), overwrite: true, asar: false, prune: false, appVersion: manifest.version, osxSign: false, ...(isMac ? {} : { win32metadata: { CompanyName: 'EnvGuardCC', FileDescription: 'EnvGuardCC 环境检测与模拟保护', ProductName: 'EnvGuardCC' } }) });
const appPath = isMac ? path.join(artifacts[0], 'EnvGuardCC.app') : artifacts[0];
if (isMac) {
  // No Developer ID; ad-hoc signature keeps the local trial runnable.
  await run('codesign', ['--force', '--deep', '--sign', '-', appPath]);
  await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
}
// Replace the release ZIP only after compression has completed successfully.
const archive = path.join(output, isMac ? 'EnvGuardCC-macOS-arm64.zip' : 'EnvGuardCC-Windows-x64.zip');
const pendingArchive = archive.replace(/\.zip$/, '.pending.zip');
await rm(pendingArchive, { force: true });
try {
  if (isMac) await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, pendingArchive]);
  else await run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference = "Stop"; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:CHECKCC_ARCHIVE_SOURCE, $env:CHECKCC_ARCHIVE_DESTINATION, [IO.Compression.CompressionLevel]::Optimal, $true)'], {
    env: { ...process.env, CHECKCC_ARCHIVE_SOURCE: appPath, CHECKCC_ARCHIVE_DESTINATION: pendingArchive },
  });
  await rename(pendingArchive, archive);
} finally {
  await rm(pendingArchive, { force: true });
}
console.log((isMac ? 'macOS' : 'Windows') + ' application: ' + appPath);
console.log((isMac ? 'macOS' : 'Windows') + ' archive: ' + archive);
