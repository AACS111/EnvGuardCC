import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('独立发行版目前仅支持 Windows x64。');
const source = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(source, '../..');
const output = path.join(project, 'node_modules/.checkcc-dist');
await mkdir(output, { recursive: true });
const destination = await mkdtemp(path.join(output, 'EnvGuardCC-License-Generator-'));
await mkdir(path.join(destination, 'tools/license-generator'), { recursive: true });
await mkdir(path.join(destination, 'scripts'), { recursive: true });
await mkdir(path.join(destination, 'runtime'), { recursive: true });
// Explicit allowlist: do not copy the issuer directory or any production signing material.
for (const file of ['server.mjs', 'issuer.mjs', 'index.html', 'style.css', 'app.js']) {
  await cp(path.join(source, file), path.join(destination, 'tools/license-generator', file));
}
await cp(path.join(project, 'scripts/license-verifier.mjs'), path.join(destination, 'scripts/license-verifier.mjs'));
await cp(path.join(project, 'docs/offline-license.md'), path.join(destination, '使用说明.md'));
await cp(process.execPath, path.join(destination, 'runtime/node.exe'));
// Node's distributable includes its required license in the root of common Windows installations.
await cp(path.join(path.dirname(process.execPath), 'LICENSE'), path.join(destination, 'runtime/Node-LICENSE'));
await writeFile(path.join(destination, '启动授权码生成器.cmd'), '@echo off\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\node.exe" "%~dp0tools\\license-generator\\server.mjs" --open\r\nif errorlevel 1 pause\r\n');
await writeFile(path.join(destination, 'README.txt'), '双击“启动授权码生成器.cmd”。已内置 Node.js，不需安装依赖或连接授权服务器。\r\n首次启动会创建本发行目录内的 .checkcc-license-issuer 私钥目录，请只在签发者电脑使用并备份密钥，不要将该目录交给用户。\r\n本工具只负责签发，主应用尚未接入强制激活和当前 Claude 账号识别。详细边界见“使用说明.md”。\r\n', 'utf8');
const archive = `${destination}.zip`;
await new Promise((resolve, reject) => {
  const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference = "Stop"; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:CHECKCC_GENERATOR_SOURCE, $env:CHECKCC_GENERATOR_ZIP, [IO.Compression.CompressionLevel]::Optimal, $true)'], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, CHECKCC_GENERATOR_SOURCE: destination, CHECKCC_GENERATOR_ZIP: archive },
  });
  let error = ''; child.stderr.on('data', bytes => { error = (error + bytes).slice(-1000); });
  child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`生成器压缩失败：${error}`)));
});
console.log(`独立授权码生成器：${destination}`);
console.log(`发行压缩包：${archive}`);
