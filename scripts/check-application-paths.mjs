import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applicationResources, findBrowser, findDesktop, resolveApplicationExecutable } from './application-paths.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'envguardcc-app-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function bundle(directory, name, executableName) {
  const application = path.join(directory, name);
  const executable = path.join(application, 'Contents', 'MacOS', executableName);
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(path.join(application, 'Contents', 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>${executableName}</string></dict></plist>`);
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { application, executable };
}

test('Mac 应用按 Info.plist 定位实际程序，支持空格中文及正确资源目录', { skip: process.platform !== 'darwin' }, async t => {
  const root = await fixture(t);
  const app = await bundle(root, '自定义 Claude.app', '真实程序 名称');
  assert.equal(await resolveApplicationExecutable(app.application), app.executable);
  assert.equal(await findDesktop({ platform: 'darwin', env: { CHECKCC_DESKTOP_PATH: app.application } }), app.executable);
  assert.equal(await findBrowser({ platform: 'darwin', env: { CHECKCC_BROWSER_PATH: app.application } }), app.executable);
  assert.equal(applicationResources(app.executable), path.join(app.application, 'Contents', 'Resources'));
});

test('Mac 自动查找覆盖系统和用户应用目录，并可找到用户目录中的 Edge 和 Claude', { skip: process.platform !== 'darwin' }, async t => {
  const root = await fixture(t);
  const directories = [path.join(root, '系统 应用'), path.join(root, '用户 应用')];
  const chrome = await bundle(directories[0], 'Google Chrome.app', 'Google Chrome');
  const edge = await bundle(directories[1], 'Microsoft Edge.app', 'Microsoft Edge');
  const claude = await bundle(directories[1], 'Claude.app', 'Claude');
  const options = { platform: 'darwin', env: {}, applicationDirectories: directories };
  assert.equal(await findBrowser(options), chrome.executable);
  await rm(chrome.application, { recursive: true });
  assert.equal(await findBrowser(options), edge.executable);
  assert.equal(await findDesktop(options), claude.executable);
});

test('自定义可执行文件保持优先，Windows 资源路径不受 Mac 适配影响', async t => {
  const root = await fixture(t);
  const executable = path.join(root, 'Claude 自定义.exe');
  await writeFile(executable, 'fixture');
  assert.equal(await findDesktop({ platform: 'win32', env: { CHECKCC_DESKTOP_PATH: executable } }), executable);
  assert.equal(await findBrowser({ platform: 'win32', env: { CHECKCC_BROWSER_PATH: executable } }), executable);
  assert.equal(applicationResources(executable), path.join(root, 'resources'));
  await assert.rejects(findDesktop({ platform: 'darwin', env: { CHECKCC_DESKTOP_PATH: path.join(root, 'missing') } }), { code: 'ENOENT' });
});
