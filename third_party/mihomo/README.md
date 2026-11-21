# Mihomo

项目内置网络内核来自 [MetaCubeX/mihomo](https://github.com/MetaCubeX/mihomo)，固定版本见 `scripts/net-core/kernel-manifest.json`。

Mihomo 采用 GPL-3.0，完整许可证见同目录 `LICENSE`。对应版本源码位于 https://github.com/MetaCubeX/mihomo/tree/v1.19.33 ，源码归档可从 https://api.github.com/repos/MetaCubeX/mihomo/tarball/v1.19.33 获取。内核未做源码修改；项目通过独立进程及本地控制器 API 与其通信。

开发时内核放在 `node_modules/.checkcc-kernel`，不将平台二进制提交到 Git。开发启动器自动准备并校验内核；桌面构建将当前平台的已校验内核和本目录许可证一起打包，运行时不需要另行安装 Mihomo 或 Clash。

## 离线中国 IP 数据

`scripts/net-core/china-routes.mjs` 内嵌 MetaCubeX/meta-rules-dat 的 `geo/geoip/cn.list`，数据许可证为 GPL-3.0，完整许可证见本目录 `LICENSE`。该数据文件单独遵循上游许可，不改变本项目其他源码的许可证。

- 来源：[固定提交的 cn.list](https://github.com/MetaCubeX/meta-rules-dat/blob/39ef714731b5523b471d6868f8e3e6e83d915611/geo/geoip/cn.list)
- 提交：`39ef714731b5523b471d6868f8e3e6e83d915611`；包含 6217 条 IPv4、3423 条 IPv6 网段。
- SHA-256（CIDR 以 LF 分隔，末尾保留一个 LF）：`d308cc97fd9222c5b66a5e71790f4f508a59b0a7a574dc04778dcf21ea49e6e6`。
- 改动：转换为 JavaScript 字符串数组，CIDR 内容未改变；只有规则模式引用，IPv6 规则只在双栈启用时生成。
- 更新方式：选定并记录新的上游提交，替换数据内容，更新本节数量及哈希，运行 `node --test scripts/check-proxy-routing.mjs scripts/check-kernel-config.mjs` 并用 Mihomo `-t` 检查生成配置。应用启动时不下载或更新该数据。
