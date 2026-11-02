import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { projectRoot as root } from './tauri-tools.mjs';

const isMac = process.platform === 'darwin';
const args = process.argv.slice(2);
const aclMode = args.includes('--remote-acl') ? 'remote' : 'local';
const executable = args.find(argument => !argument.startsWith('--')) || path.join(root, 'node_modules/.checkcc-dist', isMac ? 'EnvGuardCC-tauri-darwin-arm64/EnvGuardCC.app/Contents/MacOS/EnvGuardCC' : 'EnvGuardCC-tauri-win32-x64/EnvGuardCC.exe');
const directory = path.join(root, 'node_modules/.tauri-tools');
await mkdir(directory, { recursive: true });
const fixture = await mkdtemp(path.join(directory, 'smoke-'));
await writeFile(path.join(fixture, 'desktop-settings.json'), JSON.stringify({ openAtLogin: false, autoStartProtection: false }));
const reportFile = path.join(fixture, 'smoke.json');
const quitFile = path.join(fixture, 'quit');
const probe = net.createServer();
await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const env = { ...process.env, CHECKCC_DESKTOP_SMOKE: '1', CHECKCC_DESKTOP_SMOKE_ACL_MODE: aclMode, CHECKCC_DESKTOP_SMOKE_PORT: String(port), CHECKCC_DESKTOP_USER_DATA: fixture, CHECKCC_STATE_DIR: path.join(fixture, 'state'), CHECKCC_SMOKE_REPORT: reportFile, CHECKCC_DESKTOP_QUIT_FILE: quitFile };
delete env.CHECKCC_DESKTOP_DEV_URL;
// The packaged host must find its own Node rather than relying on a PATH installation.
const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
env[pathKey] = (env[pathKey] || '').split(path.delimiter).filter(directory => !/nodejs|nvm|node_global/i.test(directory)).join(path.delimiter);
const child = spawn(executable, [], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', data => { output = (output + data).slice(-6000); });
child.stderr.on('data', data => { output = (output + data).slice(-6000); });
const timer = setTimeout(() => { void writeFile(quitFile, 'quit'); }, 90000);
try {
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  const report = JSON.parse(await readFile(reportFile, 'utf8').catch(() => '{}'));
  if (code !== 0 || report.passed !== true) throw new Error(`桌面实测失败 (${code})：${JSON.stringify(report)}\n${output}`);
  if (report.tauriDevMode !== false) throw new Error('ACL 验证必须运行正式 Tauri 配置：' + JSON.stringify(report));
  if (report.frontendMatchesPage !== (aclMode === 'local')) throw new Error('ACL 测试没有覆盖期望的生产 URL 分类：' + JSON.stringify(report));
  await writeFile(reportFile, JSON.stringify({ ...report, aclMode }, null, 2));
  console.log(`Tauri ${aclMode} ACL / 控件保存 / 原生权限边界实测通过。`);
  console.log('报告：' + reportFile);
} finally { clearTimeout(timer); }
