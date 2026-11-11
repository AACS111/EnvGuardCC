// fail-closed 守卫的应急恢复工具。
//
// 为什么必须有它：fail-closed 的语义就是「宁可连不上」。如果应用崩溃、宿主异常或用户
// 误删了状态文件，Claude 目标可能一直被系统防火墙阻断，而应用侧已经不知道该删哪一组规则。
// 本工具不依赖状态文件，只按固定前缀清理，必须能在任何情况下把人救回来。
//
// 用法：以管理员身份运行
//   node scripts/recover-claude-guard.mjs [--dry-run]
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { windowsSystemExecutable } from "./windows-timezone.mjs";

const run = promisify(execFile);
const GROUP_PREFIX = "EnvGuardCC-Claude-Guard";
const dryRun = process.argv.includes("--dry-run");

async function powershell(script) {
  const executable = windowsSystemExecutable("WindowsPowerShell\\v1.0\\powershell.exe");
  const { stdout } = await run(executable, ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 30000 });
  return String(stdout ?? "").trim();
}

async function main() {
  if (process.platform !== "win32") {
    console.log("当前平台没有系统级 fail-closed 守卫；如需解除 macOS 严格模式断流，请使用自带的恢复工具。");
    return 0;
  }
  const count = await powershell(`@(Get-NetFirewallRule -DisplayName '${GROUP_PREFIX}-*' -ErrorAction SilentlyContinue).Count`).catch(() => "0");
  if (count === "0") {
    console.log(`没有发现 ${GROUP_PREFIX}-* 规则，无需恢复。`);
    return 0;
  }
  if (dryRun) {
    console.log(`将删除 ${count} 条 ${GROUP_PREFIX}-* 规则（dry-run，未执行）。`);
    return 0;
  }
  const remaining = await powershell(`Remove-NetFirewallRule -DisplayName '${GROUP_PREFIX}-*' -ErrorAction SilentlyContinue; @(Get-NetFirewallRule -DisplayName '${GROUP_PREFIX}-*' -ErrorAction SilentlyContinue).Count`);
  if (remaining !== "0") {
    console.error(`恢复未完成：仍有 ${remaining} 条规则。请以管理员身份重新运行。`);
    return 1;
  }
  console.log(`已删除 ${count} 条 fail-closed 规则，Claude 可重新直连。`);
  return 0;
}

main().then(code => process.exit(code), (error) => {
  console.error(`恢复失败：${error.message}`);
  process.exit(1);
});
