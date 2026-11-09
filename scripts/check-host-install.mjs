// 特权宿主应用内安装：命令必须是固定路径 + 系统授权弹窗，且取消要能读懂。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildInstallCommand, buildWindowsInstallCommand, cleanInstallerOutput, installKernelHost, shellQuote } from './net-core/host-install.mjs';
import { waitForMacHostUnload, buildHostInstallPlan } from './net-core/service.mjs';

test('macOS 重装等待旧作业退出，未退出或权限失败不能继续 bootstrap', async () => {
  let prints = 0, pauses = 0;
  await waitForMacHostUnload({ run: async (_, args) => {
    if (args[0] === 'print' && ++prints === 3) throw Object.assign(new Error('not found'), { code: 113 });
  }, pause: async () => { pauses++; } });
  assert.equal(prints, 3); assert.equal(pauses, 2);
  await assert.rejects(waitForMacHostUnload({ attempts: 2, run: async () => {}, pause: async () => {} }), /仍在退出/);
  await assert.rejects(waitForMacHostUnload({ run: async () => { throw Object.assign(new Error('permission'), { code: 1 }); } }), /permission/);
  const plan = buildHostInstallPlan({ platform: 'darwin', nodePath: '/node', hostScript: '/host', stateDir: '/state', binary: '/kernel' });
  assert.deepEqual(plan.commands.map(x => x.args[0]), ['enable', 'bootstrap']);
});

test('安装命令使用绝对路径、显式状态目录并只执行 --apply', () => {
  const command = buildInstallCommand({
    nodePath: '/usr/local/bin/node',
    scriptPath: '/repo/scripts/net-core/install-host.mjs',
    stateDir: '/Users/x/Library/Application Support/check-cc/state',
    binary: '/repo/node_modules/.checkcc-kernel/mihomo',
  });
  assert.match(command, /^CHECKCC_STATE_DIR='\/Users\/x\/Library\/Application Support\/check-cc\/state' CHECKCC_NET_CORE_BINARY='\/repo\/node_modules\/\.checkcc-kernel\/mihomo' /);
  assert.match(command, /'\/usr\/local\/bin\/node' '\/repo\/scripts\/net-core\/install-host\.mjs' --apply$/);
});

test('单引号会被转义，路径无法注入额外命令', () => {
  const evil = "/tmp/it's; rm -rf /";
  assert.equal(shellQuote(evil), "'/tmp/it'\\''s; rm -rf /'");
  // 交给真实 sh 解析：整个值必须仍然是单个参数，分号不生效。
  assert.equal(execFileSync('/bin/sh', ['-c', `printf '%s' ${shellQuote(evil)}`]).toString(), evil);
  const command = buildInstallCommand({ scriptPath: '/repo/x.mjs', stateDir: evil });
  assert.ok(command.includes(shellQuote(evil)));
});

