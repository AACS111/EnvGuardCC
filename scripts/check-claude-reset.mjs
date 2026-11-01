import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClaudeReset, claudeDataPaths, isClaudeRunning } from './claude-reset.mjs';

async function fixture(t, platform = 'darwin') {
  const home = await mkdtemp(path.join(tmpdir(), 'claude-reset-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const options = { platform, home, env: {}, running: async () => false };
  const targets = await claudeDataPaths(options);
  await mkdir(targets[0], { recursive: true });
  await writeFile(path.join(targets[0], 'Cookies'), 'fake test token');
  const trashDir = path.join(home, 'test-trash');
  await mkdir(trashDir);
  let count = 0;
  options.trash = target => rename(target, path.join(trashDir, String(count++)));
  return { home, options, targets, trashDir };
}

test('Windows 和 Mac 重置完整桌面资料，保留程序、CLI 和用户项目，废纸篓中可恢复', async t => {
  for (const platform of ['darwin', 'win32']) await t.test(platform, async t => {
    const f = await fixture(t, platform);
    await mkdir(path.join(f.home, '.claude'));
    await writeFile(path.join(f.home, '.claude', 'settings.json'), 'keep');
    await writeFile(path.join(f.home, 'project.txt'), 'keep');
    const reset = createClaudeReset(f.options);
    const plan = await reset.preview();
    assert.equal(plan.paths.length, 1);
    const result = await reset.reset(plan.paths);
    assert.equal(result.complete, true);
    await assert.rejects(access(f.targets[0]), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(f.trashDir, '0', 'Cookies'), 'utf8'), 'fake test token');
    assert.equal(await readFile(path.join(f.home, '.claude', 'settings.json'), 'utf8'), 'keep');
    assert.equal(await readFile(path.join(f.home, 'project.txt'), 'utf8'), 'keep');
  });
});

test('Windows 识别受支持的 MSIX 资料和外置 Claude-Data，忽略同名前缀的其他软件', async t => {
  const f = await fixture(t, 'win32');
  const local = path.join(f.home, 'AppData', 'Local');
  const profile = path.join(local, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude');
  const external = path.join(local, 'Claude-Data', 'claude_pzs8sxrjxfjjc');
  const unrelated = path.join(local, 'Packages', 'Claude_unrelated', 'LocalState');
  for (const name of [profile, external, unrelated]) await mkdir(name, { recursive: true });
  const reset = createClaudeReset(f.options);
  const plan = await reset.preview();
  assert.ok(plan.paths.includes(profile)); assert.ok(plan.paths.includes(external));
  assert.ok(!plan.paths.includes(unrelated));
  await reset.reset(plan.paths);
  await access(unrelated);
});

test('拒绝符号链接和联接祖先；拒绝用户目录以外的重定向 APPDATA', async t => {
  const f = await fixture(t);
  await rm(f.targets[0], { recursive: true });
  const real = path.join(f.home, 'keep');
  await mkdir(real);
  await symlink(real, f.targets[0], 'junction');
  await assert.rejects(createClaudeReset(f.options).preview(), /符号链接|目录联接/);
  await rm(f.targets[0]);
  const parent = path.dirname(f.targets[0]);
  await rm(parent, { recursive: true });
  await symlink(real, parent, 'junction');
  await assert.rejects(createClaudeReset(f.options).preview(), /符号链接|目录联接/);
  const other = createClaudeReset({ ...f.options, platform: 'win32', env: { APPDATA: path.dirname(f.home) } });
  await assert.rejects(other.preview(), /用户目录/);
});

test('客户端运行、确认后目录变化及清理中重启时停止；权限失败报告部分完成', async t => {
  const f = await fixture(t);
  let running = true;
  const reset = createClaudeReset({ ...f.options, running: async () => running });
  const plan = await reset.preview();
  await assert.rejects(reset.reset(plan.paths), /先退出/);
  running = false;
  await mkdir(f.targets[1], { recursive: true });
  await assert.rejects(reset.reset(plan.paths), /已变化/);
  const next = await reset.preview();
  let calls = 0;
  const partial = createClaudeReset({ ...f.options, trash: async target => { if (++calls === 2) throw new Error('locked'); await f.options.trash(target); } });
  await assert.rejects(partial.reset(next.paths), error => error.message === 'locked' && error.cleared.length === 1);
  await access(f.targets[1]);
  let reads = 0;
  const restarted = createClaudeReset({ ...f.options, running: async () => ++reads > 1 });
  await assert.rejects(restarted.reset([f.targets[1]]), /再次启动/);
  await access(f.targets[1]);
});

test('进程检查识别客户端及 Helper，避免把 Claude Code 当作桌面客户端', async () => {
  const mac = stdout => isClaudeRunning({ platform: 'darwin', run: async () => ({ stdout }) });
  assert.equal(await mac('/Applications/Claude.app/Contents/MacOS/Claude\n'), true);
  assert.equal(await mac('/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper\n'), true);
  assert.equal(await mac('/usr/local/bin/claude\n/Applications/EnvGuardCC.app/Contents/MacOS/EnvGuardCC\n'), false);
  assert.equal(await isClaudeRunning({ platform: 'win32', run: async () => ({ stdout: '2\r\n' }) }), true);
  await assert.rejects(isClaudeRunning({ platform: 'win32', run: async () => ({ stdout: 'unknown' }) }), /无法确认/);
});
