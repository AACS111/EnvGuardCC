# Tauri 2 桌面开发与打包

客户端采用 Tauri 2 宿主与内置 Node 后台。Windows x64 使用系统 WebView2，macOS arm64 使用系统 WKWebView；不携带 Electron/Chromium。现有 React 页面与业务后台继续复用。

## 开发环境

- Node.js 20+、pnpm、Rust stable。
- Windows：Visual Studio C++ Build Tools、Windows SDK、PowerShell 7、WebView2。
- macOS：Xcode Command Line Tools；原生时区服务使用 Swift 编译。

```sh
pnpm install --frozen-lockfile
pnpm dev:tauri
pnpm test:tauri
```

`dev:tauri` 启动 Next 开发页面，再启动 Tauri。页面端口为 3030，开发助手与网关使用 3001/3010。退出开发启动器时先请求宿主正常退出，待配置恢复后才关闭 Next。恢复失败时保留应用供重试。

可选的仓库隔离 Rust 工具链位于 `node_modules/.tauri-tools/{cargo,rustup}`，构建脚本会在没有显式 CARGO_HOME/RUSTUP_HOME 时自动使用它；CI 使用正常安装的 Rust 工具链。

## 运行结构与权限

- Rust 负责窗口、托盘、单实例、自启动、原生确认与回收站，以及防休眠和唤醒/解锁通知。
- macOS 自启动沿用旧版 SMAppService.mainApp 注册，保留系统批准/禁用状态和 requires-approval 提示；登录启动标记通过系统 AppleEvent 读取。
- macOS 的 WKWebView 配置本地 HTTP 传输支持；窗口导航与原生能力继续由 Rust 的精确回环来源检查限制。
- `desktop/backend.mjs` 使用 Node 启动助手、网关和仅监听回环地址的页面服务。发行版后台端口动态分配，通过 `__CHECKCC_PORTS__` 注入页面。保留 HTTP 页面以支持受控 Chrome/Edge 打开相同页面。
- Rust/Node 通过 stdin/stdout 交换逐行 JSON：request/response 使用 id 关联；ready/failed/power 为后台事件。应用日志仅写 stderr。
- 页面只获得 `envGuardDesktop.getSettings/updateSettings/resetClaude`。权限动态绑定到 main 窗口的精确回环来源；不开放文件系统、进程启动或通用原生方法。页面来源之外的 HTTP(S) 链接交给系统浏览器。
- `frontendDist` 配置的 HTTP 地址会被 Tauri 归为 Local：main 窗口需授予对应本地桌面命令权限；测试或开发中的其他端口仍按精确 Remote URL 授权。Rust 命令继续复核窗口标签和实际来源，不开放其他插件命令。
- Node 独立恢复原始配置，成功后才关闭网关和监听器。管道断开时尝试恢复，失败保留磁盘备份，下次启动继续恢复。

发行版沿用系统应用数据目录下的 `CheckCC/desktop-settings.json` 与 `CheckCC/state`，开发版使用 `check-cc`。Electron 浏览器缓存和页面 localStorage 不自动转换；后台设置和配置恢复备份保持兼容。

## 构建与交付

```sh
pnpm desktop:package
pnpm desktop:installer
```

打包先在隔离源目录导出 Next 页面并核验 CSS 与源码哈希，再构建 Tauri。完整前端只作为后台资源复制一次。后台携带官方 Node v22.23.2，版本与官方 SHASUMS256 校验值固定在 `scripts/node-runtime-manifest.json`；已缓存的压缩包每次仍须通过 SHA-256 校验，缓存存在时不再联网获取校验文件。更新 Node 版本时须从清单中的官方来源同步校验值。保留 TypeScript、运行时源码和对应平台的 classic-level 原生依赖，支持内置模拟测试。

产物位于 `node_modules/.checkcc-dist`：Windows 为 `EnvGuardCC-Windows-x64.zip` 和 `EnvGuardCC-Setup-<版本>.exe`；macOS 为 `EnvGuardCC-macOS-arm64.zip` 和 `EnvGuardCC-<版本>-arm64.dmg`。

Windows 安装器在系统缺少 WebView2 时联网安装。便携 ZIP 不携带 WebView2，需先在系统安装。安装器识别旧版 electron-builder NSIS 的注册记录，在旧目录替换客户端；发现旧版仍运行则停止，用户数据不随卸载删除。仅清理已识别旧安装中的 Electron 运行文件。

