# 仓库协作约定

- 开始修改前检查当前分支与工作区，保留用户已有改动。
- `main` 用于稳定版本。日常开发、修复与外部 PR 集成应在 `develop` 或从其创建的功能分支进行；若当前在 `main`，先切换到适合的开发分支。
- 长期集成分支为 `develop`，功能 PR 默认以 `develop` 为目标。
- 未经用户明确要求，不将开发改动合入 `main`，不发布版本。
- 验证命令与发布流程见 CONTRIBUTING.md；如有失败，报告真实结果，不宣称全部通过。
- 本项目是开源产品：设计功能时必须考虑开源场景（可自行部署/自托管、无私有服务依赖、无硬编码密钥或内部地址、文档与配置对外可理解、便于社区贡献与二次开发）。

## Windows 本地打包记忆

- 用户要求“重新打包”时，默认生成 Windows x64 安装包与便携 ZIP，并复制到系统“下载”目录。
- 使用 PowerShell 7，先检查分支和工作区，保留已有改动。打包流程见 `docs/TAURI-DESKTOP.md`。
- 创建项目内 `node_modules/.tauri-tools/tmp`，将当前进程的 `TEMP`、`TMP` 设为其绝对路径，避免系统临时目录曾出现的链接器 LNK1104 错误。
- 顺序执行 `node scripts/package-desktop.mjs`、`node scripts/build-installer.mjs`，每步退出码为 0 后才继续。两步等价于 `pnpm desktop:installer`，直接使用 Node 可避开 Corepack 为查询 pnpm 版本而联网失败的问题。
- 产物位于 `node_modules/.checkcc-dist`，安装包为 `EnvGuardCC-Setup-<package.json 中的 version>.exe`，便携包为 `EnvGuardCC-Windows-x64.zip`。每次从 package.json 读取版本。
- 从 Windows 注册表 `HKCU:/Software/Microsoft/Windows/CurrentVersion/Explorer/User Shell Folders` 的 `{374DE290-123F-4565-9164-39C4925E467B}` 值解析并展开系统“下载”路径，支持重定向目录。
- 复制完成后比较源文件和目标文件的 SHA-256，核对文件大小和生成时间。最终提供下载目录中的文件链接，并如实说明是否进行了安装运行测试。
- 日志保留在 node_modules 下，输出只展示末尾关键内容。若创建临时目录链接报 EPERM，通过正常权限审批机制重试。
- 若产物生成后仅在清理临时链接时出现 ENOENT，先核对产物时间、构建版本、源码哈希与 ZIP 内主程序完整性。全部通过后可单独执行安装包步骤，并在交付时说明清理错误，不能直接忽略构建失败。
