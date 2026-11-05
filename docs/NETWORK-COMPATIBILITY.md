# 内网与公司 VPN 兼容

网络内核默认保留回环、RFC 1918 私网和链路本地地址的原有路由，支持系统 hosts，标准本地域名使用系统 DNS。Claude 域名仍优先使用专用出口。

企业自定义域名无法仅从名称可靠识别，公共代码不内置任何公司域名或公司 DNS。需要企业分流时，在应用状态目录创建 `net-core-network.json`：

```json
{
  "directDomains": ["corp.example"],
  "dnsServers": ["10.20.0.53"],
  "routeExcludeAddresses": ["203.0.113.9", "100.64.1.0/24"]
}
```

域名填写后缀即可，包含该域名及其子域名，不写 URL、端口或通配符。每个后缀会同时生成直连规则、DNS 分流和 Fake-IP 排除，优先于订阅规则；不得与 Claude 置顶域名重叠。

`routeExcludeAddresses` 是可选的 TUN 路由排除列表，支持单个 IPv4 地址及 CIDR 网段。单个地址转换为 `/32`，CIDR 归一化到网络地址，重复条目会合并，并始终保留默认私网排除项。所有出站模式下生效，匹配的 IP 沿操作系统原有路由发送，不进入 TUN。当前内核关闭 IPv6，因此只接受 IPv4。禁止排除覆盖 Fake-IP 网段的地址范围，防止破坏域名代理接管。示例中的地址为文档示例，请替换为实际需要的地址。

TUN 路由排除本身不处理显式 HTTP/SOCKS 代理。因此用户配置的 IP 还会生成对应直连规则，位于 Claude 置顶规则之后、通用私网及订阅规则之前。使用域名时还需正确的 DNS 与 `directDomains` 配置；Fake-IP 无法按服务真实 IP 匹配系统路由排除。IP 排除也不会解除 Windows `strict-route` 对其他网卡 DNS 查询的限制。

`dnsServers` 可省略，默认使用系统 DNS。公司网络建议显式填写管理员提供的 DNS 地址，例如 `10.20.0.53`。Mihomo 为 `directDomains` 指定的域名代转 DNS，显式解析器默认附加 `#DIRECT`，即使全局代理模式也不会送往代理节点；已有的 `#` 参数保持用户配置。其他域名继续按原 DNS 策略解析。此设置也用于直连连接的解析。不要把 TUN 的 Fake-IP DNS 地址填入此处。

若自动网卡检测使公司 DNS 查询绑定普通网卡，可增加 `"dnsInterface": "Company VPN"`，填入系统实际 VPN 网卡名称。此时会创建只用于内网 DNS 的直连出站，将查询绑定该网卡，不加入 Claude 可选出口组。需使用显式 `dnsServers` 地址，不能使用 `system` 或同时填写 `#` 参数。更换 VPN 或网卡名称后需同步修改。

若应用显式使用 HTTP/SOCKS 代理，服务连接也可能被自动绑定到普通网卡。可设置 `"directInterface": "Company VPN"`，让 `directDomains` 和自定义 IP 的直连连接使用指定网卡；DNS 默认跟随此网卡，仍可通过 `dnsInterface` 单独覆盖。标准本地域名的默认规则和 Claude 出口组不变。这些本地直连出站不会作为代理节点供 Claude 选择。

公司 VPN 的完整示例（将域名、DNS、服务 IP 和网卡名替换为实际配置）：

```json
{
  "strictRoute": true,
  "directDomains": ["corp.example"],
  "dnsServers": ["10.20.0.53"],
  "directInterface": "Company VPN",
  "routeExcludeAddresses": ["203.0.113.9"]
}
```

