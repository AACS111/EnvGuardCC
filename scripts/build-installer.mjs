import { access, mkdir, readFile, rm, cp, mkdtemp, symlink, writeFile, rename, readdir } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot as root, run, tauriCli, buildEnvironment } from './tauri-tools.mjs';

const output = path.join(root, 'node_modules/.checkcc-dist');
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const isMac = process.platform === 'darwin' && process.arch === 'arm64';
const platformName = isMac ? 'macOS-arm64' : 'Windows-x64';
const build = JSON.parse(await readFile(path.join(output, `tauri-build-${platformName}.json`), 'utf8'));
if (build.version !== version) throw new Error('应用版本已变化，请重新执行 desktop:package。');
if (isMac) {
  const app = path.join(output, 'EnvGuardCC-tauri-darwin-arm64/EnvGuardCC.app');
  await access(path.join(app, 'Contents/Info.plist'));
  const temporary = await mkdtemp(path.join(output, '.mac-installer-'));
  const pending = path.join(temporary, 'EnvGuardCC.pending.dmg');
  try {
    const contents = path.join(temporary, 'contents');
    await mkdir(contents);
    await cp(app, path.join(contents, 'EnvGuardCC.app'), { recursive: true, verbatimSymlinks: true });
    await symlink('/Applications', path.join(contents, 'Applications'));
    await writeFile(path.join(contents, '安装说明 - 拖入 Applications 安装.txt'), '请先从托盘退出旧版并等待配置恢复。\n将 EnvGuardCC 拖入 Applications，替换旧版后从应用程序启动。\nQuit the old app and wait for restoration. Drag EnvGuardCC into Applications, replace the old copy, then launch from Applications.\n');
    await run('hdiutil', ['create', '-volname', 'EnvGuardCC', '-srcfolder', contents, '-ov', '-format', 'UDZO', pending]);
    await run('hdiutil', ['verify', pending]);
    const destination = path.join(output, `EnvGuardCC-${version}-arm64.dmg`);
    await rename(pending, destination);
    console.log('macOS 安装包：' + destination);
  } finally { if (path.dirname(temporary) === output) await rm(temporary, { recursive: true, force: true }); }
} else {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('安装包需要 Windows x64 或 macOS arm64。');
  // The NSIS bundler consumes the compiled executable, not the optional portable copy.
  await access(path.join(root, 'src-tauri/target/release/EnvGuardCC.exe'));
  const temporary = path.join(root, 'node_modules/.tauri-tools/tmp');
  await mkdir(temporary, { recursive: true });
  // Keep NSIS extraction and tool cache on the target drive (Windows rename is not cross-volume).
  await run(process.execPath, [tauriCli(), 'bundle', '--bundles', 'nsis', '--config', JSON.stringify({ bundle: { useLocalToolsDir: true } })], { env: buildEnvironment({ TEMP: temporary, TMP: temporary }) });
  const directory = path.join(root, 'src-tauri/target/release/bundle/nsis');
  const names = (await readdir(directory)).filter(name => name.endsWith('.exe') && name.includes(version));
  if (names.length !== 1) throw new Error('NSIS 安装包缺失或不唯一。');
  const destination = path.join(output, `EnvGuardCC-Setup-${version}.exe`);
  const pending = destination + '.pending';
  await cp(path.join(directory, names[0]), pending);
  await rename(pending, destination);
  console.log('Windows 安装包：' + destination);
}
