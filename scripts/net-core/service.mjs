// 特权宿主的安装计划：只生成"要写哪些文件、跑哪些命令"，不在这里执行。
// 真正的安装需要用户明确同意（安装器运行时已是管理员；开发期用 --apply）。
//
// Windows：计划任务，开机以 SYSTEM 运行宿主（无需包装成服务二进制）。
// macOS  ：/Library/PrivilegedHelperTools + /Library/LaunchDaemons，复用现有特权助手模式。

import path from "node:path";

export const HOST_LABEL = "com.envguardcc.kernelhost";
export const HOST_TASK = "EnvGuardCC-KernelHost";

function quote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

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
  const tokenFile = path.join(stateDir, "host-token");
  const args = ["--state-dir", quote(stateDir), "--token-file", quote(tokenFile), "--binary", quote(binary), "--api-port", String(apiPort), "--port", String(port)];

  if (platform === "win32") {
    // schtasks 的 /TR 值上限是 261 字符，整条命令很容易超限；
    // 因此生成一个短路径包装脚本，计划任务只指向它。
    const launch = path.join(stateDir, "host", "host-launch.cmd");
    if (launch.length > 200) throw new Error(`包装脚本路径过长（${launch.length} 字符），请使用更短的状态目录。`);
    const launchContent = ["@echo off", `${quote(nodePath)} ${quote(hostScript)} ${args.join(" ")}`, ""].join("\r\n");
    return {
      platform,
      files: [{ path: launch, content: launchContent, mode: 0o644, note: "计划任务指向该短路径脚本；/TR 有 261 字符上限" }],
      commands: [
        {
          note: "以 SYSTEM 身份、开机自动运行内核宿主。安装时需要管理员权限。",
          cmd: "schtasks.exe",
          args: ["/Create", "/TN", HOST_TASK, "/SC", "ONSTART", "/RU", "SYSTEM", "/RL", "HIGHEST", "/TR", quote(launch), "/F"],
        },
        { note: "安装后立即启动一次，无需重启系统。", cmd: "schtasks.exe", args: ["/Run", "/TN", HOST_TASK] },
      ],
      uninstallCommands: [
        { cmd: "schtasks.exe", args: ["/Delete", "/TN", HOST_TASK, "/F"] },
        { cmd: "cmd.exe", args: ["/c", "del", "/f", quote(launch)] },
      ],
      tokenFile,
      launchFile: launch,
      notes: [
        "令牌文件由首次运行的宿主生成（0600）；删除后下次启动会重新生成。",
        "计划任务只允许本机访问宿主端口，令牌缺失或不匹配一律拒绝。",
      ],
    };
  }

  if (platform === "darwin") {
    const helper = `/Library/PrivilegedHelperTools/${HOST_LABEL}.sh`;
    const plist = `/Library/LaunchDaemons/${HOST_LABEL}.plist`;
    const script = [
      "#!/bin/sh",
      `exec ${quote(nodePath)} ${quote(hostScript)} ${args.join(" ")}`,
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
      ],
      commands: [{ note: "加载特权守护进程（需要 sudo）。", cmd: "launchctl", args: ["bootstrap", "system", plist] }],
      uninstallCommands: [
        { cmd: "launchctl", args: ["bootout", "system", plist] },
        { cmd: "rm", args: ["-f", plist, helper] },
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
