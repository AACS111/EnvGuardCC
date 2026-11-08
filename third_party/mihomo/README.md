# Mihomo

项目内置网络内核来自 [MetaCubeX/mihomo](https://github.com/MetaCubeX/mihomo)，固定版本见 `scripts/net-core/kernel-manifest.json`。

Mihomo 采用 GPL-3.0，完整许可证见同目录 `LICENSE`。对应版本源码位于 https://github.com/MetaCubeX/mihomo/tree/v1.19.33 ，源码归档可从 https://api.github.com/repos/MetaCubeX/mihomo/tarball/v1.19.33 获取。内核未做源码修改；项目通过独立进程及本地控制器 API 与其通信。

开发时内核放在 `node_modules/.checkcc-kernel`，不将平台二进制提交到 Git。开发启动器自动准备并校验内核；桌面构建将当前平台的已校验内核和本目录许可证一起打包，运行时不需要另行安装 Mihomo 或 Clash。
