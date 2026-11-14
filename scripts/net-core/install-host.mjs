// 特权宿主安装器：默认只打印计划，--apply 才真正执行。
// 需要管理员（Windows）/ root（macOS）；非特权时会给出可直接执行的提权命令，而不是静默失败。

import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile, lstat, chmod, chown } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildHostInstallPlan, describePlan, waitForMacHostUnload } from "./service.mjs";
import { resolveKernelBinary } from "./runtime.mjs";
import { stageHostBundle } from "./host-bundle.mjs";
import { checkHostHealth } from './host-protocol.mjs';
import { loopbackFetch } from './loopback-fetch.mjs';
import { createFirewallGuard } from "./firewall.mjs";
import { cleanupClaudeGuard, uninstallHost } from './cleanup-claude-guard.mjs';

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
  const binary = flag('uninstall') ? path.join(stateDir, 'unused-kernel') : await resolveKernelBinary({ stateDir, root });
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
    await uninstallHost(plan, {
      run: (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', windowsHide: true }),
      cleanup: () => cleanupClaudeGuard({ stateDir }),
      releaseMac: () => createFirewallGuard().release(),
    });
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
  for (const warning of installed.warnings ?? []) process.stdout.write(`[install] 警告：${warning}\n`);
  plan = buildHostInstallPlan({
    platform: process.platform, nodePath: installed.nodePath, hostScript: installed.hostScript,
    stateDir, binary: installed.binary,
    apiPort: Number(process.env.CHECKCC_NET_CORE_API_PORT || 39090),
    port: Number(process.env.CHECKCC_NET_CORE_HOST_PORT || 39091),
  });
  const hostPort = Number(process.env.CHECKCC_NET_CORE_HOST_PORT || 39091);
  if (process.platform === "darwin") {
    // 重装时先卸载旧服务，再加载新版本；普通首次安装的“不存在”可忽略。
    await waitForMacHostUnload({ run: async (command, args) => execFileSync(command, args, { stdio: "pipe" }) });
  } else if (process.platform === "win32") {
    try { execFileSync("schtasks.exe", ["/End", "/TN", "EnvGuardCC-KernelHost"], { stdio: "ignore", windowsHide: true }); } catch { /* not running */ }
    // 旧宿主是常驻进程：结束任务后必须等它真的退出，否则新宿主绑不上端口，
    // 安装看起来“成功”却等不到 /health，最后只剩一句含糊的“未及时应答”。
    await releaseHostPort(hostPort);
  }
  for (const file of plan.files) {
    await mkdir(path.dirname(file.path), { recursive: true });
    try { if ((await lstat(file.path)).isSymbolicLink()) throw new Error("拒绝替换符号链接形式的系统宿主文件。"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await writeFile(file.path, file.content, { mode: file.mode });
    if (process.platform === "darwin") { await chmod(file.path, file.mode); await chown(file.path, 0, 0); }
    process.stdout.write(`[install] 已写入 ${file.path}\n`);
  }
  // 启动诊断与滚动运行日志分离，升级不再清空运行历史。
  if (process.platform === "win32" && plan.startupLog) await rm(plan.startupLog, { force: true }).catch(() => {});
  for (const step of plan.commands) {
    process.stdout.write(`[install] 执行 ${step.cmd} ${step.args.join(" ")}\n`);
    execFileSync(step.cmd, step.args, { stdio: "inherit", windowsHide: true });
  }
  // 安装后立刻探测宿主：装成功但起不来，必须当场说清楚。
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await loopbackFetch(`http://127.0.0.1:${hostPort}/health`, { headers: { "X-EnvGuardCC-Host-Token": token }, signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const health = await response.json();
        if (!checkHostHealth(health).ok) {
          process.stdout.write('[install] 应答宿主版本不匹配，继续等待新宿主。\n');
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }
        process.stdout.write(`[install] 宿主版本已验证：${JSON.stringify(health)}\n`);
        process.stdout.write("[install] 完成。网络页会自动检测到宿主并以宿主模式运行。\n");
        return;
      }
    } catch { /* 还在启动 */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  process.stdout.write(process.platform === "darwin"
    ? "[install] 宿主未及时应答。请检查 launchctl print system/com.envguardcc.kernelhost 与 /var/log/com.envguardcc.kernelhost.log。\n"
    : await win32TaskDiagnostics(plan, hostPort, installed, stateDir, token));
  process.exitCode = 3;
}

/**
 * 前台直接跑一次运行包（随机端口）：用来区分「包本身跑不起来」和「计划任务被拦/没执行」。
 * 不改系统、不长期占用：验完立即结束子进程。
 */
async function diagnoseHostStartup({ installed, stateDir, token }) {
  const net = await import("node:net");
  const { spawn } = await import("node:child_process");
  const freePort = () => new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(() => resolve(value)); });
  });
  const port = await freePort(), apiPort = await freePort();
  const child = spawn(installed.nodePath, [
    installed.hostScript, "--state-dir", stateDir, "--token-file", path.join(stateDir, "host-token"),
    "--binary", installed.binary, "--api-port", String(apiPort), "--port", String(port),
  ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  let answered = null;
  for (let attempt = 0; attempt < 12 && !answered; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (child.exitCode !== null) break;
    try {
      const response = await loopbackFetch(`http://127.0.0.1:${port}/health`, { headers: { "X-EnvGuardCC-Host-Token": token }, signal: AbortSignal.timeout(800) });
      if (response.ok) answered = await response.json();
    } catch { /* 还在启动 */ }
  }
  try { child.kill(); } catch { /* 已退出 */ }
  return { answered, output: output.trim(), exitCode: child.exitCode };
}

/** schtasks / tasklist 输出是系统代码页（中文 Windows 为 GBK），不能直接当 UTF-8 读。 */
function decodeConsole(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer ?? ""), "utf8");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { try { return new TextDecoder("gbk").decode(bytes); } catch { return bytes.toString("utf8"); } }
}

