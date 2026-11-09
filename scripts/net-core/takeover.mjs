// 系统接管前退出当前用户已识别的代理 GUI；不按内核名字强杀或停用未知 VPN。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import path from "node:path";

const execute = promisify(execFile);
const run = async (file, args) => (await execute(file, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })).stdout;
const CLIENTS = [
  { label: "FlClash", mac: ["FlClash"], win: ["flclash.exe"] },
  { label: "Clash Verge", mac: ["Clash Verge", "Clash Verge Rev"], win: ["clash-verge.exe"] },
  { label: "ClashX", mac: ["ClashX", "ClashX Pro"], win: [] },
  { label: "Clash for Windows", mac: ["Clash for Windows"], win: ["clash for windows.exe"] },
  { label: "Surge", mac: ["Surge"], win: [] },
  { label: "Stash", mac: ["Stash"], win: [] },
  { label: "Hiddify", mac: ["Hiddify"], win: ["hiddify.exe"] },
  { label: "Karing", mac: ["Karing"], win: ["karing.exe"] },
  { label: "v2rayN", mac: [], win: ["v2rayn.exe"] },
];
const kernelName = /^(?:mihomo|clash(?:-meta)?|sing-box|xray|v2ray)(?:\.exe)?$/i;
const normalize = value => String(value).toLowerCase().replace(/[ ._-]/g, "");

export function classifyTakeoverProcesses(rows, { platform, uid = process.getuid?.(), ownBinary = "" } = {}) {
  const clients = new Map(), kernels = [];
  for (const row of rows) {
    const executable = String(row.executable || "");
    if (!executable || !Number.isInteger(row.pid) || row.pid <= 0) continue;
    const windowsHost = path.win32.join(process.env.ProgramFiles || "C:\\Program Files", "EnvGuardCC", "KernelHost") + "\\";
    if (executable === ownBinary || executable.startsWith("/Library/PrivilegedHelperTools/com.envguardcc.kernelhost.bundle/") || (platform === "win32" && executable.toLowerCase().startsWith(windowsHost.toLowerCase()))) continue;
    const base = executable.split(/[\\/]/).pop();
    if (kernelName.test(base)) {
      const appName = executable.match(/\/([^/]+)\.app\//)?.[1];
      const client = platform === "darwin" && CLIENTS.find(c => c.mac.some(name => normalize(name) === normalize(appName)));
      kernels.push({ pid: row.pid, name: base, client: client?.label ?? null }); continue;
    }
    if (platform === "darwin") {
      if (row.uid !== uid) continue;
      const match = executable.match(/^(.*\/([^/]+)\.app)\/Contents\/MacOS\/([^/]+)$/);
      if (!match) continue;
      const client = CLIENTS.find(c => c.mac.some(name => normalize(name) === normalize(match[2])) && c.mac.some(name => normalize(name) === normalize(match[3])));
      if (client) clients.set(match[1], { label: client.label, target: match[1], pid: row.pid });
    } else if (platform === "win32") {
      const client = CLIENTS.find(c => c.win.includes(base.toLowerCase()));
      if (client) clients.set(row.pid, { label: client.label, target: row.pid, pid: row.pid });
    }
  }
  return { clients: [...clients.values()], kernels };
}

async function processes(platform, exec) {
  if (platform === "win32") {
    // 只关闭当前交互会话的 GUI，不能借 SYSTEM 权限停其他用户的工具。
    const output = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; $s=(Get-Process -Id $PID).SessionId; @(Get-CimInstance Win32_Process | Where-Object {$_.SessionId -eq $s} | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress"]);
    const data = JSON.parse(output || "[]");
    return (Array.isArray(data) ? data : [data]).filter(Boolean).map(p => ({ pid: Number(p.ProcessId), executable: p.ExecutablePath }));
  }
  return (await exec("/bin/ps", ["-axo", "pid=,uid=,comm="])).split(/\r?\n/).flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), uid: Number(match[2]), executable: match[3] }] : [];
  });
}

const freePort = port => new Promise(resolve => {
  const server = net.createServer();
  server.once("error", () => resolve(false));
  server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true)));
});