test('macOS 通过 osascript 请求系统管理员授权', async () => {
  const calls = [];
  const result = await installKernelHost({
    stateDir: '/tmp/state',
    binary: '/tmp/kernel',
    platform: 'darwin',
    nodePath: '/usr/local/bin/node',
    scriptPath: '/repo/install-host.mjs',
    run: async (file, args) => { calls.push({ file, args }); return { stdout: 'done', stderr: '' }; },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, '/usr/bin/osascript');
  assert.equal(calls[0].args[0], '-e');
  assert.match(calls[0].args[1], /with administrator privileges/);
  assert.match(calls[0].args[2], /install-host\.mjs' --apply$/);
  assert.equal(result.installed, true);
  assert.equal(result.output, 'done');
});

test('用户取消授权给出可读原因，而不是安装失败', async () => {
  const error = Object.assign(new Error('Command failed'), { stderr: 'execution error: User canceled. (-128)' });
  await assert.rejects(installKernelHost({ stateDir: '/tmp/state', binary: '/tmp/kernel', platform: 'darwin', run: async () => { throw error; } }), /授权已取消/);
});

test('不支持的平台明确要求手动安装', async () => {
  await assert.rejects(installKernelHost({ stateDir: '/tmp', binary: '/tmp/k', platform: 'linux' }), /手动安装/);
  await assert.rejects(installKernelHost({ stateDir: '', binary: '/tmp/k', platform: 'darwin' }), /状态目录/);
});

test('Windows 以 UAC 执行编码命令，安装器输出落到日志并回读', async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'checkcc-windows-auth-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const command = buildWindowsInstallCommand({nodePath:'C:\\Program Files\\Node\\node.exe',scriptPath:"C:\\App\\it's install.mjs",stateDir,binary:'C:\\App\\mihomo.exe'});
  const outer = Buffer.from(command.args.at(-1), 'base64').toString('utf16le');
  assert.match(outer, /Start-Process.*-Verb RunAs/);
  const inner = Buffer.from(outer.match(/'-EncodedCommand', '([^']+)'/)[1], 'base64').toString('utf16le');
  assert.match(inner, /"C:\\App\\it''s install\.mjs"/, '路径必须是 cmd 的双引号数据，不能被解释');
  assert.match(inner, /NODE_OPTIONS/);
  assert.match(inner, /cmd\.exe \/c/, '输出必须由 cmd 重定向到日志：提权后无法继承 stdout');
  assert.ok(inner.includes(command.logFile), '内层命令必须写回日志文件');
  assert.match(inner, /--apply/);
  let invoked = false;
  const installed = await installKernelHost({stateDir,binary:'C:\\App\\mihomo.exe',scriptPath:'C:\\App\\install.mjs',platform:'win32',run:async(file,args)=>{invoked=true;assert.equal(file,'powershell.exe');assert.ok(args.includes('-EncodedCommand'));return {stdout:'done'};}});
  assert.equal(invoked,true); assert.equal(installed.installed,true);
  await assert.rejects(installKernelHost({stateDir,platform:'win32',run:async()=>{throw new Error('Operation canceled 1223');}}), /授权已取消/);
});

test('提权进程失败时从日志读出真实原因，不把 CLIXML 进度噪声丢给用户', async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'checkcc-windows-log-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const logFile = path.join(stateDir, 'host-install.log');
  const noisy = '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress"><MS><AV>正在准备首次使用模块。</AV></MS></Obj></Objs>\n#< CLIXML\n';
  assert.equal(cleanInstallerOutput(noisy), '', 'CLIXML 进度记录必须被剔除');
  assert.equal(cleanInstallerOutput('a\r\n\r\nb\r\n'), 'a\nb');

  // 模拟提权进程把真实错误写进日志，而外层只拿到 CLIXML。
  await assert.rejects(
    installKernelHost({
      stateDir, platform: 'win32', binary: 'C:\\App\\mihomo.exe', scriptPath: 'C:\\App\\install.mjs',
      run: async () => {
        await writeFile(path.join(stateDir, 'host-install.log'), '[install] 执行 schtasks.exe /Create\n[install] 拒绝访问。\n', 'utf8');
        throw Object.assign(new Error('Command failed'), { stderr: noisy });
      },
    }),
    (error) => {
      assert.match(error.message, /拒绝访问/);
      assert.match(error.message, /host-install\.log/);
      assert.doesNotMatch(error.message, /Objs Version|CLIXML/);
      return true;
    },
  );
});

test('安装前由当前用户准备令牌，root 安装器复用它', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'checkcc-host-token-'));
  try {
    const run = async () => ({ stdout: '', stderr: '' });
    await installKernelHost({ stateDir: directory, binary: '/tmp/kernel', platform: 'darwin', run });
    const file = path.join(directory, 'host-token');
    const token = (await readFile(file, 'utf8')).trim();
    assert.match(token, /^[a-f0-9]{64}$/);
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
    // 重复安装不能换令牌：换了以后已安装的宿主会全部鉴权失败。
    await installKernelHost({ stateDir: directory, binary: '/tmp/kernel', platform: 'darwin', run });
    assert.equal((await readFile(file, 'utf8')).trim(), token);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
