// 端口占用排查：内核端口被「上一个没退干净的内核」占住时，
// 直接 spawn 新内核会让它绑定失败秒退，随后界面误判成「内核未就绪」或更糟——把旧内核当成自己在跑。
// 这里只做只读探查：谁在听这个端口。杀不杀由调用方决定（宿主有权限才杀）。

import { execFile } from "node:child_process";
import net from "node:net";

const run = (command, args) => new Promise((resolve) => {
  execFile(command, args, { windowsHide: true, timeout: 4000 }, (error, stdout) => {
    resolve(error ? "" : String(stdout ?? ""));
  });
});

/** Windows：netstat -ano 的 LISTENING 行里取 PID。 */
function ownerOnWin32(output, port) {
  for (const line of output.split(/\r?\n/)) {
    // 形如：  TCP    127.0.0.1:39090    0.0.0.0:0    LISTENING    51292
    const match = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
    if (match && Number(match[1]) === port) return Number(match[2]);
  }
  return null;
}

/** macOS：lsof -nP -iTCP:port -sTCP:LISTEN。 */
function ownerFromLsof(output) {
  const lines = output.split(/\r?\n/).slice(1);
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    const pid = Number(fields[1]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

/**
 * 找出监听某端口的进程 PID。查不到返回 null（权限不足、命令不存在都算查不到，不抛错）。
 * @param {number} port
 * @param {{platform?: string, exec?: (command: string, args: string[]) => Promise<string>}} [options]
 */
export async function findPortOwner(port, { platform = process.platform, exec = run } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口无效。");
  try {
    if (platform === "win32") return ownerOnWin32(await exec("netstat.exe", ["-ano", "-p", "TCP"]), port);
    if (platform === "darwin") return ownerFromLsof(await exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]));
    // Linux：ss 比 lsof 更常见。
    const output = await exec("ss", ["-ltnp", `sport = :${port}`]);
    const match = output.match(/pid=(\d+)/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** 进程名（用于确认「占用端口的确实是我们自己的内核」，不是别的软件）。 */
export async function processName(pid, { platform = process.platform, exec = run } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === "win32") {
      const output = await exec("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
      const match = output.match(/^"([^"]+)"/m);
      return match ? match[1] : null;
    }
    const output = await exec("ps", ["-p", String(pid), "-o", "comm="]);
    return output.trim().split(/[\\/]/).pop() || null;
  } catch {
    return null;
  }
}

export const KERNEL_PROCESS_NAMES = ["mihomo", "mihomo.exe", "clash", "clash.exe"];

/**
 * 进程的完整命令行。用来确认占用端口的是「本程序的内核」而不是用户自己的代理软件：
 * 两者可执行文件名都可能是 mihomo，只按名字杀会误杀 FlClash 之类的其它内核。
 */
export async function processCommandLine(pid, { platform = process.platform, exec = run } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === "win32") {
      const output = await exec("powershell.exe", ["-NoProfile", "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`]);
      return output.trim() || null;
    }
    const output = await exec("ps", ["-p", String(pid), "-o", "args="]);
    return output.trim() || null;
  } catch {
    return null;
  }
}

/**
 * 找一段连续的可用端口。
 * 实测坑：Windows 会保留大段端口给 Hyper-V/WinNAT（`netsh int ipv4 show excludedportrange`），
 * 撞上保留段时 bind 会失败或连接被 RST，所以不能写死端口号。
 */
export async function pickPortBlock(count, { start = 39481, span = 42000, bind } = {}) {
  const need = Math.max(1, Math.trunc(count));
  const canBind = bind ?? ((port) => new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  }));
  for (let base = start; base + need < span; base += 100) {
    let ok = true;
    for (let offset = 0; offset < need; offset += 1) {
      if (!await canBind(base + offset)) { ok = false; break; }
    }
    if (ok) return base;
  }
  throw new Error("没有找到可用的连续端口段。");
}
