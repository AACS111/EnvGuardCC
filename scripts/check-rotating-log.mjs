import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRotatingLog } from './net-core/rotating-log.mjs';
import { buildHostInstallPlan } from './net-core/service.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egcc-rotation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'host-log.txt') };
}

test('持续运行无需重启即可轮转，仅保留当前文件及两份备份，UTF-8 按字节限额', async t => {
  const { dir, file } = await fixture(t);
  const write = createRotatingLog(file, { maxBytes: 512 });
  for (let i = 0; i < 100; i++) write(`事件 ${i} ${'网络'.repeat(30)}`);
  assert.deepEqual((await readdir(dir)).sort(), ['host-log.txt', 'host-log.txt.1', 'host-log.txt.2']);
  for (const name of await readdir(dir)) assert.ok((await stat(path.join(dir, name))).size <= 512);
  assert.match(await readFile(file, 'utf8'), /事件 99/);
  assert.match(await readFile(file, 'utf8'), /^\d{4}-\d\d-\d\dT/);
  // A fresh writer observes the existing file size instead of resetting its budget.
  createRotatingLog(file, { maxBytes: 512 })('末尾'.repeat(1000));
  assert.ok((await stat(file)).size <= 512);
  assert.match(await readFile(file, 'utf8'), /truncated/);
});

test('迁移超大旧日志保留最近完整记录，并控制备份大小', async t => {
  const { file } = await fixture(t);
  await writeFile(file, `${'old entry\n'.repeat(1000)}important recent error\n`);
  createRotatingLog(file, { maxBytes: 512 })('new session');
  assert.ok((await stat(`${file}.1`)).size <= 512);
  assert.match(await readFile(`${file}.1`, 'utf8'), /important recent error/);
  assert.match(await readFile(file, 'utf8'), /new session/);
});

test('日志写入失败不影响调用者，只报告一次；恢复后继续记录', async t => {
  const { file } = await fixture(t);
  await mkdir(file);
  const errors = [];
  const write = createRotatingLog(file, { onError: error => errors.push(error) });
  for (let i = 0; i < 100; i++) assert.doesNotThrow(() => write('error'));
  assert.equal(errors.length, 1);
  assert.doesNotThrow(() => createRotatingLog(file, { onError: () => { throw new Error('stderr unavailable'); } })('failed'));
  await rm(file, { recursive: true });
  write('recovered');
  assert.match(await readFile(file, 'utf8'), /recovered/);
});

test('Windows 启动诊断不再持有运行日志句柄，避免阻止重命名轮转', () => {
  const plan = buildHostInstallPlan({ platform: 'win32', nodePath: 'C:\\app\\node.exe',
    hostScript: 'C:\\app\\host.mjs', stateDir: 'C:\\state', binary: 'C:\\app\\mihomo.exe' });
  const script = plan.files[0].content;
  assert.ok(script.includes(`> "${plan.startupLog}" 2>&1`));
  assert.ok(!script.includes(plan.hostLog));
  assert.ok(!script.includes('>>'));
});
