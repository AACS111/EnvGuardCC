// 本地代理工具探测：用户机器上往往已经装了 FlClash / Clash Verge / v2rayN 之类，
// 它们的混合端口能正常下载订阅、也能作为出口。EnvGuardCC 不该要求用户先卸掉它们，
// 而是识别出来「借用」——只读、只用本机端口，不读它们的配置、不改它们的设置。
//
// 识别方式（全部只用本机信息）：
//   1. 列出本机 TCP 监听端口与其 PID；
//   2. 按进程名过滤出已知代理客户端，排除本程序自己的端口；
//   3. 对候选端口做协议握手，确认它确实是 HTTP/SOCKS 代理，而不是随便一个服务。

import net from "node:net";
import { execFile } from "node:child_process";

const run = (command, args) => new Promise((resolve) => {
  execFile(command, args, { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
    resolve(error ? "" : String(stdout ?? ""));
  });
});

/** 已知代理客户端的进程名特征 → 展示名。 */
export const KNOWN_TOOLS = [
  { match: ["flclash"], label: "FlClash" },
  { match: ["clash-verge", "clashverge", "verge"], label: "Clash Verge" },
  { match: ["clash"], label: "Clash" },
  { match: ["mihomo"], label: "Mihomo" },
  { match: ["v2rayn", "v2ray"], label: "v2rayN" },
  { match: ["xray"], label: "Xray" },
  { match: ["sing-box", "singbox"], label: "sing-box" },
  { match: ["nekoray", "nekobox"], label: "NekoRay" },
  { match: ["hiddify"], label: "Hiddify" },
  { match: ["shadowsocks", "ss-local", "sslocal"], label: "Shadowsocks" },
  { match: ["qv2ray"], label: "Qv2ray" },
  { match: ["stash"], label: "Stash" },
  { match: ["karing"], label: "Karing" },
];

/** 本程序自己的端口不参与扫描：借用自己没有意义，还会形成环。 */
export const OWN_PORTS = new Set([39080, 39090, 39091, 1053, 9090]);

/** 由进程名判断是哪个代理工具；不是已知工具返回 null。 */
export function toolLabelFor(processName) {
  const name = String(processName ?? "").toLowerCase();
  if (!name) return null;
  const hit = KNOWN_TOOLS.find((tool) => tool.match.some((word) => name.includes(word)));
  return hit ? hit.label : null;
}

function parseWindowsPorts(output) {
  const rows = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
    if (match) rows.push({ port: Number(match[1]), pid: Number(match[2]) });
  }
  return rows;
}

function parseLsofPorts(output) {
  const rows = [];
  for (const line of output.split(/\r?\n/).slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 9) continue;
    const pid = Number(fields[1]);
    // NAME 形如 127.0.0.1:7890 (LISTEN)
    const name = fields.slice(8).join(" ");
    const port = Number((name.match(/:(\d+)\s*\(LISTEN\)/) ?? [])[1]);
    if (Number.isInteger(pid) && Number.isInteger(port)) rows.push({ port, pid });
  }
  return rows;
}

function parseSsPorts(output) {
  const rows = [];
  for (const line of output.split(/\r?\n/)) {
    const port = Number((line.match(/127\.0\.0\.1:(\d+)/) ?? [])[1]);
    const pid = Number((line.match(/pid=(\d+)/) ?? [])[1]);
    if (Number.isInteger(port) && Number.isInteger(pid)) rows.push({ port, pid });
  }
  return rows;
}

/** 列出本机 TCP 监听端口与 PID（只关注环回地址上的服务）。 */
export async function listListeningPorts({ platform = process.platform, exec = run } = {}) {
  if (platform === "win32") return parseWindowsPorts(await exec("netstat.exe", ["-ano", "-p", "TCP"]));
  if (platform === "darwin") return parseLsofPorts(await exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]));
  return parseSsPorts(await exec("ss", ["-ltnp"]));
}

/** 批量取进程名（Windows 一次 tasklist 比逐 PID 查询快得多）。 */
export async function processNames({ platform = process.platform, exec = run } = {}) {
  const map = new Map();
  if (platform === "win32") {
    for (const line of (await exec("tasklist.exe", ["/FO", "CSV", "/NH"])).split(/\r?\n/)) {
      const match = line.match(/^"([^"]+)","(\d+)"/);
      if (match) map.set(Number(match[2]), match[1]);
    }
    return map;
  }
  const output = await exec("ps", ["-eo", "pid=,comm="]);
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (match) map.set(Number(match[1]), match[2].split(/[\\/]/).pop());
  }
  return map;
}

/** SOCKS5 握手：只发问候，不发起转发。 */
function probeSocks5(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(null));
    socket.once("error", () => finish(null));
    socket.once("connect", () => socket.write(Buffer.from([0x05, 0x01, 0x00])));
    socket.once("data", (chunk) => finish(chunk.length >= 2 && chunk[0] === 0x05 ? "socks5" : null));
  });
}

/** HTTP 代理探测：发一个 CONNECT，看它是否按代理协议应答。 */
function probeHttp(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let buffer = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(null));
    socket.once("error", () => finish(null));
    socket.once("connect", () => socket.write("CONNECT www.gstatic.com:443 HTTP/1.1\r\nHost: www.gstatic.com:443\r\n\r\n"));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      const match = buffer.match(/^HTTP\/1\.[01] (\d{3})/);
      if (!match) return;
      const status = Number(match[1]);
      // 200 = 隧道建立；407 = 需要认证，同样是 HTTP 代理。
      finish(status === 200 || status === 407 ? "http" : null);
    });
  });
}

/** 探测端口协议；两种都不是则返回 null（说明只是碰巧在监听）。 */
export async function probeProxyPort(port, { probes = { socks5: probeSocks5, http: probeHttp } } = {}) {
  const socks = await probes.socks5(port).catch(() => null);
  if (socks) return socks;
  return await probes.http(port).catch(() => null);
}

/**
 * 扫描本机可借用的代理端口。
 * @returns {Promise<Array<{port:number, pid:number, process:string, tool:string, protocol:string}>>}
 */
export async function scanLocalProxies({ platform = process.platform, exec = run, probes, ports } = {}) {
  const own = ports ?? await listListeningPorts({ platform, exec });
  const candidates = own.filter((row) => !OWN_PORTS.has(row.port));
  if (!candidates.length) return [];
  const names = await processNames({ platform, exec });
  const seen = new Set();
  const result = [];
  for (const row of candidates) {
    if (seen.has(row.port)) continue;
    const processName = names.get(row.pid) ?? "";
    const tool = toolLabelFor(processName);
    // 只认已知代理客户端：不能把任意本机服务当成代理去发订阅令牌。
    if (!tool) continue;
    const protocol = await probeProxyPort(row.port, { probes: probes ?? { socks5: probeSocks5, http: probeHttp } }).catch(() => null);
    if (!protocol) continue;
    seen.add(row.port);
    result.push({ port: row.port, pid: row.pid, process: processName, tool, protocol });
  }
  return result.sort((a, b) => a.port - b.port);
}

/** 展示用：本地代理列表摘要。 */
export function describeLocalProxies(list) {
  return (Array.isArray(list) ? list : []).map((item) => `${item.tool}（${item.protocol} 端口 ${item.port}）`).join("、") || "未发现本地代理";
}
