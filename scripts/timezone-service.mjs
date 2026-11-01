import { access, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const label = 'io.github.aacs111.envguardcc.timezone';
const binary = '/Library/PrivilegedHelperTools/' + label;
const plist = '/Library/LaunchDaemons/' + label + '.plist';
const supported = () => process.platform === 'darwin' && Number(os.release().split('.')[0]) >= 22;
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
let authorizationAttempted = false;
export function resetTimezoneServiceAuthorization() { authorizationAttempted = false; }

async function directory() {
  for (const dir of [path.join(root, 'runtime/timezone-service'), path.join(root, 'node_modules/.checkcc-timezone-service')]) {
    try { await access(path.join(dir, 'bridge')); await access(path.join(dir, 'daemon')); return dir; } catch { /* Try development build. */ }
  }
  return null;
}
async function call(args, run = exec) {
  const dir = await directory();
  if (!dir) return { state: 'unavailable', ok: false, detail: '当前构建未包含系统时区服务。' };
  let stdout;
  try { ({ stdout } = await run(path.join(dir, 'bridge'), args, { timeout: 60000, maxBuffer: 8192 })); }
  catch (error) { stdout = error.stdout; if (!stdout) return { state: 'unavailable', ok: false, detail: '系统时区服务暂不可用，原始备份已保留。' }; }
  try { return JSON.parse(stdout); } catch { return { state: 'unavailable', ok: false, detail: '系统时区服务返回无效结果。' }; }
}
async function serviceHealth() {
  const status = await call(['status']);
  if (status.state !== 'ready' || !status.ok) return status;
  const dir = await directory();
  try {
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    if (hash(await readFile(path.join(dir, 'daemon'))) !== hash(await readFile(binary))) return { state: 'updateRequired', ok: false };
  } catch { return { state: 'unavailable', ok: false }; }
  return status;
}
export async function timezoneServiceStatus() {
  if (!supported()) return { supported: false, state: 'unsupported', mode: 'temporary', canInstall: false, detail: '当前系统使用临时授权修改时区。' };
  const mode = 'auto';
  const dir = await directory();
  if (!dir) return { supported: true, state: 'unavailable', mode, canInstall: false, detail: '当前构建未包含时区服务；修改和恢复时区时使用系统临时授权。' };
  const report = await serviceHealth();
  const details = {
    ready: '系统时区服务已就绪，修改和恢复时区无需重复输入密码。',
    notInstalled: '首次开启保护时将请求系统授权，之后自动复用。',
    updateRequired: '时区服务需要更新或重新授权。当前构建与已批准的客户端不一致，或服务已停用。',
    unavailable: '系统时区服务暂不可用，下次显式开启保护时尝试重新授权。',
  };
  return { supported: true, state: report.state, mode, canInstall: true, detail: details[report.state] || details.unavailable };
}

// All paths/verbs are fixed. Copy into a root-only staging directory, verify exact
// bytes after copying, then atomically replace root-owned service files. No shell
// command or executable path is accepted from an HTTP/XPC request.
export function timezoneInstallScript(source, daemonHash, plistSource, plistHash) {
  if (![daemonHash, plistHash].every(hash => /^[a-f0-9]{64}$/.test(hash))) throw new Error('无效的服务校验值。');
  return `set -eu
umask 077
/bin/mkdir -p /Library/PrivilegedHelperTools /Library/LaunchDaemons
test ! -L /Library/PrivilegedHelperTools && test ! -L /Library/LaunchDaemons
test "$(/usr/bin/stat -f %u /Library/PrivilegedHelperTools)" = 0
test "$(/usr/bin/stat -f %u /Library/LaunchDaemons)" = 0
test "$((0$(/usr/bin/stat -f %Lp /Library/PrivilegedHelperTools) & 022))" = 0
test "$((0$(/usr/bin/stat -f %Lp /Library/LaunchDaemons) & 022))" = 0
test ! -L ${quote(binary)} && test ! -L ${quote(plist)}
stage=$(/usr/bin/mktemp -d /Library/PrivilegedHelperTools/.envguardcc-timezone.XXXXXX)
had_old=0
committed=0
cleanup() {
  if [ "$committed" = 0 ] && [ "$had_old" = 1 ]; then
    /bin/launchctl bootout system/${label} >/dev/null 2>&1 || true
    /bin/cp "$stage/old-daemon" ${quote(binary)}
    /bin/cp "$stage/old-plist" ${quote(plist)}
    /bin/chmod 755 ${quote(binary)}; /bin/chmod 644 ${quote(plist)}
    /bin/launchctl bootstrap system ${quote(plist)} >/dev/null 2>&1 || true
  elif [ "$committed" = 0 ] && [ -f "$stage/switched" ]; then
    /bin/launchctl bootout system/${label} >/dev/null 2>&1 || true
    /bin/rm -f ${quote(binary)} ${quote(plist)}
  fi
  /bin/rm -rf "$stage"
}
trap cleanup EXIT
/bin/cp ${quote(source)} "$stage/daemon"
/bin/cp ${quote(plistSource)} "$stage/service.plist"
printf '%s  %s\\n' ${quote(daemonHash)} "$stage/daemon" | /usr/bin/shasum -a 256 -c -
printf '%s  %s\\n' ${quote(plistHash)} "$stage/service.plist" | /usr/bin/shasum -a 256 -c -
/usr/bin/codesign --verify --strict "$stage/daemon"
/usr/bin/plutil -lint "$stage/service.plist"
/usr/sbin/chown root:wheel "$stage/daemon" "$stage/service.plist"
/bin/chmod 755 "$stage/daemon"; /bin/chmod 644 "$stage/service.plist"
if [ -f ${quote(binary)} ] && [ -f ${quote(plist)} ]; then
  /bin/cp ${quote(binary)} "$stage/old-daemon"
  /bin/cp ${quote(plist)} "$stage/old-plist"
  had_old=1
fi
/bin/launchctl bootout system/${label} >/dev/null 2>&1 || true
/usr/bin/touch "$stage/switched"
/bin/mv -f "$stage/daemon" ${quote(binary)}
/bin/mv -f "$stage/service.plist" ${quote(plist)}
/bin/launchctl bootstrap system ${quote(plist)}
committed=1`;
}
export async function installTimezoneService() {
  if (!supported()) throw new Error('系统时区服务需要 macOS 13 或更新版本。');
  const dir = await directory();
  if (!dir) throw new Error('当前构建未包含系统时区服务。');
  const source = path.join(dir, 'daemon');
  const plistSource = path.join(dir, 'service.plist');
  const content = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${binary}</string></array><key>MachServices</key><dict><key>${label}</key><true/></dict><key>UserName</key><string>root</string><key>ProcessType</key><string>Background</string></dict></plist>`;
  await writeFile(plistSource, content, { mode: 0o600 });
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const command = timezoneInstallScript(source, hash(await readFile(source)), plistSource, hash(Buffer.from(content)));
  try {
    await exec('/usr/bin/osascript', ['-e', 'on run argv\n do shell script (item 1 of argv) with administrator privileges\nend run', command], { timeout: 110000, maxBuffer: 16384 });
  } catch (error) {
    if (/-128|canceled|cancelled|用户取消/i.test(error.stderr || error.message)) throw new Error('已取消服务安装，继续使用临时授权。');
    throw new Error('系统时区服务安装未完成，请检查管理员授权；原始备份已保留。');
  }
  const report = await serviceHealth();
  if (!report.ok || report.state !== 'ready') throw new Error('服务已安装但连接验证未通过，请重新授权安装或使用临时授权。');
  return timezoneServiceStatus();
}
export async function removeTimezoneService() {
  const report = await call(['uninstall']);
  if (!report.ok) throw new Error('服务卸载未完成，请先重新授权安装以修复服务，再重试卸载。');
  return timezoneServiceStatus();
}
export async function applyTimezoneWithService(zone, automatic, { isSupported = supported, allowInstall = true, install = installTimezoneService, request = call } = {}) {
  if (!isSupported()) return false;
  let status = await (request === call ? serviceHealth() : request(['status']));
  if (status.state !== 'ready' || !status.ok) {
    if (!allowInstall) return false;
    if (request === call && !await directory()) return false;
    if (authorizationAttempted) throw new Error('系统时区服务尚未获得授权，原始备份已保留。请关闭保护后重新开启以重试授权。');
    authorizationAttempted = true;
    await install();
    status = await (request === call ? serviceHealth() : request(['status']));
    if (status.state !== 'ready' || !status.ok) throw new Error('系统时区服务尚未就绪，原始备份已保留。');
  }
  const result = await request(['set', zone, String(automatic)]);
  if (!result.ok) throw new Error('系统时区服务操作失败，原始备份已保留；请重试关闭保护以恢复。');
  return true;
}
