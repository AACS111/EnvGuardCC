import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);
export function windowsSystemExecutable(name, env = process.env) {
  return path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', name);
}

export async function readWindowsTimezone({ run = exec, env = process.env, platform = process.platform } = {}) {
  if (platform !== 'win32') return '';
  let failure;
  const options = { windowsHide: true, timeout: 15000 };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { stdout } = await run(windowsSystemExecutable('tzutil.exe', env), ['/g'], options);
      const zone = stdout.trim();
      if (zone && zone.length < 128 && !/[\r\n\0]/.test(zone)) return zone;
    } catch (error) { failure = error; }
  }
  try {
    // tzutil may exit successfully without writing to redirected stdout.
    // Read the stored Windows ID; never substitute an IANA or target zone.
    const { stdout } = await run(windowsSystemExecutable('reg.exe', env), [
      'query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\TimeZoneInformation', '/v', 'TimeZoneKeyName',
    ], options);
    const zone = stdout.match(/^\s*TimeZoneKeyName\s+REG_SZ\s+([^\r\n]+)$/m)?.[1].trim();
    if (zone && zone.length < 128 && !/[\r\n\0]/.test(zone)) return zone;
  } catch (error) { failure = error; }
  throw new Error('无法读取 Windows 系统时区，已拒绝修改配置以保护原始状态。', { cause: failure });
}
