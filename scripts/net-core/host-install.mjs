// 特权宿主的应用内安装：只做一件事——把固定的安装命令交给系统授权弹窗执行。
//
// 为什么需要它：TUN 必须由 root 创建。macOS 上直接 spawn 安装器拿不到权限，
// 而 `osascript ... with administrator privileges` 会弹出系统密码 / Touch ID 窗口，
// 与系统时区服务用的是同一套授权模型（见 docs/timezone-service.md）。
//
// 安全边界：
// - 命令与路径全部来自服务端（本模块调用方），不接受 HTTP 请求传入的路径；
// - AppleScript 只执行这一条固定命令，不拼接用户输入；
// - 安装器自身拒绝非 root 执行，安装后立刻探测宿主是否在线。

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);
const ADMIN_SCRIPT = "on run argv\n do shell script (item 1 of argv) with administrator privileges\nend run";

/**
 * 令牌必须由当前用户先写好：安装器随后以 root 身份运行，如果令牌由 root 创建，
 * 普通用户读不到，detectHost 会一直失败（宿主活着，界面却看不见）。
 */
async function ensureUserToken(stateDir) {
  const file = path.join(stateDir, "host-token");
  try {
    const existing = (await readFile(file, "utf8")).trim();
    if (existing) return existing;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("hex");
  await mkdir(stateDir, { recursive: true });
  await writeFile(file, `${token}\n`, { mode: 0o600 });
  return token;
}

/** POSIX 单引号转义：任意内容放进 sh 的单个参数都不会被解释。 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** 生成交给系统授权弹窗执行的安装命令（与安装器 CLI 完全一致）。 */
export function buildInstallCommand({ nodePath = process.execPath, scriptPath, stateDir, binary }) {
  if (!scriptPath || !stateDir) throw new Error("安装特权宿主缺少脚本或状态目录。");
  const env = [`CHECKCC_STATE_DIR=${shellQuote(stateDir)}`];
  if (binary) env.push(`CHECKCC_NET_CORE_BINARY=${shellQuote(binary)}`);
  return `${env.join(" ")} ${shellQuote(nodePath)} ${shellQuote(scriptPath)} --apply`;
}

const psQuote = value => `'${String(value).replace(/'/g, "''")}'`;

/**
 * Windows 安装命令：外层普通权限进程用 UAC 拉起内层提权进程，
 * 内层把安装器的 stdout/stderr 落到 logFile 再由调用方回读。
 *
 * 为什么不能直接给 Start-Process 加 -RedirectStandardOutput：
 * -Verb RunAs 走的是 ShellExecute，重定向句柄无法穿过提权边界，输出会直接丢掉；
 * 丢掉之后就只剩 CLIXML 进度噪声，用户看到的是一屏无法处理的乱码。
 */
export function buildWindowsInstallCommand({ nodePath = process.execPath, scriptPath, stateDir, binary, logFile }) {
  if (!scriptPath || !stateDir) throw new Error("安装特权宿主缺少脚本或状态目录。");
  const log = logFile || path.join(stateDir, "host-install.log");
  for (const value of [nodePath, scriptPath, stateDir, log]) {
    if (/["%\r\n\0]/.test(value)) throw new Error("安装路径不得包含引号、百分号或换行。");
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "Remove-Item Env:NODE_OPTIONS, Env:NODE_PATH -ErrorAction SilentlyContinue",
    `$env:CHECKCC_STATE_DIR = ${psQuote(stateDir)}`,
    binary ? `$env:CHECKCC_NET_CORE_BINARY = ${psQuote(binary)}` : "",
    // cmd 的重定向是字节级传递：Node 写 UTF-8，日志也是 UTF-8，不会经过 PowerShell 转码。
    `& cmd.exe /c ${psQuote(`"${nodePath}" "${scriptPath}" --apply > "${log}" 2>&1`)}`,
    "exit $LASTEXITCODE",
  ].filter(Boolean).join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const outer = `$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n$p = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', '${encoded}') -Wait -PassThru\nexit $p.ExitCode`;
  return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(outer, "utf16le").toString("base64")], logFile: log };
}

/** PowerShell 把 stderr 包成 CLIXML（含进度记录），对用户没有任何信息量。 */
export function cleanInstallerOutput(value) {
  return String(value ?? "")
    .replace(/<Objs[\s\S]*?<\/Objs>/g, " ")
    .replace(/#<\s*CLIXML/g, " ")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * 通过系统授权弹窗安装特权宿主。
 * 用户在弹窗里取消会抛出可读错误，不会被当成安装失败或静默忽略。
 */
export async function installKernelHost({
  stateDir,
  binary,
  platform = process.platform,
  nodePath = process.execPath,
  scriptPath = fileURLToPath(new URL("./install-host.mjs", import.meta.url)),
  run = execFileAsync,
  timeoutMs = 180000,
} = {}) {
  if (!stateDir) throw new Error("缺少状态目录，无法安装特权宿主。");
  if (!["darwin", "win32"].includes(platform)) throw new Error("当前平台需要手动安装特权宿主。");
  // 先以当前用户身份准备令牌：安装器是 root，令牌由 root 创建会让应用读不到。
  await ensureUserToken(stateDir);
  const logFile = path.join(stateDir, "host-install.log");
  if (platform === "win32") await rm(logFile, { force: true }).catch(() => {});
  const readLog = async () => {
    try { return cleanInstallerOutput(await readFile(logFile, "utf8")); } catch { return ""; }
  };
  try {
    let result;
    if (platform === "darwin") {
      const command = buildInstallCommand({ nodePath, scriptPath, stateDir, binary });
      result = await run("/usr/bin/osascript", ["-e", ADMIN_SCRIPT, command], { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
    } else {
      const command = buildWindowsInstallCommand({ nodePath, scriptPath, stateDir, binary, logFile });
      result = await run(command.file, command.args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true });
    }
    const { stdout = "", stderr = "" } = result;
    const output = cleanInstallerOutput(`${stdout}${stderr}`) || await readLog();
    return { installed: true, output, logFile };
  } catch (error) {
    // 提权进程的输出只能用日志文件拿回来；优先用它，而不是外层 PowerShell 的 CLIXML。
    const logged = await readLog();
    const captured = cleanInstallerOutput(`${error?.stderr ?? ""}${error?.stdout ?? ""}`);
    const output = logged || captured || String(error?.message ?? "");
    if (/User canceled|cancelled|canceled|1223|操作已取消|用户取消|-128/i.test(output)) throw new Error("授权已取消，未安装特权宿主。");
    const detail = output.split("\n").filter(Boolean).slice(-4).join(" ");
    const hint = logged ? `（安装日志：${logFile}）` : "";
    throw new Error(`安装特权宿主失败：${detail || "系统未返回原因"}${hint}`);
  }
}
