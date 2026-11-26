# EnvGuardCC 移动端（Android & iOS）架构与打包指南

EnvGuardCC 移动端复用同一套 Next.js 静态前端与 Tauri 2 宿主框架，但针对 Android / iOS 系统沙盒移除了桌面端内置 Node.js 与独立可执行内核，改为 **嵌入式 Go/mihomo 核心库 + 系统原生 VPN 隧道 + 内置受保护浏览器**。

## 一、桌面端与移动端能力对照

| 能力模块 | Windows / macOS 桌面端 | Android | iOS |
| --- | --- | --- | --- |
| Tauri 2 + Next.js 工作台 | 本地回环静态服务（3030） | 内置静态资源（`../out`） | 内置静态资源（`../out`） |
| 代理内核与固定出口 | 独立 `mihomo` 进程 + 特权宿主 | `EnvGuardCore.aar` + `VpnService` | `EnvGuardCore.xcframework` + `NEPacketTunnelProvider` |
| 核心控制面 API | 内置 Node v22 进程 | Go 核心库回环 HTTP API（同协议） | Go 核心库回环 HTTP API（同协议） |
| 未保护时阻断 Claude | 防火墙/hosts + `CLAUDE-GUARD` | VPN 内 `CLAUDE-GUARD -> REJECT` | VPN 内 `CLAUDE-GUARD -> REJECT` |
| 受管保护浏览器 | 启动外部 Chrome + CDP 注入 | 内置受保护 WebView（预注入 `runtime-policy.mjs`） | 内置受保护 WKWebView（预注入 `runtime-policy.mjs`） |
| 分应用代理 | 按进程规则 | ✅ `VpnService.Builder.addAllowedApplication` | ❌ 系统不支持按应用分流 |
| 自动修改系统时区 | PowerShell / Swift Daemon | ❌ 非 root 禁止，提供系统设置跳转指引 | ❌ 系统禁止，提供系统设置指引 + 内置浏览器时区伪装 |
| 开机自启 / 托盘 / 重置桌面端 | 支持 | ❌ 不适用（界面自动隐藏） | ❌ 不适用（界面自动隐藏） |

## 二、目录结构说明

- `src-tauri/src/lib.rs` / `desktop.rs` / `mobile.rs` / `mobile_common.rs`：双端 Tauri 2 宿主入口，桌面专属依赖（托盘、自启动、单实例、回收站）通过 `cfg(not(any(target_os = "android", target_os = "ios")))` 隔离。
- `src-tauri/tauri.android.conf.json` 与 `src-tauri/tauri.ios.conf.json`：移动端构建覆盖配置，指向 `../out` 并排除桌面 `backend/` 资源。
- `mobile/core/`：统一 Go 核心库（供 `gomobile bind` 编译为 `.aar` 和 `.xcframework`），内嵌 `mihomo v1.19.33`（`-tags mihomo_embed`），并提供与桌面端一致的 Helper / Gateway HTTP 接口。
- `mobile/android/`：`EnvGuardVpnService.kt`（TUN + `protect(fd)` + 前台服务 + 分应用代理）、`EnvGuardMobileBridge.kt`、`AndroidManifest.overlay.xml`。
- `mobile/ios/`：`PacketTunnelProvider.swift`（`NEPacketTunnelProvider` + 35 MiB 软内存上限应对 50 MiB Jetsam 限制）、`VpnManager.swift`、`Entitlements.template.plist`。

## 三、本地环境准备与构建

先检测本机缺少哪些工具链：

```bash
pnpm mobile:check:android
pnpm mobile:check:ios
```

### Android 构建（Linux / macOS / Windows 均可）

前置依赖：
- Node.js 20+、pnpm、Rust stable（需安装 `rustup target add aarch64-linux-android armv7-linux-androideabi`）
- JDK 17+、Android SDK（API 34）与 NDK（26+），配置环境变量 `ANDROID_HOME` 与 `NDK_HOME`
- Go 1.23+ 与 `gomobile`：
  ```bash
  go install golang.org/x/mobile/cmd/gomobile@latest
  go install golang.org/x/mobile/cmd/gobind@latest
  gomobile init
  ```

构建步骤：

```bash
pnpm install --frozen-lockfile
pnpm mobile:init:android
# 按 mobile/android/AndroidManifest.overlay.xml 合并 VPN 权限与服务声明
pnpm mobile:build:android
```

### iOS 构建（仅限 macOS + Xcode）

前置依赖：
- macOS、Xcode 15+、Rust iOS targets（`rustup target add aarch64-apple-ios aarch64-apple-ios-sim`）
- Go 1.23+ 与 `gomobile`
- **付费 Apple Developer 账号**（真机签名 `Network Extension / Packet Tunnel Provider` 与 `App Groups` 必须）

构建步骤：

```bash
pnpm install --frozen-lockfile
pnpm mobile:core:ios
pnpm mobile:init:ios
```

随后在 Xcode 中打开 `src-tauri/gen/apple`：
1. 添加 `Network Extension (Packet Tunnel)` Target，将 `src-tauri/gen/apple/EnvGuardVPN/PacketTunnelProvider.swift` 加入该 Target。
2. 为主 App Target 与 Extension Target 链接 `node_modules/.checkcc-mobile-core/EnvGuardCore.xcframework`。
3. 参考 `mobile/ios/Entitlements.template.plist` 与 `Extension.Entitlements.template.plist` 配置统一的 `APP_GROUP_ID`（切勿将个人 Team ID 写入公共仓库），并在 Extension 的 `Info.plist` 中添加 `ENVGUARD_APP_GROUP`。

## 四、iOS 50 MiB 内存限制与开源许可证说明

1. **iOS Extension 内存上限**：`PacketTunnelProvider.swift` 启动 Go 核心时显式传入 `memoryLimitMB = 35`，`mobile/core/memory.go` 会启用 `debug.SetMemoryLimit(35 MiB)` 与 `GOGC=20`，并强制使用 `gvisor` 协议栈、关闭大型 Geo 数据库全量加载以防 Jetsam OOM。
2. **许可证合规**：本项目主仓库采用 MIT 许可证，`mobile/core` 嵌入的 `MetaCubeX/mihomo` 为 GPL-3.0。自行构建与分发（尤其是上架 Apple App Store 时）请自行评估 GPL-3.0 合规要求。
