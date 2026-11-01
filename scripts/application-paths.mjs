import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);

export async function resolveApplicationExecutable(candidate) {
  if (!/\.app\/?$/i.test(candidate)) {
    await access(candidate);
    return candidate;
  }
  const bundle = candidate.replace(/\/$/, '');
  const { stdout } = await exec('/usr/bin/plutil', [
    '-extract', 'CFBundleExecutable', 'raw', '-o', '-', path.join(bundle, 'Contents', 'Info.plist'),
  ], { timeout: 5000, maxBuffer: 4096 });
  const name = stdout.trim();
  if (!name) throw new Error(`应用包缺少可执行文件名称：${bundle}`);
  const executable = path.join(bundle, 'Contents', 'MacOS', name);
  await access(executable);
  return executable;
}

export function applicationResources(executable) {
  const directory = path.dirname(executable);
  if (path.basename(directory) === 'MacOS' && path.basename(path.dirname(directory)) === 'Contents') {
    return path.join(path.dirname(directory), 'Resources');
  }
  return path.join(directory, 'resources');
}

export async function findBrowser({ platform = process.platform, env = process.env, home = homedir(), applicationDirectories = ['/Applications', path.join(home, 'Applications')] } = {}) {
  const installed = platform === 'darwin'
    ? applicationDirectories.flatMap(directory => ['Google Chrome.app', 'Microsoft Edge.app'].map(name => path.join(directory, name)))
    : [path.join(env.ProgramFiles ?? 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'), path.join(env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe')];
  for (const candidate of [env.CHECKCC_BROWSER_PATH, ...installed].filter(Boolean)) {
    try { return await resolveApplicationExecutable(candidate); }
    catch { /* Try the next installed browser, as on Windows. */ }
  }
  throw new Error('未找到 Chrome/Edge，无法启动隔离浏览器。可通过 CHECKCC_BROWSER_PATH 指定应用或可执行文件。');
}

export async function findDesktop({ platform = process.platform, env = process.env, home = homedir(), applicationDirectories = ['/Applications', path.join(home, 'Applications')] } = {}) {
  if (platform !== 'win32' && platform !== 'darwin') throw new Error('桌面客户端自动接入目前仅支持 Windows 和 macOS。');
  if (env.CHECKCC_DESKTOP_PATH) return resolveApplicationExecutable(env.CHECKCC_DESKTOP_PATH);
  if (platform === 'darwin') {
    for (const directory of applicationDirectories) {
      const candidate = path.join(directory, 'Claude.app');
      try { await access(candidate); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      return resolveApplicationExecutable(candidate);
    }
    throw new Error('未找到 Claude 桌面应用包。可通过 CHECKCC_DESKTOP_PATH 指定应用或可执行文件。');
  }
  const result = await exec('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', "$p = Get-AppxPackage -Name Claude | Select-Object -First 1; if ($p) { Join-Path $p.InstallLocation 'app/Claude.exe' }"], { windowsHide: true, timeout: 5000, maxBuffer: 4096 });
  const candidate = result.stdout.trim();
  if (!candidate) throw new Error('未找到 Claude 桌面应用包。');
  await access(candidate);
  return candidate;
}
