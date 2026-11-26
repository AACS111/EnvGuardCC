// EnvGuardCC Android & iOS 移动端构建与环境核验脚本。
// 用法：
//   node scripts/build-mobile.mjs --platform=android --mode=check
//   node scripts/build-mobile.mjs --platform=android --mode=core
//   node scripts/build-mobile.mjs --platform=android --mode=init
//   node scripts/build-mobile.mjs --platform=android --mode=build
//   node scripts/build-mobile.mjs --platform=ios --mode=build
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseArgs(argv = process.argv.slice(2)) {
  const options = { platform: 'android', mode: 'check', release: true };
  for (const arg of argv) {
    if (arg.startsWith('--platform=')) options.platform = arg.slice('--platform='.length).toLowerCase();
    else if (arg.startsWith('--mode=')) options.mode = arg.slice('--mode='.length).toLowerCase();
    else if (arg === '--debug') options.release = false;
    else if (arg === '--release') options.release = true;
  }
  if (!['android', 'ios'].includes(options.platform)) {
    throw new Error(`不支持的移动平台：${options.platform}（仅支持 android 或 ios）。`);
  }
  if (!['check', 'core', 'init', 'build'].includes(options.mode)) {
    throw new Error(`不支持的构建模式：${options.mode}（仅支持 check / core / init / build）。`);
  }
  return options;
}

export function tauriConfigForPlatform(platform) {
  return platform === 'ios' ? 'src-tauri/tauri.ios.conf.json' : 'src-tauri/tauri.android.conf.json';
}

function commandExists(cmd, args = ['--version']) {
  if (process.platform === 'win32') {
    const locate = spawnSync('where.exe', [cmd], { stdio: 'ignore', timeout: 2000, windowsHide: true });
    return !locate.error && locate.status === 0;
  }
  const res = spawnSync(cmd, args, {
    stdio: 'ignore',
    timeout: 3000,
    windowsHide: true,
  });
  return !res.error && res.status === 0;
}

export function inspectMobileEnvironment(platform, env = process.env, hostPlatform = process.platform) {
  const checks = [];
  checks.push({ id: 'node', ok: true, detail: process.version });
  checks.push({ id: 'go', ok: commandExists('go', ['version']), detail: 'Go 1.23+ (用于编译 mobile/core 嵌入式 mihomo 库)' });
  checks.push({ id: 'gomobile', ok: commandExists('gomobile', ['version']), detail: 'gomobile (go install golang.org/x/mobile/cmd/gomobile@latest)' });
  checks.push({ id: 'cargo', ok: commandExists('cargo', ['--version']), detail: 'Rust stable toolchain' });

  if (platform === 'android') {
    checks.push({ id: 'java', ok: commandExists('javac', ['-version']), detail: 'JDK 17+' });
    checks.push({ id: 'android-sdk', ok: Boolean(env.ANDROID_HOME || env.ANDROID_SDK_ROOT), detail: 'ANDROID_HOME / ANDROID_SDK_ROOT' });
    checks.push({ id: 'android-ndk', ok: Boolean(env.NDK_HOME || env.ANDROID_NDK_HOME), detail: 'NDK_HOME / ANDROID_NDK_HOME' });
  } else {
    checks.push({ id: 'macos-host', ok: hostPlatform === 'darwin', detail: 'iOS 构建必须在 macOS 主机上进行' });
    checks.push({ id: 'xcode', ok: hostPlatform === 'darwin' && commandExists('xcodebuild', ['-version']), detail: 'Xcode 15+ & iOS SDK' });
  }
  return {
    platform,
    ready: checks.every(item => item.ok),
    checks,
    missing: checks.filter(item => !item.ok).map(item => item.id),
  };
}

function runCommand(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`命令退出码 ${code}: ${cmd} ${args.join(' ')}`)));
  });
}

async function exportFrontend() {
  console.log('[mobile] 导出静态前端到 out/ ...');
  await runCommand(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'build', '--webpack'], {
    cwd: root,
    env: { ...process.env, CHECKCC_BUILD_DIR: '.next' },
  });
  await access(path.join(root, 'out', 'index.html'));
}

