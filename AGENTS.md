# 仓库协作约定

- 开始修改前检查当前分支与工作区，保留用户已有改动。
- `main` 用于稳定版本。日常开发、修复与外部 PR 集成应在 `develop` 或从其创建的功能分支进行；若当前在 `main`，先切换到适合的开发分支。
- 长期集成分支为 `develop`，功能 PR 默认以 `develop` 为目标。
- 未经用户明确要求，不将开发改动合入 `main`，不发布版本。
- 验证命令与发布流程见 CONTRIBUTING.md；如有失败，报告真实结果，不宣称全部通过。
- 本项目是开源产品：设计功能时必须考虑开源场景（可自行部署/自托管、无私有服务依赖、无硬编码密钥或内部地址、文档与配置对外可理解、便于社区贡献与二次开发）。

## Windows 本地打包记忆

- 用户要求“重新打包”时，**默认只生成免安装 ZIP**（`EnvGuardCC-Windows-x64.zip`）并复制到系统“下载”目录；用户本地测试直接解压 `EnvGuardCC.exe` 运行，不需要安装包。只有用户明确要求安装包时，才额外执行 `scripts/build-installer.mjs`。
- 使用 PowerShell 7，先检查分支和工作区，保留已有改动。打包流程见 `docs/TAURI-DESKTOP.md`。
- 创建项目内 `node_modules/.tauri-tools/tmp`，将当前进程的 `TEMP`、`TMP` 设为其绝对路径，避免系统临时目录曾出现的链接器 LNK1104 错误。
- 执行 `node scripts/package-desktop.mjs`，退出码为 0 才算成功；直接使用 Node 可避开 Corepack 为查询 pnpm 版本而联网失败的问题。
- 打包前先删除残留的 `.checkcc-desktop-build-source` 目录；上次构建遗留会让清理阶段报 `EBUSY: resource busy or locked`。
- 产物位于 `node_modules/.checkcc-dist`，便携包为 `EnvGuardCC-Windows-x64.zip`（安装包 `EnvGuardCC-Setup-<version>.exe` 仅在明确要求时生成）。每次从 package.json 读取版本。
- 从 Windows 注册表 `HKCU:/Software/Microsoft/Windows/CurrentVersion/Explorer/User Shell Folders` 的 `{374DE290-123F-4565-9164-39C4925E467B}` 值解析并展开系统“下载”路径，支持重定向目录。
- 复制完成后比较源文件和目标文件的 SHA-256，核对文件大小和生成时间。最终提供下载目录中的文件链接，并如实说明是否进行了安装运行测试。
- 日志保留在 node_modules 下，输出只展示末尾关键内容。若创建临时目录链接报 EPERM，通过正常权限审批机制重试。
- 若产物生成后仅在清理临时链接时出现 ENOENT，先核对产物时间、构建版本、源码哈希与 ZIP 内主程序完整性；全部通过后再交付，并在交付时说明清理错误，不能直接忽略构建失败。

## 内核与特权宿主记忆

- Windows 上单次 `Get-NetFirewallRule` 约 3.2 秒，超过应用探测宿主的 3 秒超时。宿主 `/health` **禁止现查 PowerShell**，只能读缓存并由后台刷新，否则表现为“特权宿主探测超时”→ 误判“需要新版特权宿主”→ 启动保护失败。
- 宿主只需首次授权安装，之后复用；只有宿主运行包内容变化（版本升级）时才再授权一次。反复弹授权应优先怀疑宿主探测失败，而不是协议不匹配。
- fail-closed 的布防判据是“隧道是否确认接管”，不是“应用是否在运行”；撤防必须晚于 TUN 与出口验证，否则会把隧道流量一起拦掉。
- 浏览器等不按进程拦的入口靠 hosts 段覆盖（默认 Anthropic/Claude 域名写入 `0.0.0.0` 与 `::1`），不自动按 IP 阻断（Cloudflare 共享网段会误伤）。
