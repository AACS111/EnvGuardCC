import path from 'node:path';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function tauriCli() {
  const require = createRequire(import.meta.url);
  try { return path.join(path.dirname(require.resolve('@tauri-apps/cli/package.json')), 'tauri.js'); }
  catch {
    // Optional repository-local tool installation; normal installs use the locked dependency.
    const isolated = path.join(projectRoot, 'node_modules/.tauri-tools/cli/node_modules/@tauri-apps/cli/tauri.js');
    if (existsSync(isolated)) return isolated;
    throw new Error('请先执行 pnpm install 安装 Tauri CLI。');
  }
}
export function buildEnvironment(extra = {}) {
  const tools = path.join(projectRoot, 'node_modules/.tauri-tools');
  const cargoHome = path.join(tools, 'cargo');
  const localCargo = path.join(cargoHome, 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
  const env = { ...process.env, ...extra };
  if (existsSync(localCargo) && !env.CARGO_HOME && !env.RUSTUP_HOME) {
    env.CARGO_HOME = cargoHome; env.RUSTUP_HOME = path.join(tools, 'rustup');
    const key = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
    env[key] = path.join(cargoHome, 'bin') + path.delimiter + (env[key] || '');
  }
  return env;
}
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, env: buildEnvironment(), windowsHide: true, stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`构建失败：${command} (${signal || code})`)));
  });
}
