// 提权探测：TUN 需要管理员/root 才能建立虚拟网卡。
// 这里只做"是否已提权"的只读判断，不尝试自行提权——自行提权需要的是一套受控的安装器流程，
// 而不是在运行时调用系统提权 API（那会绕过用户的明确确认）。

import { execFileSync } from "node:child_process";

export function isElevated({ platform = process.platform, run = execFileSync } = {}) {
  if (platform === "win32") {
    try {
      run("net", ["session"], { stdio: "ignore", windowsHide: true, timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }
  if (platform === "darwin" || platform === "linux") {
    return typeof process.getuid === "function" && process.getuid() === 0;
  }
  return false;
}

/** 供界面展示的权限状态与建议。 */
export function elevationStatus({ platform = process.platform, elevated } = {}) {
  const value = elevated ?? isElevated({ platform });
  const instruction = platform === "win32"
    ? "以管理员身份重新启动 EnvGuardCC 后，TUN 才会接管系统流量。"
    : platform === "darwin"
      ? "macOS 需要安装特权助手（与系统时区服务同一套授权流程）才能创建 TUN。"
      : "Linux 需要 root 或 CAP_NET_ADMIN 才能创建 TUN。";
  return { elevated: value, platform, instruction };
}
