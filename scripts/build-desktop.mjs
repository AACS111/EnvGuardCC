import { cp, mkdir, readFile, writeFile, access, rm, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolsDir = path.join(root, 'node_modules', '.checkcc-desktop-build');
const stage = path.join(root, 'node_modules', '.checkcc-desktop-app');
const output = path.join(root, 'node_modules', '.checkcc-dist');
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
try { await access(path.join(toolsDir, 'node_modules', '@electron', 'packager', 'package.json')); }
catch {
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  await run(process.execPath, [npmCli, 'install', '--prefix', toolsDir, '--save-exact', 'electron@42.11.18', '@electron/packager@19.1.1'], { env: { ...process.env, npm_config_cache: path.join(toolsDir, 'cache'), ELECTRON_CACHE: path.join(toolsDir, 'electron-cache') } });
}
// The staging tree is disposable and must resolve inside this repository's node_modules.
if (!stage.startsWith(path.join(root, 'node_modules') + path.sep)) throw new Error('Invalid packaging directory');
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp(exportRoot, path.join(stage, 'out'), { recursive: true });
for (const dir of [ 'scripts', 'desktop', 'src/detection', 'src/i18n', 'src/regions']) await cp(path.join(root, dir), path.join(stage, dir), { recursive: true });
await mkdir(path.join(stage, 'node_modules'), { recursive: true });
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 打包需使用 Windows x64 Node。');
await mkdir(path.join(stage, 'runtime'), { recursive: true });
await cp(process.execPath, path.join(stage, 'runtime', 'node.exe'));
try { await cp(path.join(path.dirname(process.execPath), 'LICENSE'), path.join(stage, 'runtime', 'LICENSE')); } catch { /* NVM distributions may not have a separate license file. */ }
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
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'envguardcc-desktop', productName: 'EnvGuardCC', version: manifest.version, main: 'desktop/main.mjs', description: '环境检测与模拟保护工作台', author: 'EnvGuardCC', license: 'MIT' }, null, 2));
await writeFile(path.join(stage, '使用说明.txt'), '双击 EnvGuardCC.exe 启动。应用使用本地 3030 页面端口，助手与网关使用独立端口，可与开发服务同时运行。\r\n启动模拟保护会备份配置并按当前 IP 适配；关闭保护或正常退出应用时自动恢复。\r\n系统时区变更需要 Windows 授予相应权限，失败会显示待处理状态。\r\n异常分越低越好，高于 50 分报警。强制结束进程或断电后，下次启动会尝试恢复未完成的配置。\r\n受控网页使用本机 Edge 或 Chrome；不会安装或更换浏览器。\r\n');
const require = createRequire(path.join(toolsDir, 'package.json'));
const packagerModule = await import(pathToFileURL(require.resolve('@electron/packager')).href);
const packager = packagerModule.default ?? packagerModule.packager;
process.env.electron_config_cache ||= path.join(toolsDir, 'electron-cache');
require('electron');
const version = JSON.parse(await readFile(path.join(toolsDir, 'node_modules/electron/package.json'), 'utf8')).version;
const { downloadArtifact } = require('@electron/get');
const zip = await downloadArtifact({ version, platform: 'win32', arch: 'x64', artifactName: 'electron', cacheRoot: path.join(root, 'node_modules', '.checkcc-electron-cache'), checksums: JSON.parse(await readFile(path.join(toolsDir, 'node_modules/electron/checksums.json'), 'utf8')) });
const artifacts = await packager({ dir: stage, out: output, name: 'EnvGuardCC', executableName: 'EnvGuardCC', icon: path.join(root, 'desktop', 'envguardcc.ico'), platform: 'win32', arch: 'x64', electronVersion: version, electronZipDir: path.dirname(zip), overwrite: true, asar: false, prune: false, appVersion: manifest.version, win32metadata: { CompanyName: 'EnvGuardCC', FileDescription: 'EnvGuardCC 环境检测与模拟保护', ProductName: 'EnvGuardCC' } });
// Replace the release ZIP only after compression has completed successfully.
const archive = path.join(output, 'EnvGuardCC-Windows-x64.zip');
const pendingArchive = path.join(output, 'EnvGuardCC-Windows-x64.pending.zip');
await rm(pendingArchive, { force: true });
try {
  await run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference = "Stop"; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:CHECKCC_ARCHIVE_SOURCE, $env:CHECKCC_ARCHIVE_DESTINATION, [IO.Compression.CompressionLevel]::Optimal, $true)'], {
    env: { ...process.env, CHECKCC_ARCHIVE_SOURCE: artifacts[0], CHECKCC_ARCHIVE_DESTINATION: pendingArchive },
  });
  await rename(pendingArchive, archive);
} finally {
  await rm(pendingArchive, { force: true });
}
console.log('Windows application: ' + artifacts[0]);
console.log('Windows archive: ' + archive);