const TASK_RESULTS = {
  0: "成功",
  267008: "任务正在运行（上一次仍在跑）",
  267009: "任务正在运行",
  267010: "任务已排队",
  267011: "任务从未运行过：被策略/安全软件拦住或任务被禁用",
  2147942402: "系统找不到指定文件（0x80070002）：启动脚本路径不对",
  2147942405: "拒绝访问（0x80070005）：安全软件或策略拦截了启动",
  3221225781: "缺少 DLL（0xC0000135）",
  3221225786: "进程被中断（0xC000013A）",
};

function taskResultHint(line) {
  const raw = String(line ?? "").split(/[:：]/).slice(1).join(":").trim();
  const hex = raw.match(/0x([0-9a-f]+)/i)?.[1];
  const code = hex ? parseInt(hex, 16) : Number(raw.match(/\d+/)?.[0]);
  const hint = Number.isFinite(code) ? TASK_RESULTS[code] : undefined;
  return hint ? `${raw}（${hint}）` : raw;
}

async function readHostLog(file, lines = 15) {
  if (!file) return "（未配置宿主日志）";
  try {
    const text = decodeConsole(await readFile(file)).trim();
    if (!text) return "（日志为空）";
    return text.split(/\r?\n/).slice(-lines).join("\n");
  } catch (error) {
    if (error.code === "ENOENT") return "（日志未生成：启动脚本根本没被执行，优先看下面任务的“上次结果”）";
    return `（读不到日志：${error.message}）`;
  }
}

/**
 * 让旧宿主真正退出：计划任务 /End 只保证「任务」停止，手动启动或残留的宿主进程
 * 仍会占着端口，新宿主绑不上就秒退——表现出来就是「安装完了但宿主未及时应答」。
 * 只结束命令行确认是本程序 host.mjs 的进程，绝不误杀其它程序。
 */
