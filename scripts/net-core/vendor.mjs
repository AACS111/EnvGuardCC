// 内核二进制的获取与校验。
// 原则：清单里没有 sha256 就拒绝安装。绝不允许"先下载再信任"——那等于把供应链交给网络。
// 首次固定校验值时使用 pinKernel()，它会下载并写回清单，产物需要人工评审后提交。

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function platformKey({ platform = process.platform, arch = process.arch } = {}) {
  if (platform === "win32") return arch === "arm64" ? "win32-arm64" : "win32-x64";
  if (platform === "darwin") return arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (platform === "linux") return arch === "arm64" ? "linux-arm64" : "linux-x64";
  return `${platform}-${arch}`;
}

export async function loadManifest(file) {
  const raw = JSON.parse(await readFile(file, "utf8"));
  if (!raw?.version || !raw?.platforms) throw new Error("内核清单缺少 version 或 platforms。");
  if (!/^v\d+\.\d+\.\d+$/.test(raw.version)) throw new Error(`内核版本格式无效：${raw.version}`);
  return raw;
}

export function assetFor(manifest, key) {
  const asset = manifest.platforms[key];
  if (!asset) throw new Error(`内核清单没有当前平台 ${key} 的产物。`);
  if (typeof asset.url !== "string" || !/^https:\/\//.test(asset.url)) throw new Error("内核产物地址必须是 HTTPS。");
  return asset;
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function verifySha256(buffer, expected) {
  if (!expected) throw new Error("内核清单未固定 sha256，拒绝安装。请先运行 pinKernel 并在评审后提交清单。");
  if (!/^[a-f0-9]{64}$/i.test(expected)) throw new Error("清单中的 sha256 格式无效。");
  const actual = sha256(buffer);
  if (actual !== expected.toLowerCase()) throw new Error(`内核校验失败：期望 ${expected}，实际 ${actual}。`);
  return actual;
}

async function atomicWrite(file, content, mode = 0o644) {
  const temporary = `${file}.${process.pid}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(temporary, content, { mode });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** 解压发布产物得到真正要执行的文件。清单没有 archive 字段时视为未压缩裸文件（测试用）。 */
export async function extractBinary(buffer, asset) {
  if (!asset.archive) return buffer;
  if (asset.archive.endsWith('.gz')) {
    const { gunzipSync } = await import('node:zlib');
    return gunzipSync(buffer);
  }
  if (asset.archive.endsWith('.zip')) {
    const { mkdtemp, readdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const directory = await mkdtemp(path.join(tmpdir(), 'checkcc-kernel-'));
    try {
      const archive = path.join(directory, 'archive.zip');
      await writeFile(archive, buffer);
      // bsdtar（Windows 10+ 与 macOS 自带）可解 zip，避免引入额外依赖。
      // 用相对路径并在 cwd 内解压：Windows 上 tar 会把 'C:' 误判为远程主机。
      // tar 的实现因环境而异（GNU tar 不支持 zip），按能力依次回退。
      await extractZip(directory);
      const entries = await readdir(directory);
      const binary = entries.find((name) => name !== 'archive.zip' && !name.endsWith('.txt') && !name.endsWith('.md'));
      if (!binary) throw new Error('内核压缩包中没有可执行文件。');
      return await readFile(path.join(directory, binary));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  throw new Error(`不支持的产物格式：${asset.archive}`);
}

async function extractZip(directory) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const attempts = [
    async () => run('tar', ['-xf', 'archive.zip'], { cwd: directory, windowsHide: true }),
    async () => run('unzip', ['-o', 'archive.zip'], { cwd: directory, windowsHide: true }),
  ];
  if (process.platform === 'win32') {
    attempts.push(async () => run('powershell', ['-NoProfile', '-Command', "Expand-Archive -LiteralPath 'archive.zip' -DestinationPath '.' -Force"], { cwd: directory, windowsHide: true }));
  }
  let lastError = null;
  for (const attempt of attempts) {
    try { await attempt(); return; } catch (error) { lastError = error; }
  }
  throw new Error(`无法解压内核压缩包：${lastError?.message ?? "没有可用解压工具"}`);
}

/** 下载、解压并校验内核产物。download 可注入，便于测试。 */
export async function vendorKernel({ manifestPath, key = platformKey(), outputDir, download = defaultDownload } = {}) {
  if (!manifestPath) throw new Error('缺少内核清单路径。');
  const manifest = await loadManifest(manifestPath);
  const asset = assetFor(manifest, key);
  const binary = await extractBinary(await download(asset.url), asset);
  const digest = verifySha256(binary, asset.sha256);
  const target = path.join(outputDir ?? path.dirname(manifestPath), asset.file);
  // 内核可执行文件在 macOS/Linux 上必须带执行位。
  await atomicWrite(target, binary, 0o755);
  return { version: manifest.version, file: target, bytes: binary.length, sha256: digest };
}

/** 首次固定：下载解压后把可执行文件的 sha256 写回清单。只更新目标平台条目。 */
export async function pinKernel({ manifestPath, key = platformKey(), download = defaultDownload } = {}) {
  const manifest = await loadManifest(manifestPath);
  const asset = assetFor(manifest, key);
  const binary = await extractBinary(await download(asset.url), asset);
  const digest = sha256(binary);
  const next = { ...manifest, platforms: { ...manifest.platforms, [key]: { ...asset, sha256: digest, size: binary.length } } };
  await atomicWrite(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
  return { key, sha256: digest, size: binary.length };
}

export async function defaultDownload(url, { attempts = 3, timeoutMs = 120000 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  throw new Error(`下载内核失败（已重试 ${attempts} 次）：${lastError?.message ?? "未知错误"}`);
}

// 命令行入口：
//   node scripts/net-core/vendor.mjs --pin --key win32-x64   # 首次固定并写回清单
//   node scripts/net-core/vendor.mjs --key win32-x64          # 按清单校验下载到 output
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[index + 1] : fallback;
  };
  const manifestPath = flag("manifest", path.resolve(path.dirname(fileURLToPath(import.meta.url)), "kernel-manifest.json"));
  const key = flag("key", platformKey());
  const outputDir = flag("out", path.resolve("node_modules", ".checkcc-kernel"));
  try {
    const result = argv.includes("--pin")
      ? await pinKernel({ manifestPath, key })
      : await vendorKernel({ manifestPath, key, outputDir });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`[net-core] ${error.message}\n`);
    process.exitCode = 1;
  }
}