macOS APP 使用 ad-hoc 签名，不新增 Developer ID 或公证。签名外围应用时不重新签署时区 bridge；交付前核对 bridge cdhash 和 daemon 签名，发现变化拒绝交付。DMG 保留 Applications 入口和安装说明。

每次打包写入 `tauri-size-<平台>.json`，记录 ZIP 和安装体积；如果本机存在旧 Electron 产物，同时记录其版本与大小。只有 `referenceIsSameVersion` 为 true 才适合作同版本参考；不同源码版本仍需重建旧包才能严格比较。

## 验证

```sh
pnpm lint
pnpm build
node --test --test-timeout=60000 scripts/check-*.mjs scripts/check-*.cjs tools/license-generator/check-license.mjs
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

Rust 检查前需有 `node_modules/.checkcc-tauri-backend` 目录，开发/打包命令会生成。两平台分别验证安装升级、单实例、托盘、自启动、原生回收站、保护恢复、时区授权和唤醒。Windows 还需覆盖缺少 WebView2 及无外部 Node 的环境。

设置 `CHECKCC_DESKTOP_SMOKE=1`、独立 `CHECKCC_DESKTOP_USER_DATA` 和 `CHECKCC_SMOKE_REPORT` 后启动发行版可执行文件，可检查真实 WebView、样式、助手、网关、原生设置桥及渲染进程隔离。必要时设置 `CHECKCC_DESKTOP_SMOKE_PORT` 使用隔离端口；权限仍精确绑定该端口。测试不会自动开启保护。

`pnpm test:desktop:smoke` 会自动准备上述隔离环境、从 PATH 移除外部 Node，并测试当前平台已打包的客户端。Windows 应用位于 `node_modules/.checkcc-dist/EnvGuardCC-tauri-win32-x64`，macOS 位于 `EnvGuardCC-tauri-darwin-arm64`，与旧 Electron 输出目录分开。

默认冒烟测试将隔离端口配置为测试实例的 frontendDist，覆盖与正式 3030 地址相同的 Local ACL 路径；`node scripts/smoke-desktop.mjs --remote-acl` 覆盖 Remote 路径。测试保留正式插件链，只隔离单实例标识、数据和端口，并断言使用正式 Tauri 配置、URL 分类符合预期、无关 autostart 插件命令被拒绝。此前仅随机端口测试覆盖 Remote，漏掉了正式地址的 Local 权限；现已修正并纳入 Windows CI。

macOS 的 CI 构建成功不能替代原生功能验收；尚未完成实际验证时应明确标记，不能声明已验证。

## 本次 Windows 验证（0.1.2）

使用相同前端导出资源，将 develop `cb18373` 的 Electron 宿主在隔离目录重新打包，和 Tauri 0.1.2 对比：

| 产物 | Electron | Tauri 2 | 减少 |
| --- | ---: | ---: | ---: |
| Windows x64 ZIP | 190.4 MiB | 43.8 MiB | 77.0% |
| 解压后应用 | 486.7 MiB | 130.4 MiB | 73.2% |

Tauri NSIS 安装器为 27.7 MiB。详细字节数保存在产物目录的 `tauri-size-Windows-x64.json`。

- ESLint、Next 静态生产构建、Rust 原生权限边界测试通过。
- 完整 Node 回归以 `--test-concurrency=2` 运行：226 通过、3 项平台相关测试跳过，无失败或取消。此前并行编译期间一个 Chromium 测试超过其 15 秒上限；单独重跑与降低并发后的完整回归均通过。
- 真实 WebView 冒烟测试通过：隔离数据、随机端口、PATH 移除外部 Node，验证样式、助手、网关、原生设置桥与渲染进程隔离。
- 桌面设置连接会在页面导航完成后重试桥接，避免首次 React 挂载早于接口就绪导致控件一直禁用；Tauri 字符串错误转换为 Error，保留可见错误信息。新增 3 项连接时序回归通过。
- 控件回归检查真实 DOM：启动保护开关可用、实际点击开启并保存、再关闭并保存；重置按钮解除禁用。测试仅修改隔离 profile 的启动选项，不重置真实 Claude 数据。
- Local/Remote 两组真实 WebView ACL 测试均通过：`tauriDevMode=false`，Local 组 `frontendMatchesPage=true`，Remote 组为 false；三个桌面控件均可用，开关保存与恢复通过，无关插件命令仍被拒绝。
- 直接用发行包内 Node 运行模拟自检：14 项通过；包内 classic-level 原生数据库读写通过。
- Windows 安装器编译通过；安装/卸载钩子位于 Tauri 默认强制结束进程检查之前，要求先正常退出应用。
- 安装保护直接使用 Windows Toolhelp 进程快照，按完整进程名匹配；不解析 tasklist 输出，也不依赖安装脚本的暂存寄存器。`pnpm test:installer` 用实际 NSIS 探针验证未运行放行、运行拦截且不结束进程、退出后放行三种场景，CI 在 Windows 打包后执行。

待实机验收：macOS arm64 构建与系统集成、Windows 旧版就地升级/卸载、系统缺少 WebView2 的联网安装，以及登录启动和系统睡眠/解锁。这些项目不计入已通过的验证。

## 内置网络内核

`pnpm dev:tauri` 和 `pnpm dev` 会按 `scripts/net-core/kernel-manifest.json` 自动准备当前平台的 Mihomo，缓存于 `node_modules/.checkcc-kernel`。每次启动前核验固定 SHA-256；缓存缺失或损坏时重新下载，未固定校验值的平台明确拒绝准备。离线开发可提前运行 `pnpm kernel:fetch` 准备缓存。显式设置 `CHECKCC_NET_CORE=0` 或 `CHECKCC_NET_CORE_BINARY` 时，开发启动器不自动下载。

`pnpm desktop:package` 将已校验的内核、后台依赖和 `third_party/mihomo` 来源/许可证一并放入桌面包；最终用户无需另装 Clash 或内核。更新内核时需更新清单版本、下载地址及经验证的校验值，不应在普通构建中自动更新版本。

绑定内核不等于已验证系统 VPN 接管。普通开发默认不开 TUN；TUN 仍需要系统权限及可用的真实出口节点。正常退出、强制终止、特权宿主崩溃、DNS/路由恢复必须分别验收。

网络页现可独立开启/关闭系统接管，成功后保存意愿；环境保护会话由后台先核验隧道再应用配置。主内核与临时探测内核已启用随机控制器密钥；升级后应重新安装特权宿主以使用受保护运行包和新的配置验证逻辑。macOS 严格模式使用独立 PF 规则并保留崩溃后的阻断，普通模式和 Windows 不提供该能力。Windows UAC 授权代码已实现，但本轮未做 Windows 实机验收。详见[实现与验收记录](NETWORK-SAFETY-IMPLEMENTATION.md)。

内核通过独立 Node 守护进程启动：正常停止关闭控制管道；父进程被强制结束时，守护进程在管道 EOF 后先正常终止内核，1.5 秒后仍未退出则强制终止。特权宿主同时要求应用每 5 秒续约；失联 30 秒后回收内核。升级旧宿主时需重新安装/重启宿主，使心跳租约代码生效。停止操作必须确认退出；失败会报错并保留控制接口供重试，不再报告假成功。

打包版是 `windows_subsystem` 进程，没有控制台，后台 stderr 不能丢给继承管道：宿主把它追加到 `<配置目录>/logs/backend.log`（超过 8 MB 在下次启动时轮换为 `backend.log.1`），并通过 `CHECKCC_BACKEND_LOG` 让后台把带时间戳的日志写进同一文件。宿主自身也会记录启动、退出请求、配置恢复结果和后台退出码；后台停止时弹窗会给出退出码与日志路径，便于上报问题。

后台崩溃（未捕获异常、未处理的 Promise 拒绝、日志管道断裂）同样必须先恢复用户配置再退出：恢复最多等待 60 秒，超时强制退出并保留原始备份，避免 Claude 代理继续指向已经停止的端口。回归：`node --test scripts/check-tauri.mjs`（含“后台崩溃时先恢复配置再退出”与“日志管道 EPIPE 不退出后台”）。

隔离生命周期回归：`node --test scripts/check-kernel-vendor.cjs scripts/check-kernel-lifecycle.cjs`。真实内核测试不修改系统代理、不开 TUN；它们不能替代实机的 TUN、路由和 DNS 恢复验收。普通“关闭保护”仅关闭 TUN，内核继续提供节点诊断；需要完全退出内核时，从应用托盘退出应用。
