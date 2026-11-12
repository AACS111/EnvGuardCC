import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { windowsSystemExecutable } from '../windows-timezone.mjs';
import { CLAUDE_GUARD_GROUP_PREFIX, defaultHostsPath, hostsBlocked, stripHostsBlock } from './claude-guard.mjs';

// Call only after stopping the host. Do not depend on a potentially missing state/token.
export async function cleanupClaudeGuard({ stateDir, hostsPath = defaultHostsPath(), run = promisify(execFile), read = readFile, write = writeFile, remove = rm } = {}) {
  const query = `@(Get-NetFirewallRule -PolicyStore PersistentStore -ErrorAction Stop | Where-Object { $_.Group -like '${CLAUDE_GUARD_GROUP_PREFIX}-*' })`;
  const script = `$ErrorActionPreference = 'Stop'; $task = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq 'EnvGuardCC-KernelHost' }); if (@($task | Where-Object { $_.State -eq 'Running' }).Count) { throw '宿主仍在运行，拒绝清理阻断规则，请重试卸载。' }; ${query} | Remove-NetFirewallRule -ErrorAction Stop; ConvertTo-Json -Compress -InputObject @{ count = ${query}.Count }`;
  const { stdout } = await run(windowsSystemExecutable('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 45000 });
  if (JSON.parse(stdout).count !== 0) throw new Error('Claude 防火墙规则清理未完成，请重试卸载。');
  if (hostsPath) {
    const original = await read(hostsPath, 'utf8');
    if (hostsBlocked(original)) await write(hostsPath, stripHostsBlock(original), 'utf8');
    if (hostsBlocked(await read(hostsPath, 'utf8'))) throw new Error('Claude hosts 阻断清理未完成，请重试卸载。');
  }
  // Prevent a future reinstall from restoring a stale armed intent.
  if (stateDir) await remove(path.join(stateDir, 'claude-guard.json'), { force: true });
}

export async function uninstallHost(plan, { platform = process.platform, run, cleanup, releaseMac } = {}) {
  for (const [index, step] of plan.uninstallCommands.entries()) {
    if (index === 0 && platform === 'darwin') await releaseMac();
    try { await run(step.cmd, step.args); }
    catch (error) { if (!step.optional) throw error; }
    // Windows task stop precedes cleanup; failure keeps the task definition for retry.
    if (index === 0 && platform === 'win32') await cleanup();
  }
}
