# 网络内核（TUN / 分流 / DNS）

EnvGuardCC 从"只看环境"扩展到"掌控出口"后的内核层说明。内核使用 mihomo（Clash.Meta），
由本仓库内置分发。本文件说明设计约束、权限要求、许可证义务和验证方法。

## 为什么内置内核

内置内核让节点、路由与生命周期可以由 EGCC 统一管理；具体能力仍需按观测范围和故障场景验证：

| 需求 | 外部客户端 | 内置内核 |
|---|---|---|
| Claude 域名一定走指定出口 | 靠用户自己加规则，随时被订阅更新覆盖 | 置顶规则由程序生成，顺序受测试保护 |
| 出口不自动漂移 | 客户端默认 `url-test` 自动切节点 | Claude 组强制 `select`，只能显式切换 |
| 异常后阻止直连 | 取决于客户端和系统配置 | macOS 可选严格模式用独立 PF 阻断；普通模式和 Windows 尚无独立系统阻断 |
| 验证"真的走了隧道" | `dig` 看 fake-ip，属于推断 | `/connections` 返回真实代理链 |

`scripts/net-core/routes.mjs` 直接读取内核连接表，只能证明观察到的连接命中了指定组；不能断言内核外不存在直连。
macOS 严格模式的原生 TUN、内核强杀后的阻断和恢复已经在受控测试中验证；不能保证第三方服务的地区资格或账号结果。平台与场景边界见 [连接保护实现记录](NETWORK-SAFETY-IMPLEMENTATION.md)。

## 结构

```
scripts/net-core.mjs        内核主管：spawn、就绪等待、健康巡检、自动重启、外部控制器 API
scripts/net-core/config.mjs 配置生成与结构校验（置顶规则、select 组、strict-route、fake-ip）
scripts/net-core/routes.mjs 从 /connections 提取路由证据
scripts/net-core/vendor.mjs 内核产物的下载、解压、sha256 校验与首次固定
scripts/net-core/kernel-manifest.json 版本与各平台产物清单
```

## 配置不变量

`buildKernelConfig()` 生成，`assertKernelConfig()` 校验。任何一条不满足都拒绝启动：

1. 生成模板中 `tun.enable = true` 且默认 `tun.strict-route = true`；运行时按用户接管意愿设置 enable。不能据此证明内核退出后持续阻断。
2. `ipv6 = false` —— 关闭内核双栈功能；物理网卡 IPv6 旁路仍需实机验证。
3. `dns.enhanced-mode = fake-ip` 且 `respect-rules = true` —— 解析本身也走隧道。
4. Claude 域名规则（`anthropic.com` / `claude.ai` / `claude.com` / `claudeusercontent.com` /
   `challenges.cloudflare.com`）的 QUIC 拒绝规则排最前，其后是通用域名代理规则；两者均优先于订阅和内网规则。
5. Claude 出口组固定 `type: select`，禁止 `url-test` —— 自动测速切换会让出口 IP 漂移。
6. 非 Claude 流量的兜底组（`AUTO-PROXY`）必须是 `fallback` / `url-test`，带 `url` + `interval`
   健康检查，且成员覆盖**全部**节点 —— 兜底绑单节点时，节点一抖全部境外流量就 fail-closed 中断。
7. 最后一条规则必须是 `MATCH`：rule/global 模式为 `MATCH,AUTO-PROXY`，claude/direct 模式为
   `MATCH,DIRECT`；且不允许重复规则。

`pnpm test:netcore` 覆盖以上全部约束；运行时 `writeConfig()` 也会在写盘前调用
`assertKernelConfig()`，所以不满足的配置在内核启动前就会被拒绝，而不是等到节点掉线才暴露成断网。

## 兜底与节点故障转移（对齐 FlClash）

早期实现把 `MATCH` 直接指向 Claude 专用组：`MATCH,CLAUDE-PIN`。当 `CLAUDE-PIN` 里只有一个节点时，
该节点握手失败会让**所有**未命中国内直连清单的流量（即全部境外访问）一起超时，而国内站点仍正常 ——
典型表现就是“开了保护只有国外没网”。FlClash 这类客户端的做法是让兜底指向可自动转移的代理组，
本仓库采用同样思路：

