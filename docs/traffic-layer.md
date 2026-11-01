# FlClash 全应用流量拦截

链路：应用或 TUN → FlClash 路由规则 → EnvGuardCC 本机认证代理 3011 → FlClash 专用回程 39100 → 原 Overseas 策略组 → 原节点。

所有原本选择代理策略的 TCP 流量都先经过 EnvGuardCC。保留原 DIRECT、REJECT 及原节点配置，不会将回程重新送回同一条分流规则。拦截层或回程不可用时拒绝连接；不回退直连。HTTP CONNECT 保留 HTTPS 加密，不安装根证书，不解密账号请求。普通应用的语言、字体及加密请求头不会因隧道转发而被改写；浏览器接口保护需要使用助手启动的受保护窗口。应用配置后，受保护窗口中的 HTTP/HTTPS 页面都安装接口策略。

HTTP 代理不承载 UDP：原本走海外代理策略的 UDP 会不可用，QUIC 应用需回退 TCP；原直连规则下的 UDP 不改动。这里不宣称支持 UDP 内容拦截。TUN 是否启用仍以 FlClash 实际运行状态为准。

## 设置域名和 IP

编辑 node_modules/.check-cc-local/traffic-settings.json。sites.domains 是域名后缀列表，sites.ips 是 IPv4/IPv6 地址列表，sites.cidrs 是网段列表。例如：

```json
{
  "listenPort": 3011,
  "upstreamBasePort": 39100,
  "defaultPolicy": "Overseas",
  "allOverseas": true,
  "sites": {
    "domains": ["claude.ai", "anthropic.com", "example.com"],
    "ips": ["203.0.113.10"],
    "cidrs": ["198.51.100.0/24", "2001:db8::/32"]
  }
}
```

示例地址是文档保留地址，请替换为实际目标。IP 规则是目标 IP，不能改变代理出口公网 IP。精确匹配 IP 的域名访问需要 FlClash 获得真实目标 IP；fake-IP 模式下优先添加域名规则，不额外强迫本地解析目标域名。127.0.0.0/8 和 ::1 保留直连以避免代理循环。

修改后运行 pnpm traffic:prepare，再 pnpm traffic:apply，然后在 FlClash 重新应用并启动当前配置。apply 前必须有已验证的拦截入口；pnpm traffic:serve 可独立启动。开发启动器会启动或复用已应用的拦截入口。Windows 应用时同时添加当前用户隐藏自启动入口，避免重启后本机代理缺席。

pnpm traffic:status 查看保存状态；这不等于内核已重载。运行时统计需以经过认证的 /__checkcc/traffic/status 为准，不记录目标 URL、账号、正文或代理密码。

## 回滚与边界

正常退出时，EnvGuardCC 会先解除联动并核验 FlClash 运行状态，再关闭本机入口。配置文件已经不含联动且运行中的内核也没有联动规则和回程端口时，会保留当前文件并直接完成恢复。

如果联动期间 FlClash 配置发生变化：

1. 可以安全区分修改时，选择“保留更改并解除联动”。程序先保存当前文件和恢复所需备份，再仅撤销能够确认属于 EnvGuardCC 的部分。
2. 如果配置项或规则发生冲突、使用了无法安全还原的结构，程序不会自动覆盖。界面会显示变化的字段和备份位置；如选择“恢复联动前备份”，需要再次确认，这会替换当前配置，但当前版本会先保存一份。
3. 若提示重新应用配置，请在 FlClash 中重新应用并启动当前配置，再返回选择“检查并退出”。此时 EnvGuardCC 的本机入口保持运行，直到检查确认内核不再使用联动。
4. 如果内核或控制器不可用，请打开 FlClash 并检查仅本机、带认证的控制器，再重新检查。无法核验时不会报告恢复成功。

开发环境也可运行 `pnpm traffic:restore`；有外部修改时，使用应用界面查看并选择恢复方式。配置切换或订阅刷新后需要重新准备联动。Windows 和 macOS 的退出核验都需要可用的 FlClash 本机控制器；Windows 上只移除由本工具创建且未被改写的自启动项。内核全局模式、其他 VPN 和未进入 FlClash 的程序不属于此规则的强制范围。

测试：pnpm test:traffic。包括域名/IP/CIDR、逻辑子规则、原策略保留、HTTP 认证、CONNECT 字节透传、回环拒绝和失败时无直连回退。
