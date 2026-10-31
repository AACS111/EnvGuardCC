# EnvGuardCC

Claude 运行环境检测与保护工作台，支持浏览器与客户端环境分析、保护配置以及前后对比。

[English](README.en.md) · [GitHub](https://github.com/AACS111/EnvGuardCC) · [问题反馈](https://github.com/AACS111/EnvGuardCC/issues)

## 下载

- [Windows x64 安装包（.exe）](https://github.com/AACS111/EnvGuardCC/releases/download/v0.1.0/EnvGuardCC-Setup-0.1.0.exe)
- [Windows x64 便携包（.zip）](https://github.com/AACS111/EnvGuardCC/releases/download/v0.1.0/EnvGuardCC-Windows-x64.zip)
- [SHA-256 校验值](https://github.com/AACS111/EnvGuardCC/releases/download/v0.1.0/SHA256SUMS.txt) · [全部版本](https://github.com/AACS111/EnvGuardCC/releases)

安装包下载后直接运行；便携包请完整解压后运行 EnvGuardCC.exe，保留同目录运行文件。均已包含运行环境，无需另行安装 Node.js。安装包尚未进行代码签名。

## 界面预览

### 概览

查看浏览器与客户端的检测指标、出口环境、保护配置及异常项目。

![EnvGuardCC 概览](docs/images/envguardcc-overview.png)

### 测试项目

按全部、异常、待处理和通过筛选检测项，查看两端采样值与配置详情。

![EnvGuardCC 测试项目](docs/images/envguardcc-checks.png)

### 保护对比

对比启动前与当前实测结果，区分通过、未通过与待确认。

![EnvGuardCC 保护对比](docs/images/envguardcc-comparison.png)

## 功能

- 浏览器与 Claude 客户端环境检测，覆盖时区、语言、字体、设备特征及网络出口。
- 出口 IP、地区、运营商和网络类型识别，未知结果保留为未判定。
- 启停环境保护、定时复检及逐项配置说明。
- 保护前后对比，展示原生通过、保护后通过、异常与未判定。
- 修改前保存原始配置，正常退出时尝试恢复；失败时保留备份和真实原因。
- Windows 桌面应用、macOS 源码开发模式与本地网页运行模式。

检测指标仅用于环境分析，不代表真实封禁概率，也不保证账号或第三方服务可用性。

## 本地运行

需要 Node.js 20+ 和 pnpm。Windows 的桌面应用与系统设置操作另需 PowerShell 7。

### macOS（Apple Silicon，源码开发）

在包含本次 Mac 适配的本地检出目录中执行；上游 b4d27d5 不包含这些未提交改动，不能改用仅含上游代码的副本。

```bash
pnpm install --frozen-lockfile
pnpm dev:electron
```

首次启动可能需要下载 Electron。桌面模式使用本机 3030 页面端口；`Cmd+Q` 或关闭窗口会退出应用，并在退出时尝试恢复配置、释放本次启动占用的端口。

只运行本地网页：

```bash
pnpm dev
```

启动后使用终端显示的本机地址。

### Windows

以下命令用于 Windows；Apple Silicon 请使用上方的 macOS 源码开发步骤，现有发行包仅面向 Windows。

```powershell
git clone https://github.com/AACS111/EnvGuardCC.git
cd EnvGuardCC
pnpm install
pnpm dev:electron
```

只运行本地网页：

```powershell
pnpm dev
```

启动后使用终端显示的本机地址。桌面模式使用本地 3030 页面端口；首次启动可能需要下载 Electron。

## 平台支持范围

macOS 已完成阶段二、三的源码适配：系统代理读取与手动连接设置、受控浏览器、显式授权的系统时区与恢复、FlClash 配置联动。Claude 当前版本仅提供普通打开；FlClash 写入后需在 FlClash 中重新应用并启动配置，恢复后重新应用并核验。使用步骤及真实验证边界见 [阶段二、三结果](docs/MACOS-STAGE23-RESULTS.md)。

已生成 Apple Silicon 本地试用包（`.app`、ZIP、DMG，ad-hoc 签名），产物在 `node_modules/.checkcc-dist`；`pnpm desktop:package` 生成 `.app` 和 ZIP，`pnpm desktop:installer` 再生成 DMG。按当前交付定位不申请 Developer ID 和公证，其他 Mac 首次打开需在系统设置 > 隐私与安全性中授权；已安装到本机 `/Applications`，异机验证仍未完成。当前实测为 Apple Silicon、macOS 27.0，不据此声明更旧系统或 Intel 支持。详见 [阶段四结果](docs/MACOS-STAGE4-RESULTS.md)。

## 构建与验证

```powershell
pnpm lint
pnpm test:desktop
pnpm test:shutdown
pnpm test:protection
pnpm build
pnpm desktop:installer
```

`desktop:installer` 仅生成 Windows 安装包；Windows 发布包名为 `EnvGuardCC-Windows-x64.zip`，具体目录见打包命令输出。

## 技术栈

Next.js 16、React 19、TypeScript、Tailwind CSS 4、Electron。

## 许可证

MIT，详见 [LICENSE](LICENSE)。
