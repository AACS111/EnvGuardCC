# FlClash 真实 GUI 联动验证

2026 年 10 月 31 日，Apple Silicon / macOS 27.0。本轮在用户实际使用的 FlClash 0.9.2 上完成一次真实 GUI 联动，不使用隔离目录、模拟内核或代替出口。

## 环境

| 项目 | 实际值 |
| --- | --- |
| FlClash | 0.9.2，`/Applications/FlClash.app` |
| 内核 | `FlClashCore`，`v1.19.33`，127.0.0.1:9090 外部控制 |
| 当前 profile | `profiles/<id>.yaml`（数字 ID 已隐去），原始 SHA-256 `1ab4e642…` |
| 系统代理 | `127.0.0.1:7890`，TUN 关闭 |
| 回程策略 | `Kuromis` |
| 生成路由 | 15 条，回程端口 39100–39114 |

## 步骤与结果

1. **真实 profile 发现**：`defaults read com.follow.clash flutter.config` 返回当前 profile id，解析为 `profiles/<id>.yaml`。这是之前只用隔离目录模拟、从未在真实安装上跑过的路径，本轮通过。
2. **开启外部控制器后的配置延迟**：运行中的内核立即监听 `127.0.0.1:9090`，但 `config.yaml` 仍是旧值（`external-controller: ""`、`secret: ""`），直到 FlClash 重新应用或重启才写入。EnvGuardCC 优先读 `config.yaml`；本轮已加偏好回退，`config.yaml` 为空时从 `defaults` 读取控制器。
3. **准备**：`prepareTrafficConfig` 读取真实 profile，生成 15 条路由和备份；profile 文件未被修改（哈希仍为原值）。
4. **写入联动配置**：profile 变为 `13d6fed5c85456ea06db94108dde96ef81d874fb7d1e92553d14a5d2c69bda21`，状态 `phase=awaiting_reload`。
5. **FlClash GUI 重新应用**：退出并重新打开 FlClash。重开后 `autoRun=false`，内核处于“未运行”，需点播放按钮（或 `Ctrl+Alt+S`）启动。启动后：
   - FlClash 生成的 `config.yaml` **保留 15 个 `checkcc-return-*` listeners**；
   - 内核监听 7890 与 39100–39114；
   - `trafficStatus().runtimeVerified === true`。
6. **真实流量**：
   - `http://example.com/` 与 `https://example.com/` 均 HTTP 200、577 字节；
   - `https://claude.ai/` HTTP 403、5304 字节（Cloudflare 反爬，非链路失败）；
   - 拦截层统计 `tunnels` 8 → 25，`failed: 0`，`denied: 0`；
   - 控制器 `/connections` 成对出现：15 条首跳 `[EnvGuardCC-57a56de61b12bdeb]` 对应 15 条回程 `[🇺🇸 United States 02, 🇺🇸 United States, Kuromis]`；Google 4 对、OpenAI 1 对同理。回程没有再进入 EnvGuardCC，未形成环路。
7. **恢复**：写回原 profile；FlClash 重载后 `restoreTrafficConfig` 核验 EnvGuardCC 代理与回程端口均已消失，profile 哈希回到 `1ab4e642…`；7890 仍可用；测试拦截层停止，3011 关闭。

## 结论

- 真实 FlClash GUI 路径可用：应用层生成运行配置时会保留 `listeners`，内核会创建回程端口，流量按“原分流规则 → EnvGuardCC → 原策略组”转发，恢复可核验。
- 出口仍是 FlClash 原策略组（本轮为 `Kuromis → 🇺🇸 United States → US 02`），没有使用 Surge 或其他替代出口。
- 之前的隔离内核验证结论成立；本轮补上了缺失的应用层与真实 profile 发现路径。

## 发现的问题

1. **外部控制器写入延迟**：开启后 `config.yaml` 不立即更新，EnvGuardCC 读到的仍是空值。已加回退：`config.yaml` 没有控制器时从 FlClash 偏好（`defaults` / `shared_preferences.json`）读取；联动本身仍需一次重新应用。
2. **重启后内核未运行**：`autoRun=false` 时，退出重开只完成配置应用，不自动启动监听。此时 `trafficStatus` 仍报告 `applied=true, runtimeVerified=false`；本轮已把提示语改为“重新应用并启动当前配置（确认内核处于运行状态）”，未做自动探测区分。
3. **状态字段**：核验成功后 `phase` 仍为 `awaiting_reload`；仅影响状态展示，不影响恢复。
4. **未覆盖**：多 profile 切换、订阅更新冲突、TUN、UDP、Windows 实机。

## 清理

测试状态目录已删除；用户 profile 已恢复；系统代理 7890 正常；测试拦截层已停止。验证期间生成的截图和临时副本已删除，未记录订阅地址、节点凭据或控制器密钥。
