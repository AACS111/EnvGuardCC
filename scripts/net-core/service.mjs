// 特权宿主的安装计划：只生成"要写哪些文件、跑哪些命令"，不在这里执行。
// 真正的安装需要用户明确同意（安装器运行时已是管理员；开发期用 --apply）。
//
// Windows：计划任务，开机以 SYSTEM 运行宿主（无需包装成服务二进制）。
// macOS  ：/Library/PrivilegedHelperTools + /Library/LaunchDaemons，复用现有特权助手模式。

import path from "node:path";

export const HOST_LABEL = "com.envguardcc.kernelhost";
export const HOST_TASK = "EnvGuardCC-KernelHost";

// bootout 返回时旧作业可能还在退出；此时立即 bootstrap 会得到错误 5。
export async function waitForMacHostUnload({ run, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 40 } = {}) {
  try { await run("launchctl", ["bootout", `system/${HOST_LABEL}`]); } catch { /* 下面核实是否已卸载 */ }
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { await run("launchctl", ["print", `system/${HOST_LABEL}`]); }
    catch (error) {
      // launchctl 的“不存在”退出码；权限/执行失败不能冒充卸载成功。
      if ([3, 113].includes(Number(error.code ?? error.status))) return;
      throw error;
    }
    await pause(250);
  }
  throw new Error("旧系统助手仍在退出，尚未重新加载。请稍后重试；没有把安装报告为成功。");
}

function quote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}
const posix = value => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * @param {object} options
 * @param {string} options.platform win32 | darwin
 * @param {string} options.nodePath Node 可执行文件
 * @param {string} options.hostScript host.mjs 的绝对路径
 * @param {string} options.stateDir 状态目录（令牌与配置都在里面）
 * @param {string} options.binary 内核二进制路径
 * @param {number} [options.apiPort]
 * @param {number} [options.port] 宿主监听端口
 */
export function buildHostInstallPlan({ platform = process.platform, nodePath, hostScript, stateDir, binary, apiPort = 39090, port = 39091 } = {}) {
  if (!nodePath || !hostScript || !stateDir || !binary) throw new Error("安装计划缺少必要路径。");
  const paths = platform === "win32" ? path.win32 : path.posix;
  const tokenFile = paths.join(stateDir, "host-token");
  const args = ["--state-dir", quote(stateDir), "--token-file", quote(tokenFile), "--binary", quote(binary), "--api-port", String(apiPort), "--port", String(port)];

  if (platform === "win32") {
    for (const value of [nodePath, hostScript, stateDir, binary]) {
      if (/["%\r\n\0]/.test(value)) throw new Error("Windows 宿主路径不得包含引号、百分号或换行。");
    }
    // schtasks 的 /TR 值上限是 261 字符，整条命令很容易超限；
    // 因此生成一个短路径包装脚本，计划任务只指向它。
    const launch = paths.join(paths.dirname(hostScript), "host-launch.cmd");
    if (launch.length > 200) throw new Error(`包装脚本路径过长（${launch.length} 字符），请使用更短的状态目录。`);
    const launchContent = ["@echo off", "setlocal DisableDelayedExpansion", 'set "NODE_OPTIONS="', 'set "NODE_PATH="', `${quote(nodePath)} ${quote(hostScript)} ${args.join(" ")}`, ""].join("\r\n");
    return {
      platform,
      files: [{ path: launch, content: launchContent, mode: 0o644, note: "计划任务指向该短路径脚本；/TR 有 261 字符上限" }],
      commands: [
        { note: "启动脚本不继承用户目录权限。", cmd: "icacls.exe", args: [launch, "/inheritance:r", "/grant:r", "*S-1-5-18:F", "*S-1-5-32-544:F", "/Q"] },
        { note: "所有者固定为管理员组，普通用户不能更改 DACL。", cmd: "icacls.exe", args: [launch, "/setowner", "*S-1-5-32-544", "/Q"] },
        {
          note: "以 SYSTEM 身份、开机自动运行内核宿主。安装时需要管理员权限。",
          cmd: "schtasks.exe",
          args: ["/Create", "/TN", HOST_TASK, "/SC", "ONSTART", "/RU", "SYSTEM", "/RL", "HIGHEST", "/TR", quote(launch), "/F"],
        },
        { note: "安装后立即启动一次，无需重启系统。", cmd: "schtasks.exe", args: ["/Run", "/TN", HOST_TASK] },
      ],
      uninstallCommands: [
        { cmd: "schtasks.exe", args: ["/End", "/TN", HOST_TASK], optional: true },
        { cmd: "schtasks.exe", args: ["/Delete", "/TN", HOST_TASK, "/F"] },
        { cmd: "cmd.exe", args: ["/c", "del", "/f", quote(launch)], optional: true },
      ],
      tokenFile,
      launchFile: launch,
      notes: [
        "授权前由当前用户生成令牌；Windows 的访问权限依赖用户状态目录 ACL，不能用 POSIX 0600 代替。",
        "计划任务只允许本机访问宿主端口，令牌缺失或不匹配一律拒绝。",
      ],
    };
  }

  if (platform === "darwin") {
    const helper = `/Library/PrivilegedHelperTools/${HOST_LABEL}.sh`;
    const plist = `/Library/LaunchDaemons/${HOST_LABEL}.plist`;
    const script = [
      "#!/bin/sh",
      `exec /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=/var/root ${[nodePath, hostScript, "--state-dir", stateDir, "--token-file", tokenFile, "--binary", binary, "--api-port", apiPort, "--port", port].map(posix).join(" ")}`,
      "",
    ].join("\n");
    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${HOST_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${helper}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>UserName</key><string>root</string>
  <key>StandardErrorPath</key><string>/var/log/${HOST_LABEL}.log</string>
</dict>
</plist>
`;
    return {
      platform,
      files: [
        { path: helper, content: script, mode: 0o755, note: "root:wheel 755，用户态不可写" },
        { path: plist, content: plistContent, mode: 0o644, note: "launchd 以 root 执行宿主" },
        { path: "/Library/PrivilegedHelperTools/com.envguardcc.kernel-recover", content: `#!/bin/sh\nexec /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=/var/root ${[nodePath, hostScript, "--recover-network"].map(posix).join(" ")}\n`, mode: 0o755, note: "独立网络恢复工具；不依赖应用页面或节点配置" },
      ],
      commands: [
        { note: "清除之前停用助手留下的禁用状态。", cmd: "launchctl", args: ["enable", `system/${HOST_LABEL}`] },
        { note: "加载特权守护进程（需要 sudo）。", cmd: "launchctl", args: ["bootstrap", "system", plist] },
      ],
      uninstallCommands: [
        { cmd: "launchctl", args: ["bootout", "system", plist] },
        { cmd: "rm", args: ["-f", plist, helper, "/Library/PrivilegedHelperTools/com.envguardcc.kernel-recover"] },
      ],
      tokenFile,
      notes: [
        "复用与系统时区服务相同的特权助手模式：root:wheel、用户目录只保留脚本副本。",
        "安装前必须校验脚本与 plist 的哈希，避免被替换。",
      ],
    };
  }

  throw new Error(`暂不支持的平台：${platform}（当前只提供 Windows 与 macOS 宿主）。`);
}

export function describePlan(plan, { locale = "zh" } = {}) {
  const zh = String(locale).startsWith("zh");
  const lines = [];
  for (const file of plan.files) lines.push(`${zh ? "写入" : "Write"} ${file.path} (${file.note})`);
  for (const step of plan.commands) lines.push(`${zh ? "执行" : "Run"} ${step.cmd} ${step.args.join(" ")}`);
  return lines.join("\n");
}
