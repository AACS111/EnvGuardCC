import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { readWindowsTimezone, windowsSystemExecutable } from './windows-timezone.mjs';

const exec = promisify(execFile);
export const timezoneSupported = platform => ['win32', 'darwin'].includes(platform);

export function validIanaTimezone(zone) {
  if (typeof zone !== 'string' || zone.length > 128 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(zone) || zone.includes('..')) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); return true; }
  catch { return false; }
}

export function sameTimezone(left, right) {
  const canonical = zone => new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone;
  try { return canonical(left) === canonical(right); } catch { return left === right; }
}

export async function readSystemTimezone({ platform = process.platform, run = exec, resolve = realpath } = {}) {
  if (platform === 'win32') return readWindowsTimezone({ run, platform });
  if (platform !== 'darwin') return '';
  let file;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { file = await resolve('/etc/localtime'); break; }
    catch (error) { if (error.code !== 'ENOENT' || attempt === 19) throw error; await delay(100); }
  }
  const zone = file.split('/zoneinfo/').at(-1);
  if (zone === file || !validIanaTimezone(zone)) throw new Error('无法读取原始 macOS 系统时区，未修改设置。');
  return zone;
}

export async function setSystemTimezone(zone, { platform = process.platform, run = exec, read = readSystemTimezone, checkZone = zone => access('/var/db/timezone/zoneinfo/' + zone) } = {}) {
  if (platform === 'win32') {
    if (typeof zone !== 'string' || zone.length > 128 || /[\r\n\0]/.test(zone)) throw new Error('无效的 Windows 时区。');
    await run(windowsSystemExecutable('tzutil.exe'), ['/s', zone], { windowsHide: true, timeout: 15000 });
  } else if (platform === 'darwin') {
    if (!validIanaTimezone(zone)) throw new Error('无效的 IANA 系统时区。');
    try { await checkZone(zone); } catch { throw new Error('本机未安装该系统时区，未执行修改。'); }
    // Only a fixed command is privileged. The requested zone is passed as data and shell-quoted by AppleScript.
    const script = 'on run argv\n do shell script "/usr/sbin/systemsetup -settimezone " & quoted form of (item 1 of argv) with administrator privileges\nend run';
    try { await run('/usr/bin/osascript', ['-e', script, zone], { timeout: 110000, maxBuffer: 4096 }); }
    catch (error) {
      if (/-128|canceled|cancelled|用户取消/i.test(error.stderr || error.message)) throw new Error('已取消系统授权，时区未确认修改；原始备份已保留。');
      throw new Error('macOS 时区操作未完成，请核对系统授权及自动时区设置；原始备份已保留。', { cause: error });
    }
  } else throw new Error('当前系统不支持自动修改时区。');
  let actual;
  for (let attempt = 0; attempt < (platform === 'darwin' ? 20 : 1); attempt++) {
    actual = await read({ platform, run });
    if (platform === 'darwin' ? sameTimezone(actual, zone) : actual === zone) break;
    if (platform === 'darwin') await delay(100);
  }
  if (platform === 'darwin' ? !sameTimezone(actual, zone) : actual !== zone) throw new Error('系统时区复核未通过，可能被自动时区覆盖；原始备份已保留。');
  return actual;
}
