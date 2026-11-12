import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { windowsSystemExecutable } from './windows-timezone.mjs';

// Shared by the launcher and guard: failure to enumerate is not an empty installation.
export async function windowsClaudeTargets({ env = process.env, home = homedir(), exec = promisify(execFile), exists = access, list = readdir } = {}) {
  const script = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $ErrorActionPreference = 'Stop'; $p = @(Get-AppxPackage -Name Claude); ConvertTo-Json -Compress -InputObject @($p | ForEach-Object { @{ package = $_.PackageFamilyName; exe = (Join-Path $_.InstallLocation 'app/Claude.exe') } })`;
  let rows;
  try {
    const { stdout } = await exec(windowsSystemExecutable('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 45000, maxBuffer: 65536 });
    const parsed = JSON.parse(stdout.trim());
    rows = Array.isArray(parsed) ? parsed : [parsed];
    if (rows.some(row => !row || typeof row !== 'object' || !('package' in row) || !('exe' in row))) throw new Error('无效的安装信息');
  } catch (error) { throw new Error(`无法识别 Claude 安装信息，请重试：${error.message}`, { cause: error }); }
  const packages = rows.map(row => row.package).filter(value => typeof value === 'string' && value);
  const programs = rows.map(row => row.exe).filter(value => typeof value === 'string' && value);
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const candidates = [env.CHECKCC_DESKTOP_PATH, path.join(local, 'AnthropicClaude', 'Claude.exe'), path.join(local, 'Programs', 'Claude', 'Claude.exe')].filter(Boolean);
  // Squirrel installers keep each release in app-<version>; retain all installed
  // versions as guard targets, including the previous version during an update.
  const squirrel = path.join(local, 'AnthropicClaude');
  let entries = [];
  try { entries = await list(squirrel, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const versions = entries.filter(entry => entry.isDirectory() && /^app-\d[\w.-]*$/.test(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true }));
  candidates.push(...versions.map(entry => path.join(squirrel, entry.name, 'Claude.exe')));
  for (const candidate of candidates) {
    try { await exists(candidate); programs.push(candidate); }
    catch (error) { if (candidate === env.CHECKCC_DESKTOP_PATH || error.code !== 'ENOENT') throw error; }
  }
  return { packages: [...new Set(packages)], programs: [...new Set(programs)] };
}
