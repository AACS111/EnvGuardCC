# EnvGuardCC macOS 阶段四结果（本地试用包）

2026 年 10 月 31 日，Apple Silicon / macOS 27.0。本轮完成了 macOS 本地试用包的构建、安装和启动验证；按当前交付定位不申请 Developer ID 和公证，异机验证仍未完成。

## 状态

| 项目 | 结果 |
| --- | --- |
| `.app` | 已生成，arm64，bundle id `io.github.aacs111.envguardcc`，ad-hoc 签名 |
| ZIP | 已生成 |
| DMG | 已生成，`hdiutil` UDZO |
| 内置 Node | 官方 Node 26.8.2 darwin-arm64，下载时校验 SHA-256 |
| Electron | 42.11.18 darwin-arm64 |
| 图标 | 由 `public/envguardcc-icon.png` 生成 `.icns` |
| Developer ID / 公证 | 按当前交付定位不申请；ad-hoc 签名，首次打开需在系统设置 > 隐私与安全性中允许 |
| 本机安装 | 已复制到 `/Applications/EnvGuardCC.app`，启动和退出正常 |
| 异机 / Finder 拖装 | 未验证 |

## 产物

产物在 `node_modules/.checkcc-dist`（已被忽略，不随仓库提交）：

| 文件 | 大小 | SHA-256 |
| --- | --- | --- |
| `EnvGuardCC-darwin-arm64/EnvGuardCC.app` | 474 MB | 目录，见下方签名 |
| `EnvGuardCC-macOS-arm64.zip` | 167.5 MB | `e2cca388eba8102a3ef8c0955ab7f2d91ba295cfe23f500ea742e51a8522118b` |
| `EnvGuardCC-0.1.0-arm64.dmg` | 191.2 MB | `d1597b7e70cf3f9fe099394dba02e29ed53ce6599100f545f0d86617d1745412` |

签名状态：`Signature=adhoc`，`TeamIdentifier=not set`，`spctl -a -vv` 结果为 `rejected`。这是无 Developer ID 时的预期状态：本机可直接运行；复制到其他 Mac 后首次打开需在系统设置 > 隐私与安全性中点击“仍要打开”。

## 构建方式

- `pnpm desktop:package`：先执行 Next.js 静态导出，再由 `scripts/build-desktop.mjs` 生成 `.app` 和 ZIP。
- macOS 分支使用 `@electron/packager@20.3.0`。19.1.1 在 Node 26 上解压 Electron 包时挂起，因此 macOS 固定 20.3.0；Windows 分支仍用 19.1.1，本轮未在 Windows 上运行。
- 内置 Node 不能直接复制 Homebrew 的 `node`（它是链接 `libnode` 的瘦二进制），改为下载官方 Node 26.8.2 darwin-arm64 包并按 `SHASUMS256.txt` 校验。
- 图标从 512×512 的 `public/envguardcc-icon.png` 生成 `.icns`；1024 源图会更清晰。
- 生成 `.app` 后用 `codesign --force --deep --sign -` 做 ad-hoc 签名，再用 `ditto` 压缩 ZIP。
- `node scripts/build-installer.mjs`（`pnpm desktop:installer` 的后半段）用 `hdiutil create -format UDZO` 生成 DMG。`hdiutil` 有弃用警告，功能正常。

## 验证

- `codesign --verify --deep --strict` 通过。
- 打包应用冒烟：页面工作区可见、样式已加载、3 个导航页签、49 张信号卡、详情对话框可开、助手与网关均连通、渲染进程无 Node 集成；退出码 0。
- DMG 以只读方式挂载，直接启动其中的 `.app`，正常退出，磁盘映像可卸载。
- 从构建目录重新打开 `.app`，正常退出。
- 复制到 `/Applications/EnvGuardCC.app` 后启动、退出正常，签名仍为 ad-hoc。
- `pnpm lint` 通过。
- 回归测试 83 项通过：`test:dev` 5、`test:desktop` 11、`test:shutdown` 10、`test:traffic` 6、`test:protection` 39、`test:environment` 12；另 `check-flclash-workflow` 2 项通过。
- `spctl` 拒绝为预期结果，不作为失败。

## 限制与未验证

- 按当前交付定位不申请 Developer ID、不公证；ad-hoc 签名，其他 Mac 首次打开需在系统设置 > 隐私与安全性中授权，不能作为公开分发版本。
- DMG 内没有 `Applications` 快捷方式，需要手动拖入。
- 仅在 Apple Silicon / macOS 27.0 上运行；`Info.plist` 的 `LSMinimumSystemVersion` 为 Electron 默认的 12.0，但未在旧系统验证；Intel 未构建。
- 未在第二台 Mac 上从 Finder 拖装并运行，也未验证内置 Node、Chrome 定位和恢复流程在新机器上的表现。
- 打包应用内没有重新跑受控浏览器、网关实际请求和开始保护后的强制退出恢复；这些由开发态回归和冒烟覆盖，打包态只验证了页面与本机服务。
- Windows 构建本轮未运行，Windows 分支改为按平台选择 packager 版本，需要在 Windows 上回归。
- 本机 shell 存在 `ELECTRON_RUN_AS_NODE=1` 时，直接执行应用会按 Node 启动并立即退出；冒烟使用 `env -u ELECTRON_RUN_AS_NODE`。这是宿主环境问题，不是应用缺陷，但 CI 冒烟要注意。
- 图标源图为 512×512，放大到 1024 生成 icns；发布前建议换成 1024 源图。

## 后续

1. 如需公开分发，再申请 Developer ID Application 证书，启用 Hardened Runtime，公证 `.app`/DMG，并校验最终分发文件。
2. 增加 arm64 macOS 构建任务；统一 Windows 和 macOS 的发布资产与校验值。
3. 在另一台未安装开发依赖的 Mac 上做 Finder 拖装、启动、受控浏览器、保护恢复验证。
4. 视需要补充 DMG 的 `Applications` 快捷方式和 1024 图标源图。
