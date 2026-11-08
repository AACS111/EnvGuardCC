// 特权宿主安装器：默认只打印计划，--apply 才真正执行。
// 需要管理员（Windows）/ root（macOS）；非特权时会给出可直接执行的提权命令，而不是静默失败。

import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, writeFile, lstat, chmod, chown } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildHostInstallPlan, describePlan, waitForMacHostUnload } from "./service.mjs";
import { resolveKernelBinary } from "./runtime.mjs";
import { stageHostBundle } from "./host-bundle.mjs";
import { createFirewallGuard } from "./firewall.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0;
}

function isElevated() {
  if (process.platform === "win32") {
    try { execFileSync("net", ["session"], { stdio: "ignore", windowsHide: true, timeout: 2000 }); return true; }
    catch { return false; }
  }
  return typeof process.getuid === "function" && process.getuid() === 0;
}

async function ensureToken(file) {
  try { return (await readFile(file, "utf8")).trim(); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const token = randomBytes(32).toString("hex");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${token}\n`, { mode: 0o600 });
    return token;
  }
}

async function main() {
  const stateDir = process.env.CHECKCC_STATE_DIR || path.join(root, "node_modules", ".checkcc-local");
  const hostScript = path.join(here, "host.mjs");
  const binary = await resolveKernelBinary({ stateDir, root });
  if (!binary) throw new Error("未找到内核二进制，请先运行 pnpm kernel:fetch。");
  await access(hostScript);

  let plan = buildHostInstallPlan({
    platform: process.platform,
    nodePath: process.execPath,
    hostScript,
    stateDir,
    binary,
    apiPort: Number(process.env.CHECKCC_NET_CORE_API_PORT || 39090),
    port: Number(process.env.CHECKCC_NET_CORE_HOST_PORT || 39091),
  });

  // 令牌必须先存在：宿主与界面读同一个文件。
  const token = await ensureToken(plan.tokenFile);

  if (flag("uninstall")) {
    if (!isElevated()) {
      process.stderr.write("[install] 卸载同样需要管理员权限。\n");
      process.exitCode = 2;
      return;
    }
    for (const step of plan.uninstallCommands) {
      if (step === plan.uninstallCommands[0] && process.platform === "darwin") await createFirewallGuard().release();
      try { execFileSync(step.cmd, step.args, { stdio: "inherit", windowsHide: true }); }
      catch (error) { if (!step.optional) throw error; }
    }
    process.stdout.write("[install] 已卸载宿主。\n");
    return;
  }

  process.stdout.write(`[install] 平台 ${plan.platform}\n`);
  process.stdout.write(`[install] 内核 ${binary}\n`);
  process.stdout.write(`[install] 状态目录 ${stateDir}\n`);
  process.stdout.write(`[install] 令牌文件 ${plan.tokenFile}（长度 ${token.length}）\n`);
  for (const note of plan.notes) process.stdout.write(`[install] 说明：${note}\n`);
  process.stdout.write(`${describePlan(plan)}\n`);

  if (!flag("apply")) {
    process.stdout.write("[install] 这是计划预览。加 --apply 才会执行安装。\n");
    return;
  }

  if (!isElevated()) {
    process.stderr.write("[install] 需要管理员/root 权限才能安装特权宿主。\n");
    if (process.platform === "win32") {
      process.stderr.write(`[install] 请以管理员身份运行：\n  ${process.execPath} "${path.join(here, "install-host.mjs")}" --apply\n`);
    } else {
      process.stderr.write(`[install] 请执行：\n  sudo ${process.execPath} "${path.join(here, "install-host.mjs")}" --apply\n`);
    }
    process.exitCode = 2;
    return;
  }

  // 系统服务必须指向管理员保护的独立运行包，不能指向源码树或用户可写应用目录。
  const installed = await stageHostBundle({ hostScript, binary });
  plan = buildHostInstallPlan({
    platform: process.platform, nodePath: installed.nodePath, hostScript: installed.hostScript,
    stateDir, binary: installed.binary,
    apiPort: Number(process.env.CHECKCC_NET_CORE_API_PORT || 39090),
    port: Number(process.env.CHECKCC_NET_CORE_HOST_PORT || 39091),
  });
  if (process.platform === "darwin") {
    // 重装时先卸载旧服务，再加载新版本；普通首次安装的“不存在”可忽略。
    await waitForMacHostUnload({ run: async (command, args) => execFileSync(command, args, { stdio: "pipe" }) });
  } else if (process.platform === "win32") {
    try { execFileSync("schtasks.exe", ["/End", "/TN", "EnvGuardCC-KernelHost"], { stdio: "ignore", windowsHide: true }); } catch { /* not running */ }
  }
  for (const file of plan.files) {
    await mkdir(path.dirname(file.path), { recursive: true });
    try { if ((await lstat(file.path)).isSymbolicLink()) throw new Error("拒绝替换符号链接形式的系统宿主文件。"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await writeFile(file.path, file.content, { mode: file.mode });
    if (process.platform === "darwin") { await chmod(file.path, file.mode); await chown(file.path, 0, 0); }
    process.stdout.write(`[install] 已写入 ${file.path}\n`);
  }
  for (const step of plan.commands) {
    process.stdout.write(`[install] 执行 ${step.cmd} ${step.args.join(" ")}\n`);
    execFileSync(step.cmd, step.args, { stdio: "inherit", windowsHide: true });
  }
  // 安装后立刻探测宿主：装成功但起不来，必须当场说清楚。
  const hostPort = Number(process.env.CHECKCC_NET_CORE_HOST_PORT || 39091);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${hostPort}/health`, { headers: { "X-EnvGuardCC-Host-Token": token }, signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        process.stdout.write(`[install] 宿主已在线：${JSON.stringify(await response.json())}\n`);
        process.stdout.write("[install] 完成。网络页会自动检测到宿主并以宿主模式运行。\n");
        return;
      }
    } catch { /* 还在启动 */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  process.stdout.write(process.platform === "darwin"
    ? "[install] 宿主未及时应答。请检查 launchctl print system/com.envguardcc.kernelhost 与 /var/log/com.envguardcc.kernelhost.log。\n"
    : "[install] 宿主未及时应答，请运行 schtasks /Query /TN EnvGuardCC-KernelHost /V /FO LIST 检查。\n");
  process.exitCode = 3;
}

main().catch((error) => {
  process.stderr.write(`[install] ${error.message}\n`);
  process.exitCode = 1;
});
