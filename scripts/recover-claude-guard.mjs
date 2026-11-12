// fail-closed 守卫的应急恢复工具。
//
// 为什么必须有它：fail-closed 的语义就是「宁可连不上」。如果应用崩溃、宿主异常或用户
// 误删了状态文件，Claude 目标可能一直被系统防火墙阻断，而应用侧已经不知道该删哪一组规则。
// 本工具不依赖状态文件，只按固定前缀清理，必须能在任何情况下把人救回来。
//
// 用法：以管理员身份运行
//   node scripts/recover-claude-guard.mjs [--dry-run]
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { windowsSystemExecutable } from "./windows-timezone.mjs";
import { defaultHostsPath, hostsBlocked, stripHostsBlock } from "./net-core/claude-guard.mjs";

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
  // 1) 防火墙规则：按固定前缀删除，不依赖状态文件。
  const count = await powershell(`@(Get-NetFirewallRule -DisplayName '${GROUP_PREFIX}-*' -ErrorAction SilentlyContinue).Count`).catch(() => "0");
  // 2) hosts 段：同样不依赖 token，按标记清理。
  const hostsPath = defaultHostsPath();
  let hostsCleaned = false;
  if (hostsPath) {
    const content = await readFile(hostsPath, "utf8").catch(() => null);
    if (content && hostsBlocked(content)) {
      if (dryRun) console.log(`将清理 ${hostsPath} 中的 fail-closed 段（dry-run，未执行）。`);
      else { await writeFile(hostsPath, stripHostsBlock(content), "utf8"); hostsCleaned = true; }
    }
  }
  if (count === "0" && !hostsCleaned && !dryRun) {
    console.log(`没有发现 ${GROUP_PREFIX}-* 规则或 hosts 段，无需恢复。`);
    return 0;
  }
  if (dryRun) {
    console.log(`将删除 ${count} 条 ${GROUP_PREFIX}-* 规则${hostsCleaned || hostsPath ? "，并清理 hosts 段" : ""}（dry-run）。`);
    return 0;
  }
  const remaining = await powershell(`Remove-NetFirewallRule -DisplayName '${GROUP_PREFIX}-*' -ErrorAction SilentlyContinue; @(Get-NetFirewallRule -DisplayName '${GROUP_PREFIX}-*' -ErrorAction SilentlyContinue).Count`);
  const hostsLeft = hostsPath ? hostsBlocked(await readFile(hostsPath, "utf8").catch(() => "")) : false;
  if (remaining !== "0" || hostsLeft) {
    console.error(`恢复未完成：剩余 ${remaining} 条规则${hostsLeft ? "，hosts 段仍在" : ""}。请以管理员身份重新运行。`);
    return 1;
  }
  console.log(`已删除 ${count} 条 fail-closed 规则${hostsCleaned ? "并清理 hosts 段" : ""}，Claude 可重新直连。`);
  return 0;
}

main().then(code => process.exit(code), (error) => {
  console.error(`恢复失败：${error.message}`);
  process.exit(1);
});