| 组 | 类型 | 职责 |
|---|---|---|
| `CLAUDE-PIN` | `select` | Claude 家族域名专用；出口 IP 必须人工固定，不自动切换 |
| `AUTO-PROXY` | `fallback`（默认，可切 `url-test`） | rule/global 模式的兜底出口；按顺序故障转移，节点连续失败后自动换下一个 |

- 健康检查默认 `https://www.gstatic.com/generate_204`、`interval: 300`、`lazy: false`；
  `fallback` 只在失败时切换（不因延迟抖动换出口），`url-test` 才使用 `tolerance: 50`。
- `fallback` 成员顺序即优先级，成员必须包含全部节点；少放节点等于主动放弃冗余。
- 单节点场景仍会建组：健康检查失败能被 `/proxies` 与界面明确观测到，而不是静默把流量压在死节点上。
- 界面会同时显示 Claude 组的当前节点（`selected`）与兜底组实际选中的节点（`autoSelected`）。

## 隧道活性校验（fail-closed 的关键）

实测结论：**非管理员时 mihomo 会正常启动、外部控制器 API 也可用，但虚拟网卡根本没有建立。**
仅凭"进程活着 + API 应答"会误判为保护生效。

因此 `createNetCore({ verifyTunnel: true })` 会在就绪后额外校验：

1. 通过系统解析（`dns.lookup`，走 getaddrinfo，会被 TUN 的 DNS 劫持影响）查询每次新建的 `egcc-<随机值>.claude.ai`，明确使用 IPv4，避免旧缓存和 AAAA 优先造成误判；开启和热加载后最多等待约 4 秒接管；
2. 解析结果必须落在 fake-ip 段（默认 `198.18.0.0/16`）；
3. 不在该段即判定隧道未接管，抛出错误并结束内核进程。

`health()` 也会在每次巡检时重复该校验：隧道掉了不再靠"进程还在"充当健康。

启用 TUN 前还会执行网络交接：正常退出当前用户已识别的代理客户端，等待内核与端口释放；macOS 同时检查系统 VPN、默认隧道路由和残留系统代理。未能释放时拒绝接管并显示原因。完整支持列表及平台限制见[交接说明](NETWORK-SAFETY-IMPLEMENTATION.md)。独立本机代理模式不会主动退出其他工具。

> 生产环境必须传 `verifyTunnel: true`。默认 `false` 仅为让模拟内核的单元测试不受影响。

## 固定出口探测：复用主内核，不再起临时内核

早期实现用「临时内核 + 每节点独立入站」并行探测（`probeExitsParallel`）。TUN 开启时这条路会失效：
临时内核 `tun.enable=false`，而 mihomo 的 `auto-detect-interface` 绑定逻辑只在 TUN listener 真正启动时生效，
于是探测流量按系统默认路由又进入主内核的 utun，被 sniffer 按 `override-destination` 重新路由，
Reality 握手失败（实测日志 `REALITY authentication failed`），启动环境防护必然报「固定出口探测失败」。

现在改为 FlClash 式的主内核探测（Plan B）：

- `buildKernelConfig({ exitProbeHost })` 在规则表里给探测主机加一条钉死 Claude 专用组的路由
  （域名用 `DOMAIN-SUFFIX`，IP 用 `IP-CIDR`/`IP-CIDR6`），放在置顶代理规则之前；
- 探测请求走已有的混合入口，由**主内核自己的 dialer** 拨节点（TUN 模式下已绑定物理网卡），不会被自己的 TUN 截获；
- 不新增 `listeners`：特权宿主的配置字段白名单只接受 EGCC 生成的既有字段，额外入站需要改宿主并重新授权；
- 严格模式重写规则后仍然使用带认证的混合入口探测；
- `probeSelectedExit()` 不再调用 `probeExitsParallel`，`check-kernel-lifecycle.cjs` 用注入的 `createCore` 计数锁定「探测不另起内核」。

`probeExitsParallel` 仍保留给「按节点逐个测出口」；拿不到并行结果时退回串行（会短暂切换选中节点）。

## Claude 支持地区校验

```
src/detection/claude-regions.mjs   # 官方清单 + 判定函数（前后端共用）
```