Windows 上，`strict-route` 的 DNS 防泄漏限制会阻止其他进程通过公司 VPN 网卡直接查询内网 DNS，即使配置了私网路由排除。推荐保持 `strictRoute: true`，配合 `directDomains`、显式公司 `dnsServers` 和 `routeExcludeAddresses`：应用通过 TUN 的 DNS 获取解析，由有权限的 Mihomo 内核代转到指定解析器，服务流量通过排除路由直达。普通进程直接访问外部 DNS 仍受限制。这不是给任意进程添加 WFP 防火墙白名单，无法豁免写死外部 DNS 的第三方客户端。

`strictRoute` 默认 `true`。仅在确实需要兼容第三方直接 DNS 查询时才可显式设为 `false`；这会放宽整机 Windows DNS 防泄漏限制，不属于精确 IP 例外方案，不会自动开启。

状态目录由 `CHECKCC_STATE_DIR` 指定；开发模式默认为 `node_modules/.checkcc-local`，桌面模式为应用用户数据目录下的 `state`。也可在启动应用前设置 `CHECKCC_NET_CORE_NETWORK_CONFIG`，指向状态目录以外的本地 JSON 文件。

用户配置不应提交到仓库。不要编辑生成的 `net-core/config.yaml`，它会在内核启动或配置重建时覆盖。修改用户配置后停止并重新启动网络内核；内网文件会在生成配置时重新读取。

配置文件缺失时使用通用默认值；显式指定的文件缺失、JSON 损坏、未知字段或无效字段值会阻止本次内核启动并报告原因，不会静默忽略。

## 排查与边界

1. 先关闭本项目代理，确认公司网络/VPN 本身能够访问目标服务。
2. 开启代理后，检查生成配置是否包含目标后缀的 DIRECT、nameserver-policy 和 fake-ip-filter。
3. 检查公司 DNS 是否可达、目标解析结果是否正确，并清理应用与操作系统的旧 DNS 缓存。

标准私网路由兼容不等于能够自动发现所有企业域名。未知后缀、企业使用的公网地址及复杂的多 VPN 分流仍需显式配置与实际网络验证。全局代理模式默认代理未声明的域名；声明为内网的域名在所有模式下直连。

## 界面配置（推荐方式）

网络页「内网直连（VPN / 公司网络）」区块的「配置」按钮可直接编辑上述 `net-core-network.json`，无需手改文件：

- 「域名后缀」= `directDomains`，「IP / CIDR」= `routeExcludeAddresses`，「DNS 解析」与「网卡」对应 `dnsServers` / `dnsInterface` / `directInterface`，另有 `strictRoute` 开关。
- 每添加一条会用人话说清它意味着什么（例如「所有子域名都走直连」），落在默认私网段里的地址标注为冗余，只提示、不拦保存；原始规则语法（`DOMAIN-SUFFIX,…` / `IP-CIDR,…`）只出现在「查看生成的规则（高级）」折叠里。
- 保存前服务端会用与启动相同的 `buildKernelConfig` + `assertKernelConfig` 试算，非法值返回具体原因且**不写盘**；文件仍是唯一真相（原子写、权限 0600）。
- 「保存」只落盘并标记待重启；「保存并重启内核」才会重建配置并重启，让改动立即生效。内核未运行时该按钮禁用。
- 对应接口：`GET /__checkcc/net-core/network` 读取配置与真实产物，`POST /__checkcc/net-core/network`（body `{ config, restart?: true }`）保存。

### 测试解析

域名区提供「测试解析」：由内核代查一次该域名，直接用结论回答「这份配置够不够」。

- 返回真实内网地址（如 `192.168.6.114`）→ 域名已豁免，DNS 不用再填；
- 返回 `198.18.x` 假地址 → 该域名仍在走代理，多半是域名没填对；
- 无解析结果（NXDOMAIN）→ 需要填写内网 DNS，或域名拼写有误。

实测说明：**普通进程直接向 `10.10.10.5` 查询在 strict-route 下会超时**，只有内核能代查；因此测试走内核 `/dns/query`，并会在草稿与生效配置不一致时先保存并重启内核（结果会标注这一点）。
