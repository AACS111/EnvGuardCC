import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
export async function validateReleaseSource({ directory, tag, sha = 'HEAD' }) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  if (tag !== `v${manifest.version}` || !/^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(tag)) throw new Error('发布标签必须与 package.json 版本一致。');
  const git = args => exec('git', args, { cwd: directory, timeout: 10000 });
  // Both refs must exist. A missing main ref must fail closed, not skip the check.
  await git(['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}']);
  const commit = (await git(['rev-parse', '--verify', `${sha}^{commit}`])).stdout.trim();
  try { await git(['merge-base', '--is-ancestor', commit, 'refs/remotes/origin/main']); }
  catch { throw new Error('发布提交尚未合并到 main，拒绝发布。请先完成 develop → main 的测试确认与合并。'); }
  await access(path.join(directory, 'docs', 'releases', `${tag}.md`));
  return commit;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await validateReleaseSource({ directory: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), tag: process.env.RELEASE_TAG, sha: process.env.GITHUB_SHA || 'HEAD' });
  console.log('发布提交已合入 main，标签版本和发布说明校验通过。');
}
