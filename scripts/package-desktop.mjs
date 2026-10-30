import { spawn } from 'node:child_process';
import { mkdir, cp, symlink, lstat, unlink, rm, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildName = '.checkcc-desktop-build-source';
const buildRoot = path.resolve(root, buildName);
if (path.dirname(buildRoot) !== root || path.basename(buildRoot) !== buildName) throw new Error('Invalid build directory');
try { await lstat(buildRoot); await readFile(path.join(buildRoot, '.checkcc-build-owned')); }
catch (error) { if (error.code !== 'ENOENT') throw error; if (error.path && error.path !== buildRoot) throw new Error('Refusing to replace an unmarked build directory'); }
const link = path.join(buildRoot, 'node_modules');
try { const info = await lstat(link); if (!info.isSymbolicLink()) throw new Error('Unexpected physical node_modules in build directory'); await unlink(link); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await rm(buildRoot, { recursive: true, force: true });
await mkdir(buildRoot, { recursive: true });
await writeFile(path.join(buildRoot, '.checkcc-build-owned'), root);
for (const name of ['src', 'public', 'package.json', 'tsconfig.json', 'next-env.d.ts', 'next.config.ts', 'postcss.config.mjs']) {
  try { await cp(path.join(root, name), path.join(buildRoot, name), { recursive: true }); }
  catch (error) { if (error.code !== 'ENOENT' || !['public', 'next-env.d.ts'].includes(name)) throw error; }
}
await symlink(path.join(root, 'node_modules'), link, 'junction');
const run = (args, env, cwd = root) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd, env, windowsHide: true, stdio: 'inherit' });
  child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Build failed: ${code}`)));
});
const exportRoot = path.join(buildRoot, 'export');
// With output:export, Next treats custom distDir as the export destination.
// An isolated source copy keeps the dev server's .next untouched.
try {
await run([path.join(root, 'node_modules/next/dist/bin/next'), 'build', buildRoot, '--webpack'], { ...process.env, CHECKCC_BUILD_DIR: 'export' }, buildRoot);
// Verify the exported CSS itself, not just JSX class names in JavaScript chunks.
const exportedHtml = await readFile(path.join(exportRoot, 'index.html'), 'utf8');
const cssAssets = [...exportedHtml.matchAll(/<link[^>]*href="([^" ]+\.css(?:\?[^" ]*)?)"[^>]*>/g)].map(match => match[1].split('?')[0]);
const exportedCss = (await Promise.all(cssAssets.map(asset => readFile(path.join(exportRoot, asset), 'utf8')))).join('\n');
for (const selector of ['.check-workspace', '.workspace-sidebar', '.workspace-content', '.signal-card__values', '.workspace-meter__track']) {
  if (!exportedCss.includes(selector)) throw new Error('工作台样式未进入构建产物，已拒绝打包：' + selector);
}
const sources = {};
for (const file of ['src/app/globals.css', 'src/components/detector/workspace.css', 'src/detection/local-helper.ts', 'src/components/detector/Detector.tsx', 'src/components/detector/ProtectionWorkspace.tsx', 'src/components/detector/RepairDialog.tsx']) sources[file] = createHash('sha256').update(await readFile(path.join(buildRoot, file))).digest('hex');
await writeFile(path.join(exportRoot, 'checkcc-build.json'), JSON.stringify({ builtAt: new Date().toISOString(), sources }, null, 2));
await run([path.join(root, 'scripts/build-desktop.mjs')], { ...process.env, CHECKCC_EXPORT_DIR: exportRoot });
} finally {
  await unlink(link);
  await rm(buildRoot, { recursive: true, force: true });
}
