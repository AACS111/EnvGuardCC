import path from 'node:path';
import { existsSync } from 'node:fs';

export function resolveNpmCli({ execPath = process.execPath, npmExecPath = process.env.npm_execpath, env = process.env, exists = existsSync } = {}) {
  const nodeDir = path.dirname(execPath);
  const candidates = [];
  if (npmExecPath && /^npm(?:-cli)?(?:\.[cm]?js)?$/i.test(path.basename(npmExecPath))) candidates.push(npmExecPath);
  candidates.push(path.join(nodeDir, 'node_modules/npm/bin/npm-cli.js'), path.join(nodeDir, '../lib/node_modules/npm/bin/npm-cli.js'), path.join(nodeDir, '../libexec/lib/node_modules/npm/bin/npm-cli.js'));
  if (env.HOMEBREW_PREFIX) candidates.push(path.join(env.HOMEBREW_PREFIX, 'lib/node_modules/npm/bin/npm-cli.js'));
  let directory = nodeDir;
  for (let depth = 0; depth < 6; depth++) {
    candidates.push(path.join(directory, 'lib/node_modules/npm/bin/npm-cli.js'));
    const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
  }
  candidates.push(path.join(nodeDir, 'npm'));
  const found = candidates.find(candidate => candidate && exists(candidate));
  if (!found) throw new Error('未找到 npm，请安装 npm 后重试。');
  return found;
}
