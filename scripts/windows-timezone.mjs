import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);

// Windows ignores _dstoff for zones without DST, and /g returns the bare ID.
// Do not strip the suffix for zones that really have seasonal clock changes.
export async function sameWindowsTimezone(actual, expected, { run = exec, env = process.env } = {}) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  if (actual.toLowerCase() === expected.toLowerCase()) return true;
  const base = value => value.replace(/_dstoff$/i, '').toLowerCase();
  if (base(actual) !== base(expected)) return false;
  const id = expected.replace(/_dstoff$/i, '').replaceAll("'", "''");
  const script = `$ErrorActionPreference = 'Stop'; [TimeZoneInfo]::FindSystemTimeZoneById('${id}').SupportsDaylightSavingTime`;
  const { stdout } = await run(windowsSystemExecutable('WindowsPowerShell\\v1.0\\powershell.exe', env), ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 });
  const supported = stdout.trim().toLowerCase();
  if (!['true', 'false'].includes(supported)) throw new Error('无法核对 Windows 夏令时规则，原始备份已保留。');
  return supported === 'false';
}
export function windowsSystemExecutable(name, env = process.env) {
  return path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', name);
}

export async function readWindowsTimezone({ run = exec, env = process.env, platform = process.platform } = {}) {
  if (platform !== 'win32') return '';
  let failure;
  const options = { windowsHide: true, timeout: 3000 };
  const failures = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { stdout } = await run(windowsSystemExecutable('tzutil.exe', env), ['/g'], options);
      const zone = stdout.trim();
      if (zone && zone.length < 128 && !/[\r\n\0]/.test(zone)) return zone;
      failures.push(`tzutil[${attempt + 1}]: invalid or empty output`);
    } catch (error) { failure = error; failures.push(`tzutil[${attempt + 1}]: ${error.code || (error.killed ? 'timeout' : error.message)}`); }
  }
  try {
    // tzutil may exit successfully without writing to redirected stdout.
    // Read the stored Windows ID; never substitute an IANA or target zone.
    const { stdout } = await run(windowsSystemExecutable('reg.exe', env), [
      'query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\TimeZoneInformation', '/v', 'TimeZoneKeyName',
    ], options);
    const zone = stdout.match(/^\s*TimeZoneKeyName\s+REG_SZ\s+([^\r\n]+)$/m)?.[1].trim();
    if (zone && zone.length < 128 && !/[\r\n\0]/.test(zone)) return zone;
    failures.push('registry: invalid or empty TimeZoneKeyName');
  } catch (error) { failure = error; failures.push(`registry: ${error.code || (error.killed ? 'timeout' : error.message)}`); }
  throw new Error('无法读取 Windows 系统时区，已拒绝修改配置以保护原始状态。' + ` (${failures.join('; ')})`, { cause: failure });
}
