import { access, mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('安装包需要 Windows x64 Node。');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'node_modules', '.checkcc-dist');
const application = path.join(output, 'EnvGuardCC-win32-x64');
await access(path.join(application, 'EnvGuardCC.exe'));
const toolsDir = path.join(root, 'node_modules', '.envguardcc-installer-build');
await mkdir(toolsDir, { recursive: true });
const require = createRequire(path.join(toolsDir, 'package.json'));
try { require.resolve('electron-builder'); }
catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
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