async function buildGoCore(platform) {
  const coreDir = path.join(root, 'mobile/core');
  const distDir = path.join(root, 'node_modules/.checkcc-mobile-core');
  await mkdir(distDir, { recursive: true });
  if (platform === 'android') {
    const outAar = path.join(distDir, 'EnvGuardCore.aar');
    console.log('[mobile] 使用 gomobile 编译 Android AAR:', outAar);
    await runCommand('gomobile', [
      'bind', '-target=android/arm64,android/arm', '-androidapi=26',
      '-tags=mihomo_embed', '-ldflags=-s -w',
      '-o', outAar, '.',
    ], { cwd: coreDir });
    const androidLibs = path.join(root, 'src-tauri/gen/android/app/libs');
    await mkdir(androidLibs, { recursive: true });
    await cp(outAar, path.join(androidLibs, 'EnvGuardCore.aar'));
    return outAar;
  }
  const outXc = path.join(distDir, 'EnvGuardCore.xcframework');
  await rm(outXc, { recursive: true, force: true });
  console.log('[mobile] 使用 gomobile 编译 iOS XCFramework:', outXc);
  await runCommand('gomobile', [
    'bind', '-target=ios,iossimulator',
    '-tags=mihomo_embed', '-ldflags=-s -w',
    '-o', outXc, '.',
  ], { cwd: coreDir });
  return outXc;
}

async function syncNativeTemplates(platform) {
  if (platform === 'android') {
    const dest = path.join(root, 'src-tauri/gen/android/app/src/main/java/io/github/aacs111/envguardcc/vpn');
    await mkdir(dest, { recursive: true });
    for (const file of ['EnvGuardVpnService.kt', 'EnvGuardMobileBridge.kt']) {
      await cp(path.join(root, 'mobile/android', file), path.join(dest, file));
    }
    console.log('[mobile] 已同步 Android VPN Kotlin 源码至', dest);
  } else {
    const dest = path.join(root, 'src-tauri/gen/apple/EnvGuardVPN');
    await mkdir(dest, { recursive: true });
    for (const file of ['PacketTunnelProvider.swift', 'VpnManager.swift']) {
      await cp(path.join(root, 'mobile/ios', file), path.join(dest, file));
    }
    console.log('[mobile] 已同步 iOS PacketTunnelProvider Swift 源码至', dest);
  }
}

async function main() {
  const { platform, mode, release } = parseArgs();
  const report = inspectMobileEnvironment(platform);
  if (mode === 'check') {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (!report.ready) {
    console.error(`[mobile] 当前环境缺少 ${platform} 构建依赖：${report.missing.join(', ')}`);
    for (const item of report.checks.filter(c => !c.ok)) {
      console.error(`  - ${item.id}: ${item.detail}`);
    }
    process.exitCode = 1;
    return;
  }

  const tauriBin = path.join(root, 'node_modules/.bin/tauri');
  const configPath = tauriConfigForPlatform(platform);

  if (mode === 'core') {
    await buildGoCore(platform);
    return;
  }
  if (mode === 'init') {
    await exportFrontend();
    await runCommand(tauriBin, [platform, 'init', '--config', configPath], { cwd: root });
    await syncNativeTemplates(platform);
    return;
  }

  // Full build pipeline: export Next.js -> build Go core -> sync native VPN templates -> tauri build
  await exportFrontend();
  await buildGoCore(platform);
  await syncNativeTemplates(platform);

  const buildArgs = [platform, 'build', '--config', configPath];
  if (!release) buildArgs.push('--debug');
  if (platform === 'android') buildArgs.push('--apk', 'true');
  await runCommand(tauriBin, buildArgs, { cwd: root });

  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const summaryPath = path.join(root, 'node_modules/.checkcc-dist', `mobile-build-${platform}.json`);
  await mkdir(path.dirname(summaryPath), { recursive: true });
  await writeFile(summaryPath, JSON.stringify({
    platform,
    version: pkg.version,
    config: configPath,
    builtAt: new Date().toISOString(),
  }, null, 2));
  console.log(`[mobile] ${platform} 构建完成：`, summaryPath);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error('[mobile] 构建失败：', error.message);
    process.exitCode = 1;
  });
}