async function releaseHostPort(port) {
  const { findPortOwner, processCommandLine, processName } = await import("./ports.mjs");
  const pid = await findPortOwner(port).catch(() => null);
  if (!pid) return true;
  const command = await processCommandLine(pid).catch(() => null);
  if (typeof command === "string" && /host\.mjs/i.test(command)) {
    process.stdout.write(`[install] 结束残留宿主进程 ${pid}（占用端口 ${port}）。\n`);
    try { process.kill(pid, "SIGKILL"); } catch { /* 已经退出 */ }
  } else {
    const name = await processName(pid).catch(() => null);
    process.stdout.write(`[install] 警告：端口 ${port} 被 ${name ?? "未知进程"}（PID ${pid}）占用，${command ? "命令行不匹配，不会强行结束" : "读不到命令行"}。\n`);
  }
  return waitForPortFree(port, 8000);
}

/** 端口是否还被占用（旧宿主没退干净 / 被其他程序占着）。 */
async function portInUse(port) {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(800);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function waitForPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portInUse(port))) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (await portInUse(port)) {
    // 不在这里强制杀进程：可能占着端口的是别的程序，误杀比失败更糟。
    process.stdout.write(`[install] 警告：端口 ${port} 仍被占用，新宿主可能启动失败。\n`);
    return false;
  }
  return true;
}

/** 宿主没起来时把计划任务状态 + 宿主启动日志带回来，而不是让用户自己去查。 */
async function win32TaskDiagnostics(plan, hostPort, installed, stateDir, token) {
  const lines = ["[install] 宿主未及时应答，现场如下："];
  try {
    const output = decodeConsole(execFileSync("schtasks.exe", ["/Query", "/TN", "EnvGuardCC-KernelHost", "/V", "/FO", "LIST"], { windowsHide: true }));
    const keep = /Last Result|上次结果|Status|状态|Task To Run|要运行的任务|Run As User|以其身份运行|Task To Run|Scheduled Task State|计划任务状态/i;
    for (const line of output.split("\n")) {
      const text = line.trim();
      if (!text || !keep.test(text)) continue;
      lines.push(/上次结果|Last Result/i.test(text) ? `${text.split(/[:：]/)[0]}: ${taskResultHint(text)}` : text);
    }
  } catch (error) {
    lines.push(`无法读取计划任务：${decodeConsole(error.stdout ?? "") || error.message}`);
  }
  const owner = await (async () => {
    const { findPortOwner, processName } = await import("./ports.mjs");
    const pid = await findPortOwner(hostPort).catch(() => null);
    return pid ? `端口 ${hostPort} 被 ${await processName(pid).catch(() => null) ?? "未知进程"}（PID ${pid}）占用` : `端口 ${hostPort} 空闲`;
  })().catch(() => "端口状态未知");
  lines.push(`[install] ${owner}`);
  lines.push("[install] 宿主启动日志（最后 15 行）：");
  lines.push(await readHostLog(plan?.hostLog));
  if (plan?.startupLog) lines.push(await readHostLog(plan.startupLog));
  // 直接跑一遍运行包：能起来 ⇒ 问题在计划任务/安全软件；起不来 ⇒ 包或环境本身的问题。
  const probe = installed ? await diagnoseHostStartup({ installed, stateDir, token }).catch(() => null) : null;
  if (probe?.answered) {
    lines.push(`[install] 直接启动运行包成功（协议 ${probe.answered.hostProtocol ?? "?"}）：程序本身可运行，失败在计划任务这一层，通常是被安全软件/组策略拦住或任务未被执行。`);
  } else if (probe) {
    lines.push("[install] 直接启动运行包也失败，它的输出：");
    lines.push(probe.output ? probe.output.split(/\r?\n/).slice(-10).join("\n") : "（无输出，进程已退出）");
  }
  lines.push("[install] 若需手动排查：schtasks /Query /TN EnvGuardCC-KernelHost /V /FO LIST");
  return `${lines.join("\n")}\n`;
}

main().catch((error) => {
  process.stderr.write(`[install] ${error.message}\n`);
  process.exitCode = 1;
});
