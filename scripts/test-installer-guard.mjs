import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { projectRoot as root } from './tauri-tools.mjs';

if (process.platform !== 'win32') {
  console.log('NSIS guard regression: Windows only.');
} else {
  const compiler = path.join(root, 'src-tauri/target/.tauri/NSIS/makensis.exe');
  await access(compiler).catch(() => { throw new Error('请先运行 desktop:installer，准备本地 NSIS 工具。'); });
  const tools = path.join(root, 'node_modules/.tauri-tools');
  await mkdir(tools, { recursive: true });
  const directory = await mkdtemp(path.join(tools, 'installer-guard-'));
  const marker = path.join(directory, 'passed.txt');
  const probe = path.join(directory, 'GuardProbe.exe');
  const script = path.join(directory, 'probe.nsi');
  const quote = value => value.replace(/\$/g, () => '$$').replace(/"/g, () => '$\\"');
  // Include the production macro verbatim. Seed the registers involved in the
  // original false positive so this also catches a regression in System::Call.
  await writeFile(script, `Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "EnvGuardCC installer guard test"
OutFile "${quote(probe)}"
!include "LogicLib.nsh"
!include "${quote(path.join(root, 'src-tauri/installer/hooks.nsh'))}"
Section
  StrCpy $0 "preserved"
  StrCpy $1 "EnvGuardCC.exe"
  StrCpy $R2 "stale-active-result"
  !insertmacro ENVGUARD_REQUIRE_EXIT
  FileOpen $R9 "${quote(marker)}" w
  FileWrite $R9 "$0"
  FileClose $R9
SectionEnd
`);
  const run = (command, args) => new Promise((resolve, reject) => {
    let output = '';
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { output = (output + data).slice(-4000); });
    child.stderr.on('data', data => { output = (output + data).slice(-4000); });
    child.once('error', reject);
    child.once('exit', code => resolve({ code, output }));
  });
  const compiled = await run(compiler, ['/V2', script]);
  assert.equal(compiled.code, 0, compiled.output);
  const absent = await run(probe, []);
  assert.equal(absent.code, 0, '未运行客户端时不应拦截安装：' + absent.output);
  assert.equal(await readFile(marker, 'utf8'), 'preserved');
  console.log('PASS: no client process allows installation; caller register is preserved.');
  await rm(marker);

  // This is a harmless Node timer with the same image name, not a real client.
  // It owns no application settings, protection session, or system changes.
  const fixtureClient = path.join(directory, 'EnvGuardCC.exe');
  await cp(process.execPath, fixtureClient);
  const client = spawn(fixtureClient, ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await Promise.race([
      once(client.stdout, 'data'),
      once(client, 'error').then(([error]) => { throw error; }),
      once(client, 'exit').then(([code]) => { throw new Error('测试进程提前退出：' + code); }),
    ]);
    const running = await run(probe, []);
    assert.equal(running.code, 1, '运行中客户端必须拦截安装：' + running.output);
    await assert.rejects(access(marker), { code: 'ENOENT' });
    assert.equal(client.exitCode, null, '安装器不得强制结束客户端。');
    console.log('PASS: running client blocks installation and is not terminated.');
  } finally {
    if (client.exitCode === null) {
      const exited = once(client, 'exit'); client.kill(); await exited;
    }
  }
  const exited = await run(probe, []);
  assert.equal(exited.code, 0, '客户端退出后应允许重新安装。');
  assert.equal(await readFile(marker, 'utf8'), 'preserved');
  console.log('PASS: installation is allowed again after the client exits.');
}
