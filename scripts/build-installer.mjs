import { access, mkdir, readFile, rm, cp, mkdtemp, symlink, writeFile, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNpmCli } from './dev-electron.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'node_modules', '.checkcc-dist');
const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: 'inherit', ...options });
  child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Build step failed: ${code}`)));
});

if (process.platform === 'darwin' && process.arch === 'arm64') {
  const app = path.join(output, 'EnvGuardCC-darwin-arm64', 'EnvGuardCC.app');
  await access(path.join(app, 'Contents', 'Info.plist'));
  const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  const dmg = path.join(output, `EnvGuardCC-${version}-arm64.dmg`);
  const staging = await mkdtemp(path.join(output, '.mac-installer-'));
  const pending = path.join(staging, 'EnvGuardCC.pending.dmg');
  try {
    const contents = path.join(staging, 'contents');
    await mkdir(contents);
    await cp(app, path.join(contents, 'EnvGuardCC.app'), { recursive: true, verbatimSymlinks: true });
    await symlink('/Applications', path.join(contents, 'Applications'));
    await writeFile(path.join(contents, '安装说明 - 拖入 Applications 安装.txt'), [
      'EnvGuardCC 安装说明', '',
      '1. 若旧版正在运行，请从托盘或应用菜单选择退出，等待配置恢复完成。',
      '2. 将本窗口中的 EnvGuardCC 拖入旁边的 Applications（应用程序）文件夹。',
      '3. 如提示替换旧版本，请选择替换。',
      '4. 从“应用程序”打开 EnvGuardCC，然后推出此磁盘映像。', '',
      '双击 DMG 只是打开磁盘映像；直接运行映像中的应用不会将其安装到应用程序。', '',
      'Installation', '',
      'Quit any running copy of EnvGuardCC and wait for configuration restoration.',
      'Drag EnvGuardCC into the Applications folder beside it. Replace an older copy if prompted.',
      'Launch EnvGuardCC from Applications, then eject this disk image.',
      'Opening the DMG or running the app inside it does not install the app.', '',
    ].join('\n'));
    await run('hdiutil', ['create', '-volname', 'EnvGuardCC', '-srcfolder', contents, '-ov', '-format', 'UDZO', pending]);
    await run('hdiutil', ['verify', pending]);
    // Keep the previous installer intact until the replacement is verified.
    await rename(pending, dmg);
  } finally { await rm(staging, { recursive: true, force: true }); }
  console.log(`macOS disk image: ${dmg}`);
  process.exit(0);
}
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('安装包需要 macOS arm64 或 Windows x64 Node。');
const application = path.join(output, 'EnvGuardCC-win32-x64');
await access(path.join(application, 'EnvGuardCC.exe'));
const toolsDir = path.join(root, 'node_modules', '.envguardcc-installer-build');
await mkdir(toolsDir, { recursive: true });
const require = createRequire(path.join(toolsDir, 'package.json'));
try { require.resolve('electron-builder'); }
catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  const npmCli = resolveNpmCli();
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli, 'install', '--prefix', toolsDir, '--save-exact', '--no-audit', '--no-fund', 'electron-builder@26.0.12'], {
      cwd: root, windowsHide: true, stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`安装打包工具失败：${code}`)));
  });
}

const { build, Platform, Arch } = require('electron-builder');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const electron = JSON.parse(await readFile(path.join(root, 'node_modules', '.checkcc-desktop-build', 'node_modules', 'electron', 'package.json'), 'utf8'));
const artifacts = await build({
  projectDir: root,
  prepackaged: application,
  targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
  publish: 'never',
  config: {
    appId: 'io.github.aacs111.envguardcc',
    productName: 'EnvGuardCC',
    electronVersion: electron.version,
    artifactName: 'EnvGuardCC-Setup-${version}.${ext}',
    directories: { output },
    extraMetadata: { version: manifest.version },
    win: { icon: path.join(root, 'desktop', 'envguardcc.ico'), signAndEditExecutable: false },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: 'EnvGuardCC',
      deleteAppDataOnUninstall: false,
    },
  },
});
for (const artifact of artifacts) console.log(`Windows installer: ${artifact}`);
