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

pnpm traffic:restore 恢复备份并移除由本工具创建且未被改写的自启动项，再在 FlClash 重新应用配置。工具会检查文件哈希，拒绝覆盖外部更新。配置切换或订阅刷新后需要重新准备；不会静默覆盖新的订阅。内核全局模式、其他 VPN、未进入 FlClash 的程序和用户主动改写配置不属于此规则的强制范围。

测试：pnpm test:traffic。包括域名/IP/CIDR、逻辑子规则、原策略保留、HTTP 认证、CONNECT 字节透传、回环拒绝和失败时无直连回退。
