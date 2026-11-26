import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectMobileEnvironment, parseArgs, tauriConfigForPlatform } from './build-mobile.mjs';
import { createUpdateChecker } from './app-updates.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('移动端 Tauri 配置使用静态导出且不包含桌面 Node 后台资源', async () => {
  for (const [platform, file] of [
    ['android', 'src-tauri/tauri.android.conf.json'],
    ['ios', 'src-tauri/tauri.ios.conf.json'],
  ]) {
    assert.equal(tauriConfigForPlatform(platform), file);
    const config = JSON.parse(await readFile(path.join(root, file), 'utf8'));
    assert.equal(config.build.frontendDist, '../out');
    assert.deepEqual(config.bundle.resources, {});
    assert.equal(config.app.windows[0].label, 'main');
  }
});

test('Cargo.toml 为移动端导出 lib 目标并将桌面独占插件限制在非移动平台', async () => {
  const cargo = await readFile(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
  assert.match(cargo, /\[lib\]/);
  assert.match(cargo, /crate-type = \["staticlib", "cdylib", "rlib"\]/);
  assert.match(cargo, /\[target\.'cfg\(not\(any\(target_os = "android", target_os = "ios"\)\)\)'\.dependencies\]/);
  assert.match(cargo, /tauri-plugin-single-instance/);
  assert.match(cargo, /tauri-plugin-autostart/);
});

test('移动端核心库、Android VPN 与 iOS Network Extension 源码齐全且无硬编码私有凭证', async () => {
  const expectedFiles = [
    'mobile/core/go.mod',
    'mobile/core/core.go',
    'mobile/core/config.go',
    'mobile/core/subscription.go',
    'mobile/core/http_api.go',
    'mobile/core/diagnostics.go',
    'mobile/core/memory.go',
    'mobile/core/mihomo_embed.go',
    'mobile/core/mihomo_stub.go',
    'mobile/core/core_test.go',
    'mobile/android/EnvGuardVpnService.kt',
    'mobile/android/EnvGuardMobileBridge.kt',
    'mobile/android/AndroidManifest.overlay.xml',
    'mobile/ios/PacketTunnelProvider.swift',
    'mobile/ios/VpnManager.swift',
    'mobile/ios/Entitlements.template.plist',
    'mobile/ios/Extension.Entitlements.template.plist',
    'docs/TAURI-MOBILE.md',
  ];
  for (const rel of expectedFiles) {
    await access(path.join(root, rel));
  }
  const iosEntitlement = await readFile(path.join(root, 'mobile/ios/Entitlements.template.plist'), 'utf8');
  assert.match(iosEntitlement, /\$\(APP_GROUP_ID\)/);
  assert.doesNotMatch(iosEntitlement, /TEAM_ID_[A-Z0-9]{10}/);
});

test('build-mobile 参数解析与环境检测正常工作', () => {
  assert.deepEqual(parseArgs(['--platform=android', '--mode=build', '--debug']), {
    platform: 'android',
    mode: 'build',
    release: false,
  });
  assert.throws(() => parseArgs(['--platform=symbian']), /不支持的移动平台/);
  assert.throws(() => parseArgs(['--mode=invalid']), /不支持的构建模式/);
  const iosOnWin = inspectMobileEnvironment('ios', {}, 'win32');
  assert.equal(iosOnWin.ready, false);
  assert.ok(iosOnWin.missing.includes('macos-host'));
});

test('更新检查支持 Android APK 与 iOS IPA 发布资产', async () => {
  const repository = 'community/EnvGuardCC';
  const makeAsset = name => ({
    name,
    state: 'uploaded',
    size: 4096,
    browser_download_url: `https://github.com/${repository}/releases/download/v0.3.0/${name}`,
  });
  const release = {
    tag_name: 'v0.3.0',
    draft: false,
    prerelease: false,
    body: 'Mobile release',
    assets: [
      makeAsset('EnvGuardCC-0.3.0-android-arm64.apk'),
      makeAsset('EnvGuardCC-0.3.0-ios.ipa'),
    ],
  };
  const android = await createUpdateChecker({
    currentVersion: '0.2.6',
    repository,
    platform: 'android',
    arch: 'arm64',
    loadRelease: async () => release,
  }).check();
  assert.equal(android.status, 'available');
  assert.equal(android.assetName, 'EnvGuardCC-0.3.0-android-arm64.apk');

  const ios = await createUpdateChecker({
    currentVersion: '0.2.6',
    repository,
    platform: 'ios',
    arch: 'arm64',
    loadRelease: async () => release,
  }).check();
  assert.equal(ios.status, 'available');
  assert.equal(ios.assetName, 'EnvGuardCC-0.3.0-ios.ipa');
});
