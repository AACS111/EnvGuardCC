# 网络类型数据说明

## 当前实现

应用已有的出口情报源会返回 IP 所属的 ASN 和组织名称。客户端离线查询 `src/detection/hosting-asns.json`，对命中项按“机房网络（推断）”展示；缺少 ASN 时仍可按已有组织名称规则推断。没有命中不代表住宅网络。ASN 是网络运营主体，不是某个 IP 的用途或地理位置证明，托管、云和内容分发网络也不等于 VPN。

快照来自 [ipverse/as-metadata](https://github.com/ipverse/as-metadata)，固定提交 `8c5b85d0bca59c66accbfc0a44680d444e06d52b`，提交时间 2026-10-31 UTC。仅提取上游标为 `hosting` 的 ASN 和组织名，共 11,873 条；上游数据许可为 CC0 1.0。上游将该类别用于托管、云或内容服务，并说明分类反映网络的主要用途，可能有误。上游注册国家不等于 IP 的实际出口国家。

例如，这份快照包含 Amazon AS16509（美国注册）、LeaseWeb AS16265 和 Hetzner AS24940（欧洲注册）、SAKURA Internet AS9370（日本注册）、GMO Internet AS59349 和 Contabo Asia AS141995（新加坡注册）。实际 IP 到 ASN 的对应关系仍取决于本次出口情报源，ASN 和组织结果不一致时应复核。

静态快照不会自动随网络归属变化而更新，也不能覆盖所有服务商；运行时不会因为此功能另行上传出口 IP 或请求 ipverse。继续使用数据前应定期更新并核对分类。任何判断均不是账号访问能力或封禁概率的证明。

## 其他查到的数据源

- [ipverse/as-ip-blocks](https://github.com/ipverse/as-ip-blocks)：每日更新各 ASN 当前公告的 IPv4、IPv6 网段，CC0。网段反映 BGP 宣告关系，不能直接证明具体 IP 为机房或住宅。
- [AWS IP 地址范围](https://docs.aws.amazon.com/vpc/latest/userguide/aws-ip-ranges.html)：AWS 发布区域与服务对应的网段；官方说明不包含全部服务和客户自带 IP，区域也不总是物理位置。
- [IPLocate IP to ASN](https://github.com/iplocate/ip-address-databases)：提供免费的 IP 到 ASN 网段库，采用 CC BY-SA 4.0 并要求署名；IP 类型数据属于另行提供的产品。当前应用未内置这份数据。
- [MaxMind GeoIP Anonymous IP](https://dev.maxmind.com/geoip/docs/databases/anonymous-ip/)：商业数据库提供 hosting provider 等 IP 网段字段，须根据购买许可使用；当前应用未接入。
- [IANA IPv4 特殊用途地址表](https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml)和 [IPv6 特殊用途地址表](https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml)：用于区分共享、私有、链路本地和文档等地址；特殊用途不等于机房地址。

## 手动更新快照

1. 确定并核对 [ipverse/as-metadata](https://github.com/ipverse/as-metadata) 的目标提交 SHA。
2. 从该提交下载 `as.json`，例如 `https://raw.githubusercontent.com/ipverse/as-metadata/<提交 SHA>/as.json`。
3. 执行 `node scripts/build-hosting-asns.mjs <as.json 路径> <提交 SHA>`。脚本只读取本地文件，并将原始数据 SHA-256 与提交 SHA 写入快照。
4. 检查新增和移除的分类、运行 `node --test scripts/check-network-type.cjs scripts/check-gateway-model.cjs`，并更新本文的快照日期、提交和数量。