export function createNetworkTakeover({ platform = process.platform, uid = process.getuid?.(), ownBinary, exec = run, listProcesses = () => processes(platform, exec), canBind = freePort, pause = ms => new Promise(r => setTimeout(r, ms)), attempts = 20 } = {}) {
  let status = { phase: "idle", closed: [], reason: null, checkedAt: null };
  const update = (phase, extra = {}) => { status = { ...status, phase, ...extra, checkedAt: new Date().toISOString() }; };
  const scan = async () => classifyTakeoverProcesses(await listProcesses(), { platform, uid, ownBinary });
  async function prepare({ ports = [], proxyPort } = {}) {
    update("checking", { closed: [], reason: null });
    const deadline = Date.now() + 20000;
    const bounded = async action => {
      if (Date.now() >= deadline) throw new Error("网络交接等待超过 20 秒，请手动退出其他 VPN 后重试。");
      const result = await action();
      if (Date.now() >= deadline) throw new Error("网络交接等待超过 20 秒，请手动退出其他 VPN 后重试。");
      return result;
    };
    const command = (file, args) => bounded(() => exec(file, args));
    try {
      const initial = await bounded(scan);
      if (initial.clients.length) update("quitting");
      for (const client of initial.clients) {
        if (platform === "darwin") {
          await command("/usr/bin/osascript", ["-e", "on run argv\n if application (item 1 of argv) is running then\n tell application (item 1 of argv) to quit\n end if\nend run", client.target]);
        } else {
          const row = (await bounded(listProcesses)).find(p => p.pid === client.pid);
          if (!row || !classifyTakeoverProcesses([row], { platform, uid, ownBinary }).clients.length) continue;
          const expected = String(row.executable).replace(/'/g, "''");
          await command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; $p=Get-Process -Id ${client.pid} -ErrorAction SilentlyContinue; if($p){if($p.Path -ne '${expected}'){throw '进程已变化，请重试。'}; $null=$p.CloseMainWindow()}`]);
        }
      }
      update("waiting");
      let remaining;
      for (let i = 0; i < attempts; i++) {
        remaining = await bounded(scan);
        if (!remaining.clients.length && !remaining.kernels.some(k => k.client)) break;
        if (i + 1 < attempts) await pause(250);
      }
      if (remaining.clients.length || remaining.kernels.some(k => k.client)) {
        const names = [...new Set([...remaining.clients.map(c => c.label), ...remaining.kernels.filter(k => k.client).map(k => `${k.name}（PID ${k.pid}）`)])];
        throw new Error(`其他代理仍未退出：${names.join("、")}。请关闭其后台服务或自动重启，再重试接管。`);
      }
      if (platform === "darwin") {
        const vpn = await command("/usr/sbin/scutil", ["--nc", "list"]);
        if (/\(Connected\)|\(Connecting\)/i.test(vpn)) throw new Error("系统仍有已连接或正在连接的 VPN，请先断开后重试接管。");
        const route = await command("/sbin/route", ["-n", "get", "1.1.1.1"]);
        const name = route.match(/interface:\s*(\S+)/)?.[1];
        if (!name) throw new Error("未能确认当前默认出口，暂不启动隧道。");
        if (/^(?:utun|tun|tap|ppp|ipsec)\d*/i.test(name)) throw new Error(`其他隧道仍在接管出口（${name}），请先断开对应 VPN 后重试。`);
        const proxy = await command("/usr/sbin/scutil", ["--proxy"]);
        const value = key => proxy.match(new RegExp(`(?:^|\\n)\\s*${key}\\s*:\\s*([^\\n]+)`))?.[1].trim();
        if (value("ProxyAutoConfigEnable") === "1" || value("ProxyAutoDiscoveryEnable") === "1") throw new Error("系统自动代理仍启用，请先关闭 PAC/自动代理后重试接管。");
        for (const type of ["HTTP", "HTTPS", "SOCKS"]) {
          if (value(type + "Enable") !== "1") continue;
          if (!["127.0.0.1", "localhost", "::1"].includes(value(type + "Proxy")) || Number(value(type + "Port")) !== proxyPort) throw new Error(`系统 ${type} 代理仍指向其他工具，请先关闭该代理后重试接管。`);
        }
      }
      for (const port of new Set(ports)) {
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("待检查的内核端口无效。");
        if (!await bounded(() => canBind(port))) throw new Error(`端口 ${port} 仍被其他程序占用，暂不启动隧道。`);
      }
      update("ready", { closed: [...new Set(initial.clients.map(c => c.label))] });
      return { ...status };
    } catch (error) {
      update("blocked", { reason: `启动前网络交接失败：${error.message}` });
      throw new Error(status.reason);
    }
  }
  return { prepare, status: () => ({ ...status, closed: [...status.closed] }) };
}
