import { lstat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const bundle = 'com.anthropic.claudefordesktop';

// Only fixed Desktop app-data locations; never accept paths from the renderer.
export async function claudeDataPaths({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  if (platform === 'darwin') return [
    'Library/Application Support/Claude', 'Library/Caches/Claude',
    `Library/Caches/${bundle}`, 'Library/Logs/Claude',
    `Library/Preferences/${bundle}.plist`, `Library/Saved Application State/${bundle}.savedState`,
    `Library/WebKit/${bundle}`, `Library/HTTPStorages/${bundle}`,
    `Library/HTTPStorages/${bundle}.binarycookies`,
  ].map(name => path.join(home, name));
  if (platform !== 'win32') throw new Error('Claude 恢复初始化仅支持 Windows 和 macOS。');
  const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const targets = [path.join(roaming, 'Claude')];
  // MSIX package names are discovered, but only the exact Claude publisher family is accepted.
  for (const base of [path.join(local, 'Packages'), path.join(local, 'Claude-Data')]) {
    let entries;
    try { entries = await readdir(base, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      if (entry.name.toLowerCase() !== 'claude_pzs8sxrjxfjjc') continue;
      if (base.endsWith('Packages')) {
        for (const relative of ['LocalCache/Roaming/Claude', 'LocalCache/Local/Claude', 'LocalState', 'RoamingState', 'TempState', 'Settings']) targets.push(path.join(base, entry.name, relative));
      } else targets.push(path.join(base, entry.name));
    }
  }
  return [...new Set(targets)];
}

async function inspectPath(target, home) {
  const relative = path.relative(home, target);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('数据目录不在当前用户目录内，已停止重置。');
  // Refuse symlink/junction ancestors too: do not touch a redirected directory.
  let current = home;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('数据路径包含符号链接或目录联接，已停止重置：' + current);
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  return true;
}

export async function isClaudeRunning({ platform = process.platform, run = exec } = {}) {
  if (platform === 'darwin') {
    const { stdout } = await run('/bin/ps', ['-axo', 'comm='], { timeout: 5000, maxBuffer: 1024 * 1024 });
    return stdout.split('\n').some(line => /\/Claude\.app\/Contents\//.test(line) || /^Claude(?: Helper.*)?$/.test(line.trim()));
  }
  if (platform === 'win32') {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "@(Get-Process -Name 'Claude','Claude Helper*' -ErrorAction SilentlyContinue).Count"], { windowsHide: true, timeout: 10000, maxBuffer: 4096 });
    if (!/^\d+$/.test(stdout.trim())) throw new Error('无法确认 Claude 是否已退出。');
    return Number(stdout.trim()) > 0;
  }
  throw new Error('不支持当前系统。');
}

export function createClaudeReset({ platform = process.platform, home = homedir(), env = process.env, running = () => isClaudeRunning({ platform }), trash } = {}) {
  let pending = false;
  const preview = async () => {
    const candidates = await claudeDataPaths({ platform, home, env });
    const paths = [];
    for (const candidate of candidates) if (await inspectPath(candidate, home)) paths.push(candidate);
    return { paths, running: await running(), platform };
  };
  return {
    preview,
    async reset(expectedPaths) {
      if (pending) throw new Error('正在恢复初始化，请勿重复操作。');
      pending = true;
      const cleared = [];
      try {
        const plan = await preview();
        if (plan.running) throw new Error('请先退出 Claude 及其后台任务，再恢复初始化。');
        if (!Array.isArray(expectedPaths) || JSON.stringify(plan.paths) !== JSON.stringify(expectedPaths)) throw new Error('待清理数据已变化，请重新预览并确认。');
        if (typeof trash !== 'function') throw new Error('系统废纸篓服务不可用，未清理任何数据。');
        for (const target of plan.paths) {
          if (await running()) throw new Error('检测到 Claude 再次启动，已停止后续清理。');
          if (!await inspectPath(target, home)) continue;
          await trash(target);
          cleared.push(target);
        }
        const remaining = await preview();
        if (remaining.running || remaining.paths.length) throw new Error('Claude 数据被重新创建，请退出客户端后重试。');
        return { cleared, complete: true };
      } catch (error) {
        // Report partial completion; never claim all data was cleared after a lock/permission error.
        error.cleared = cleared;
        throw error;
      } finally { pending = false; }
    },
  };
}