- 清单来自 Anthropic [Supported Regions Policy](https://www.anthropic.com/legal/supported-regions)，2026-11-07 抓取，共 185 个 ISO 代码；
  更新政策时同步改清单与 `CLAUDE_SUPPORTED_REGIONS_RETRIEVED_AT`。
- 环境防护 `detect` 拿到固定出口后调用 `assertClaudeSupportedExit`：出口在清单外（CN/HK/RU 等）直接拒绝启动，
  不写浏览器/网关配置，也不把该出口的时区、语言适配当成「保护成功」。
- **边界**：只校验出口 IP 的国家/地区，不能判断用户物理位置；Anthropic 政策对「人在不支持地区」同样有限制，
  该清单不能把这种情况变成合规，只能避免「出口本身在封禁地区」这一更直接的风险。

### 区域锁定（运行中出口落回封禁地区 / 网络波动）

运行中每 30 秒复检固定出口（非严格模式也检查），并在网络接口变化、隧道未接管、
探测失败时按“无法确认出口”处理。一旦出问题：

1. 在运行时内存里标记锁定（不写盘；应用退出即消失）；
2. 重建配置，在 Claude 置顶规则之前插入 `DOMAIN-SUFFIX,<claude域名>,REJECT`（严格模式同样生效）；
3. 热加载后只断开已建立的 Claude 连接（按 host 匹配，不动其他连接）；
4. 界面顶部显示红色提示并提供「复检并解除」，同时尽力发一条 macOS 通知。

两类锁：
- **地区锁**：出口明确在不支持地区，必须切换节点后手动复检解除；
- **网络锁**：网络断开/波动/探测失败导致无法确认出口，网络恢复且下一次复检通过后自动解除。

锁定只拦 Claude 域名，不影响其他流量，也不会改动其他连接（只断已建立的 Claude 连接）。
关闭窗口、应用留在托盘时阻断继续生效；彻底退出应用后隧道关闭、系统时区与浏览器配置恢复，
阻断停止且不留锁定状态，下次启动按当前出口重新检测（出口仍在封禁地区会再次锁定）。
若需要「退出应用后仍禁止 Claude」，要么开严格模式（PF 阻断会保留，但会阻断全部非节点流量），
要么给特权宿主增加 Claude-only 的持久阻断（需要改宿主并重新授权）。

## 公共 DNS 与出口地区对齐（）

 /  是全球 anycast，GeoIP 库对同一地址的标注互相矛盾（实测：出口在首尔，
解析器却被标成日本），「解析器国家 ≠ 出口国家」本身就是一条自相矛盾的指纹。

选解析器的顺序：节点名认地区 → 认不出用节点服务器 IP 实测国别（，按 IP 缓存）→
都认不出退回 anycast DoH。地区表只收录**已核对过归属国**的非 anycast 解析器
（KR/JP/HK/SG/TW/US/IN/IT/MX/MY/BR/AU/TH）。 可显式覆盖。

出口地区变化（手动切节点、AUTO-PROXY 故障转移、订阅换节点）由  兜住：
按 Claude 组当前实际节点重算，变了就重建配置并用  热加载——
热加载会把 select 组重置成第一个节点，所以必须把各组原节点写回去（有回归测试锁定）。

## 遗留内核与端口占用（fail-closed，不假装就绪）

实测事故：宿主认为内核没在跑（`running:false`），但上一台内核还占着 `39090`，界面照样显示「运行中」。
只等 `/version` 有应答就把内核判为就绪，会把「别人的内核」当成自己养的——停它、重启它都是假象。

- `createNetCore()` 在 spawn 前先查端口归属（`scripts/net-core/ports.mjs`：netstat / lsof / ss）：
  端口被占就抛错并指出 PID 与进程名，**不 spawn** 一个注定绑不上端口的内核；
  就绪后再校验「进程有 PID 且没退出」，避免把遗留内核当成就绪。
- `createKernelHost()` 启动前清理遗留内核：**只杀确认属于本程序**的进程（命令行包含本程序二进制路径或状态目录）。
  FlClash 之类也可能叫 `mihomo.exe`，命令行对不上或读不到时一律拒绝启动，不做按名字误杀。

## TUN 的「启用」与「接管」必须分开判断

`tunEnabled` 只表示「配置里开了 TUN」；`tunCaptured` 才是「网卡真的接管了流量」（靠 fake-ip 探测）。
两者混用会让「开了但没接管」与「根本没开」在界面上长得一模一样——实测事故里用户看到的就是这种误导。

- 运行时每次 `launch()` 重新探测特权宿主：装了宿主但应用先启动时，TUN 不能因为构造时探一次就永久写死成关闭。
- `report()` 同时给出 `tunEnabled`、`tunCaptured`、`hostMode`，界面据此分成三种提示：
  未启用 / 已配置但未接管 / 由宿主托管但显式关闭（`CHECKCC_NET_CORE_TUN=0`）。

## 借用本机已装的代理客户端（`scripts/net-core/local-proxy.mjs`）

强制用户卸载 FlClash 才能用 EnvGuardCC 是不合理的，反过来也不该默认用户的机器上只有本程序。
这里做的是**只读借用**：扫描本机监听端口 → 按进程名筛出已知代理客户端 → 协议握手确认 → 列表给用户选。

- 白名单按进程名匹配（FlClash / Clash Verge / mihomo / v2rayN / sing-box / NekoRay / Hiddify / Shadowsocks…），
  不在白名单的进程哪怕是 Web 服务也不当作代理——不能把订阅令牌发给任意本机端口。
- 端口必须先握手成功：SOCKS5 发问候字节、HTTP 发 `CONNECT`，两者都不通就丢弃（只是碰巧在监听）。
- 本程序自己的端口（39080/39090/39091/1053/9090）一律排除，否则会形成环。

两处用到它：

1. **订阅下载降级**（`subscription.mjs`）：直连拿不到时，依次借本地 HTTP 代理端口重试；
   报错会点名「已尝试本地代理：FlClash:7890（HTTP 403）」，而不是只给一句笼统失败。
2. **作为出口节点**（`import` 的 `local-proxy` 模式）：追加一个指向 `127.0.0.1:port` 的 `http`/`socks5` 节点。
   追加而不替换——`importNodes(..., { append: true })`，否则会用本地代理把已有订阅节点整批覆盖掉。

接口：`GET /__checkcc/net-core/local-proxies` → `{ ok, items, summary }`；界面「管理配置 → 添加配置 → 本地代理」直接消费。

## 保护开关、内核与退出（三者关系必须一致）

- **内核随应用启动**（`desktop/backend.mjs`），与保护开关无关；有内核就有 TUN 接管。
- **保护开关只切 TUN，不停内核**（`Detector.toggleProtection` → `net-core action=tunnel` → `runtime.setTunnel()`）：
  关闭保护 → 写 `tun.enable=false` 并热加载（内核继续跑，节点仍可测速/切换，本机 39080 仍可当代理）→ 再恢复环境配置。
  这与 FlClash 一致：应用开着内核就在，开关代理只是接管与否。界面上内核停止（`state=idle`）只在「退出应用」或「手动停内核」后出现。
- **退出即全部关闭**：`closeServices` 依次停掉订阅刷新/公共 DNS 同步定时器、网关、站点与内核；
  开发服（`scripts/dev.mjs`）同样处理。

### 宿主跟丢内核时的兜底

宿主把内核记在内存里，进程重启或异常退出后 `core` 变成 `null`，但旧内核仍占着端口并维持 TUN。
只按 `core` 判断会导致「应用关了，流量还在隧道里」（实测事故）。因此：

- `host.stop()` 即使 `core === null` 也会按「确认属于本程序」的规则再清一次遗留内核（`clearLeftoverKernel`）；
- `runtime.stop()` 在宿主模式停止后复查端口归属，仍被占用就记日志（内核未真正停止）；
- 宿主不可达时只记录失败原因，不假装已停止。

## 节点域名解析：必须用订阅自带的 DNS

实测事故：37 个 AnyTLS 节点全部「超时」，而同样的节点在 FlClash 里可用。原因不是节点坏了，
是**代理服务器域名解析错了**：

- 节点 server 是服务商私有域名（形如 `*.private.<provider>`）；
- 公共 DNS 把它解析到一个连不上的地址（实测 TCP 超时）；
- 订阅自带的 `dns.proxy-server-nameserver`（服务商私有 DoH）解析到正确的 IP
  （实测 TCP 连通、节点延迟回到可用的毫秒级）。

所以订阅里的 `proxy-server-nameserver` 不是可选项：`parseClashConfig` 会把它带出来，
经 `importNodes` 落盘到 `net-nodes.json`，再由 `buildKernelConfig({ proxyServerDns })`
写进内核配置。缺失时退回公共 DNS（`223.5.5.5`、`1.1.1.1`），不伪造。

### 解析结果要验证并持久化（与 FlClash 一致的做法）

只把订阅的 DNS 段传给内核还不够：服务商 DoH 本身会挂（实测 TCP 超时），一旦不可用，
全部节点瞬间超时。所以节点地址解析走「订阅自带 DNS → 公共 DoH → 系统解析」，
每个候选地址都做 **TCP 验证**，通过的写入 `node-hosts.json` 并同步进内核 `hosts`；
启动时先复验缓存，通过就直接用，解析失败也不会让节点全挂。仓库不内置任何服务商地址或令牌，
这些只存在于用户自己的状态目录与订阅里。

推论：**任何订阅变更都必须经过一次导入/刷新**，否则旧的节点清单里没有这份 DNS 提示，
节点会继续全部超时。

## 开源边界与数据归属（重要）

这个仓库是**通用程序**，不携带任何用户或服务商的数据。落到代码与发布物里的只有机制：

| 内容 | 存放位置 | 是否进仓库 |
|---|---|---|
| 订阅地址、节点凭证、服务商私有 DNS/令牌 | `<state>/net-nodes.json` | ❌ 不进（`node_modules/.checkcc-local` 被 `.gitignore` 忽略） |
| 已验证的节点地址（域名 → IP） | `<state>/node-hosts.json` | ❌ 不进 |
| 订阅域名直连白名单 | `<state>/net-core-direct-hosts.json` | ❌ 不进 |
| 生成的内核配置（含密钥） | `<state>/net-core/config.yaml` | ❌ 不进 |
| 地区 → DNS 解析器映射 | `scripts/net-core/public-dns.mjs` | ✅ 进（公共 ISP 地址，非某家服务商私有） |
| 代理客户端进程白名单 | `scripts/net-core/local-proxy.mjs` | ✅ 进（公开产品名） |

约定（评审与提交时按此检查）：

1. **不得在源码、测试、文档里写死任何服务商域名、私有 DNS 令牌、节点 IP**；示例一律用 `example.com` / `203.0.113.0/24`（RFC 2606 / 5737 保留段）。
2. 节点域名解析、DoH、UA、地区 DNS 这些**全部来自订阅或用户状态**，代码只负责读取、验证与降级。
3. 内置内核 mihomo 为 GPL-3.0（见 `kernel-manifest.json`）：分发二进制时须同时提供许可证与对应源码获取方式；
   本仓库自身仍是 MIT，组合分发物的许可差异必须在 README 中说明。
4. 新增能力优先做成「可被任意订阅/客户端驱动」的机制，而不是针对某家机场的临时补丁。

## 权限

| 平台 | TUN 需要 | 说明 |
|---|---|---|
| Windows | 管理员 | 安装器以管理员运行，或每次启动弹 UAC |
| macOS | root 助手 | 复用现有特权助手安装流程（见 `scripts/timezone-service.mjs` 与 `src-tauri/installer`） |
| Linux | `CAP_NET_ADMIN` | 或 `setcap cap_net_admin,cap_net_raw+ep` |

未获得权限时**不得**降级为"仅系统代理"继续运行：那会让部分流量绕过隧道。正确行为是审计失败并停止受保护客户端。

## 内核产物与许可证

- 上游：<https://github.com/MetaCubeX/mihomo>，版本固定在 `kernel-manifest.json`。
- 许可证：**GPL-3.0**。分发内核二进制时必须同时提供许可证文本与对应源码获取方式。
  本仓库主体仍为 MIT，但组合分发物包含 GPL 组件，README 需明确说明。
- `sha256` 针对**解压后的可执行文件**。清单里为 `null` 时，`vendorKernel()` 会拒绝安装——
  不允许"先下载再信任"。

```bash
pnpm kernel:pin     # 首次固定：下载、解压、计算 sha256 并写回清单（需人工评审后提交）
pnpm kernel:fetch   # 按清单校验并解压到 node_modules/.checkcc-kernel
```

## 验证

```bash
pnpm test:netcore                       # 配置不变量 + 路由证据 + 产物校验 + 进程生命周期
node_modules/.checkcc-kernel/mihomo.exe -v
```

真实内核冒烟（不开启 TUN，避免提权）：生成配置 → 启动 → `/version` → 切换组 → 热加载 → 停止。
本仓库已在 Windows + mihomo v1.19.33 上完成该联调。

## 接入状态

内核已接入桌面生命周期：

1. `desktop/backend.mjs` 在应用启动时拉起内核，退出时先停内核再关闭页面与控制接口；停止未确认时会保留接口供重试。
2. `scripts/net-core/runtime.mjs` 负责配置生成、宿主探测、TUN 开关与导入后启动。导入节点或开启保护时若内核仍是 idle，会真正启动它，而不是只改状态位。
3. 界面「网络」页只在结论卡保留「复检路由」；启动 / 停止 / 重启内核收进「诊断与高级操作」，Tauri 层不暴露内核命令，全部经本机网关接口。

仍未完成：

- 页面尚未按 `tunCaptured` / `pinnedRouting` / `exitStability` / `asnClass` 重排权重。
- TUN 需要系统权限：macOS 使用系统密码 / Touch ID 授权，Windows 使用 UAC。当前已实现两平台应用内安装入口；本轮未验证 Windows 实机 UAC。手动安装仍可用 `pnpm kernel:host:install`。

在权重接入完成前，页面不应出现"已优化"之类的结论。

## 节点来源与导入

界面「网络 → 配置厂商」支持四种来源，每条来源保存成一条可命名的「供应商」：

| 方式 | 支持内容 | 说明 |
|---|---|---|
| 链接 | Clash 配置订阅（`proxies`）、ss / vmess / trojan / vless / anytls 分享链接、整体 base64 的链接列表 | 服务端抓取，http/https，4MB 上限 |
| 文件 | `.yaml / .yml / .txt / .conf / .json` | 读取后走与链接相同的解析 |
| 自定义 | 手工填写 ss / vmess / trojan / vless / anytls 单个节点 | 缺字段直接拒绝，不猜测 |
| 本地代理 | 本机已运行的 FlClash / Clash Verge 等端口 | 只探测端口，追加到当前配置，不读对方配置 |

供应商规则（`scripts/net-core/sources.mjs`）：

1. 一条供应商 = 名称 + 节点快照 + 更新时间；切换直接用快照，不依赖网络。
2. 同一订阅链接再次导入视为更新，不会产生重复条目。
3. 切换供应商会重建配置并重启内核（连接短暂中断），界面先确认再执行。
4. 删除当前供应商会切到下一条并重启；最后一条不能删，避免把内核留在空配置上。
5. 订阅地址、更新时间与「立即更新」只在配置弹窗里出现，不占网络页主阅读路径。

解析与校验规则（`scripts/net-core/subscription.mjs`）：

1. 自动识别 Clash YAML 与分享链接；无法识别时报错，不返回空结果。
2. 无效条目计入 `skipped` 并给出原因，不阻断有效条目。
3. 同名节点自动追加 ` #2`，避免内核因重名拒绝。
4. 导入先落盘再重启内核；**解析失败不会覆盖已有节点配置**。
5. 节点文件：`<state>/net-nodes.json`（原子写入，mode 600；供应商快照与当前节点都在这一份文件里）。

### 第三方机场（订阅）常见问题

- **同一链接按 UA 返回不同格式**：常见 FlClash/ClashMeta 给 Clash YAML，普通客户端给 base64 分享链接，甚至 `200 + HTML 错误页`。
  程序依次尝试 `SUBSCRIPTION_UA_PROFILES`（FlClash、ClashMetaForAndroid、Clash Verge、Clash for Windows、EnvGuardCC），
  **校验内容确实是 Clash 配置或分享链接**才采用；网络错误或格式不符会换下一个 UA，最后才回退本地代理。
  可用 `CHECKCC_SUBSCRIPTION_UA` 强制指定机场只放行的 UA。
- **anytls**：机场常用 `anytls://`；已支持解析，并和其它 TLS 节点一样补 `client-fingerprint`。
- **香港/中国大陆节点排在最前**：Claude 地区校验只允许支持地区；导入后请在「出口节点」里选台湾、新加坡、日本、韩国等。
  直接拿香港节点启动环境防护会被拒绝（`固定出口位于 Claude 不支持的地区：HK`）。
- **订阅拉取失败**：不会覆盖已有节点快照；没有可用配置时无法启动内核。失败原因会显示 HTTP 状态、UA/格式校验与本地代理尝试结果。
- **出口 IP 漂移**：界面会标注「出口稳定性 存在漂移」；同一国家内的 IP 变化只会警告（Claude 可能要求重新登录），
  不会像「出口变成不支持地区」那样直接阻断；严格模式才会对 IP 变化触发系统阻断。

**直接拒绝启动的情况**：没有可用节点 / 订阅拉取或解析失败且无旧配置 / 所选固定出口在 Claude 不支持地区 /
固定出口探测失败（节点不可达、网络中断）——最后一种在运行中会先阻断 Claude 并提示。

`GET /__checkcc/net-core` 只读状态；`POST /__checkcc/net-core` 执行 start/stop/restart/select；
`POST /__checkcc/net-core/import` 接收 `{mode:"url"|"content"|"manual"|"local-proxy", ...}`，
可选 `sourceId`（编辑已有供应商）与 `name`（供应商名称）。

供应商接口：`GET /__checkcc/net-core/sources` 列出；
`POST /__checkcc/net-core/sources` 接收 `{action:"activate"|"delete"|"rename"|"refresh", id, name?}`。
文件格式 v2：`{ version: 2, activeId, sources: [{ id, name, mode, url, proxies, selected, updatedAt, intervalHours }], proxies, selected, source, proxyServerDns }`；
旧版只有 `{ proxies, selected, source }`，读取时自动迁移成一条 `src_legacy` 供应商。

## 特权宿主安装（Windows / macOS）

普通权限下内核能启动但**建不了 TUN 网卡**（实测：API 可用、网卡列表无新增）。要真正接管流量，
需要一个常驻的特权宿主：

```bash
pnpm kernel:host:plan       # 只打印计划（写哪些文件、跑哪些命令）
pnpm kernel:host:install    # 需要管理员 / root，才会真正安装
pnpm kernel:host:uninstall  # 卸载
```

- **Windows**：计划任务 `EnvGuardCC-KernelHost`，`/RU SYSTEM /SC ONSTART`。安装时一次 UAC，之后日常运行免提权。
- **macOS**：`/Library/PrivilegedHelperTools/com.envguardcc.kernelhost.sh` + `/Library/LaunchDaemons/com.envguardcc.kernelhost.plist`（root:wheel），与现有系统时区服务同一套模式。

授权链路：

```
安装器（管理员）→ 令牌文件 <state>/host-token（0600）
宿主（SYSTEM/root）→ 读令牌，监听 127.0.0.1:39091
界面（普通用户）→ 读同一个令牌 → 调 POST /kernel {action, configPath}
```

宿主只接受 `start / stop / restart`，配置文件必须位于 `<state>/net-core/*.yaml`，非环回来源与错误令牌一律拒绝。
运行时启动时若探测到宿主健康（`GET /health` + 令牌），自动进入宿主模式；探测失败回退本机 spawn。

安装器将 Node、宿主脚本、依赖和 mihomo 复制到受管理员保护的独立版本目录（macOS 的 `PrivilegedHelperTools` 子目录，Windows 的 `Program Files/EnvGuardCC/KernelHost`），服务不再直接执行用户状态目录中的脚本。宿主校验配置真实路径、字段和控制器密钥，并在私有目录中运行验证后的快照。更新此代码后应重新安装宿主；仅重启界面不会升级系统服务。安装和授权路径仍需两平台实机验收。

### 不装宿主时怎么先测 TUN

在**管理员**终端里跑开发服即可（本机直连模式，内核继承管理员权限）：

```powershell
$env:CHECKCC_NET_CORE_TUN="1"; pnpm dev
```

## 出站模式（规则 / 全局 / 直连 / 仅 Claude）

| 模式 | 行为 | 典型用途 |
|---|---|---|
| `rule`（默认） | 局域网 + 内置国内域名直连，**其余海外流量走 `AUTO-PROXY` 故障转移组** | 日常使用：既上网又优化环境 |
| `global` | 内网豁免之外的非 Claude 流量走 `AUTO-PROXY` | 需要更大代理范围 |
| `direct`（界面：其他直连） | Claude 仍走固定组，其他流量直连 | 保留固定出口并缩小代理范围 |
| `claude` | 只代理 Claude 家族域名 | 最小化代理范围 |

- Claude 家族域名在**所有模式**下都置顶走专用组，并拒绝其 QUIC（UDP/443）。
- 非 Claude 流量在 rule/global 模式下由 `AUTO-PROXY` 兜底：单节点掉线时自动转移到下一个可用节点，
  不再出现「一个节点挂了、国外整体没网」。claude/direct 模式不生成该组，兜底为 `MATCH,DIRECT`。
- 规则模式**不依赖 GeoIP/GeoSite 数据文件**：使用内置国内域名清单（`CN_DIRECT_DOMAINS`），
  因此离线可用、启动不会被"下载 GeoSite.dat"卡住。未收录的国内站点会走节点（更慢但不会泄漏）。
- 切换模式会重建配置并重启内核；模式持久化在 `<state>/net-core-mode.json`。
- 内核提供本机代理端口（默认 `127.0.0.1:39080`），可直接作为系统代理使用；TUN 模式下则自动接管。

## 内网豁免配置（界面与接口）

「网络 → 内网直连（VPN / 公司网络）→ 配置」编辑 `<state>/net-core-network.json`，
字段与生成物见 [NETWORK-COMPATIBILITY.md](./NETWORK-COMPATIBILITY.md)。

- `GET /__checkcc/net-core/network` → `{ config, path, effective, problem, interfaces, pendingRestart, canRestart }`；
  `effective` 是真实产物（`domainRules` / `ipRules` / `nameserverPolicy` / `fakeIpFilter` / `redundantAddresses`），不是输入的复述。
- `POST /__checkcc/net-core/network`（`{ config, restart?: true }`）先试算再原子写盘；`restart` 时按 `stop → launch` 重建配置。
- 文件损坏时 GET 不报错，而是返回 `problem` 并把原文件回给界面，保证能靠重新保存覆盖坏文件。
- 网络声明不写进 `net-nodes.json`：节点属于订阅，网络声明属于「用户所在的网络」，两者分开可独立测试与回滚。

## 网络可观测面（sniffer / TLS 指纹 / STUN）

声明面（语言、区域、时区）由网关与迷惑层负责；**网络面**由内核负责，三者必须同源，
否则「声明说首尔、握手像上海」这种矛盾比单个信号更容易被识别。

| 能力 | 配置 | 不变量 |
|---|---|---|
| 域名识别 | `sniffer.enable` + `override-destination` + HTTP/TLS/QUIC 端口 | 必须开启且 override-destination，否则纯 IP 连接只能按 IP 分流 |
| TLS 握手特征 | 节点级 `client-fingerprint`（默认 `chrome`） | 所有做 TLS 握手的节点（vless/vmess/trojan/hysteria*/tuic 且 `tls !== false`）必须带指纹；用户显式值优先 |
| WebRTC 泄漏 | `AND,((NETWORK,udp),(DST-PORT,3478|5349|19302|19303)),REJECT` | rule/global/claude 模式必须存在；direct 模式不阻断 |

- `buildKernelConfig({ sniffer, blockStun, clientFingerprint })` 可显式关闭；关闭时
  `assertKernelConfig(config, { sniffer:false, blockStun:false, requireTlsFingerprint:false })`
  按同一开关校验，不允许「开关关了但断言还在」的半开状态。
- 这三项都经过真实 mihomo v1.19.33 `-t` 校验（含 Reality 节点 + UTLS 指纹）。

## 三层职责边界（不要把不同层混在一起）

| 层 | 负责 | 手段 | 改不了的部分 |
|---|---|---|---|
| 网络面 | 出口 IP/ASN、DNS 路径、QUIC/STUN、TLS 指纹 | 本内核 | **ASN/机房特征只能换节点**（实测当前出口为腾讯云 `hosting: true`） |
| 声明面 | `Accept-Language`、locale、UA-CH 一致性 | 网关改写 + CDP 覆盖 | 无（HTTPS 声明只能由客户端侧改写，不做 MITM） |
| 系统事实 | 字体列表、Emoji 字形、系统语言包 | 渲染页只读值拦截（字体） | **Emoji/字体渲染像素**：按 IP 伪造会与 UA 冲突（韩国用户同样用 Windows），因此不伪造 |

### 声明面归一化（网关）

`buildHeaders()` 在模拟保护开启时除改写 `accept-language` 外，还会调用 `alignClientHints()`：

- `sec-ch-ua-platform` / `sec-ch-ua-mobile` 由 **UA 推出的平台**决定（不按出口国家伪造平台）；
- `sec-ch-ua` 的品牌版本与 UA 主版本对齐，`Not?A_Brand` 保留原版本号；
- 客户端没发 `sec-ch-ua` 时不凭空补头；
- 关闭模拟保护时全部原样转发。

`/__checkcc/status` 的 `headerAlignment` 给出 `{ platform, hintPlatform, major, hintMajor, aligned }`，`aligned=false` 表示声明面仍自相矛盾。
