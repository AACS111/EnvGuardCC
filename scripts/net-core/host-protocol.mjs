// 界面与特权宿主的协议协商。
//
// 为什么需要协商：宿主是常驻进程（Windows 计划任务 / macOS LaunchDaemon），
// 应用升级后旧宿主可能还在跑。它的 /health 会通过，但缺少新动作。
// 此时若继续把动作发给它，动作会失败并发起「本机权限」降级执行；
// 在 Windows 上那条路必然报 System Error 5（拒绝访问），
// 用户看到的是权限错误，真实原因其实是「宿主太旧」。
//
// 所以：认不出版本字段（升级前的宿主）一律算过旧，交给应用内授权安装更新。

// v6 requires the persistent Windows task settings and effective rule validation.
export const HOST_PROTOCOL = 6;

/** 界面依赖的宿主动作；缺少任何一个都必须重新授权安装。 */
export const HOST_CAPABILITIES = ["ipv6", "owner-lease", "claude-guard", "claude-direct-guard"];

/**
 * 解析 /health 返回值，判断宿主是否够新。
 * @param {unknown} value 宿主 /health 的 JSON
 */
export function checkHostHealth(value) {
  const protocol = Number(value?.hostProtocol ?? 0) || 0;
  const capabilities = Array.isArray(value?.capabilities)
    ? value.capabilities.filter((item) => typeof item === "string" && item)
    : [];
  const missing = HOST_CAPABILITIES.filter((name) => !capabilities.includes(name));
  return {
    ok: protocol >= HOST_PROTOCOL && missing.length === 0,
    protocol,
    required: HOST_PROTOCOL,
    capabilities,
    missing,
  };
}

/**
 * 开启保护时该不该弹系统授权安装宿主。
 * 抽成纯函数是为了让「该弹/不该弹」可被测试覆盖，不依赖跑测试的机器是否已提权。
 *
 * @param {{ hostMode?: boolean, platform?: string, elevated?: boolean, disabled?: boolean, failure?: string|null }} input
 * @returns {{ action: "none"|"install"|"fail", reason: string }}
 */
export function hostInstallDecision({ hostMode = false, platform = process.platform, elevated = false, disabled = false, failure = null } = {}) {
  if (hostMode) return { action: "none", reason: "host-ready" };
  if (!["darwin", "win32"].includes(platform)) return { action: "none", reason: "unsupported-platform" };
  if (disabled) return { action: "none", reason: "install-disabled" };
  if (failure) return { action: "fail", reason: failure };
  // 已经是管理员时本机权限就够（开发机/管理员终端），不要多弹一次授权。
  if (elevated) return { action: "none", reason: "already-elevated" };
  return { action: "install", reason: "needs-privilege" };
}
