import test from 'node:test';
import assert from 'node:assert/strict';
import { readWindowsTimezone, windowsSystemExecutable } from './windows-timezone.mjs';

const windows = { platform: 'win32', env: { SystemRoot: 'D:\\Windows' } };
test('使用系统目录绝对路径读取 Windows 时区，不依赖 PATH', async () => {
  const calls = [];
  const zone = await readWindowsTimezone({ ...windows, run: async (...args) => { calls.push(args); return { stdout: 'Korea Standard Time\r\n' }; } });
  assert.equal(zone, 'Korea Standard Time');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'D:\\Windows\\System32\\tzutil.exe');
  assert.deepEqual(calls[0][1], ['/g']);
  assert.equal(calls[0][2].windowsHide, true);
});
test('连续空输出时读取 Windows 时区注册值，不将空值作为备份', async () => {
  const calls = [];
  const zone = await readWindowsTimezone({ ...windows, run: async (file, args) => { calls.push({ file, args }); return { stdout: file.endsWith('tzutil.exe') ? ' \r\n' : 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\TimeZoneInformation\r\n    TimeZoneKeyName    REG_SZ    Pacific Standard Time\r\n' }; } });
  assert.equal(zone, 'Pacific Standard Time');
  assert.equal(calls.length, 4);
  assert.equal(calls[3].file, 'D:\\Windows\\System32\\reg.exe');
  assert.deepEqual(calls[3].args, ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\TimeZoneInformation', '/v', 'TimeZoneKeyName']);
});
test('偶发空输出后重试成功，不运行后备命令', async () => {
  let attempts = 0;
  const zone = await readWindowsTimezone({ ...windows, run: async () => ({ stdout: ++attempts < 3 ? '' : 'UTC' }) });
  assert.equal(zone, 'UTC');
  assert.equal(attempts, 3);
});
test('tzutil 无法启动仍能读取 Windows 保存的时区标识', async () => {
  const zone = await readWindowsTimezone({ ...windows, run: async file => { if (file.endsWith('tzutil.exe')) throw Object.assign(new Error('not found'), { code: 'ENOENT' }); return { stdout: '    TimeZoneKeyName    REG_SZ    China Standard Time\r\n' }; } });
  assert.equal(zone, 'China Standard Time');
});
test('所有读取方式失败时拒绝修改，不伪造时区', async () => {
  const cause = new Error('access denied');
  await assert.rejects(readWindowsTimezone({ ...windows, run: async () => { throw cause; } }), error => /已拒绝修改/.test(error.message) && error.cause === cause);
  await assert.rejects(readWindowsTimezone({ ...windows, run: async () => ({ stdout: '' }) }), /已拒绝修改/);
});
test('不接受多行内容作为时区，非 Windows 不运行命令', async () => {
  await assert.rejects(readWindowsTimezone({ ...windows, run: async () => ({ stdout: 'UTC\nUnexpected output' }) }), /已拒绝修改/);
  assert.equal(await readWindowsTimezone({ platform: 'linux', run: async () => { throw new Error('must not run'); } }), '');
  assert.equal(windowsSystemExecutable('tzutil.exe', { windir: 'E:\\Windows' }), 'E:\\Windows\\System32\\tzutil.exe');
});
