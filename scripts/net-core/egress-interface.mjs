// 显式探测「当前真正可用的默认出口网卡」，供 TUN 配置的 interface-name 使用。
//
// 背景：mihomo 的 auto-detect-interface 依赖系统“最佳接口”查询（Windows 上是
// GetBestInterfaceEx）。当系统里残留一条「指向已断开网卡」的默认路由时，查询会返回
// 那张没有链路的网卡，内核拿到空接口名 / <invalid>，表现为所有节点拨号 i/o timeout
// （实机日志曾出现 1254 次），而同一节点的 UDP 链路却正常，极易误判为服务器故障。
//
// 这里按路由优先级挑出第一张状态真正 Up 的物理网卡，写进 tun.interface-name，
// 让内核不再依赖可能被脏路由带偏的自动探测。探测失败时返回 null，保持原行为。
//
import { execFile } from "node:child_process";
import { readFile as readFileAsync } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// 内核自己的 TUN / 代理虚拟网卡不能当物理出口，否则会形成回环。
const VIRTUAL_INTERFACE = /^(?:Meta|utun\d*|tun\d+|mihomo|wintun|FlClash|cfw-tap|TAP-Windows)/i;

const WINDOWS_PROBE = [
  "$ErrorActionPreference='Stop'",
  "$routes = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object InterfaceMetric,RouteMetric",
  "$items = foreach ($r in $routes) {",
  "  $a = Get-NetAdapter -InterfaceIndex $r.ifIndex -ErrorAction SilentlyContinue",
  "  if (-not $a) { continue }",
  "  [pscustomobject]@{ name=$a.Name; metric=[int]$r.InterfaceMetric; status=[string]$a.Status; link=[string]$a.MediaConnectionState }",
  "}",
  "if ($items) { $items | ConvertTo-Json -Compress } else { '[]' }",
].join("\n");

function pickWindows(rows) {
  for (const row of (Array.isArray(rows) ? rows : rows ? [rows] : [])) {
    const name = typeof row?.name === "string" ? row.name.trim() : "";
    if (!name || VIRTUAL_INTERFACE.test(name)) continue;
    if (String(row?.status).toLowerCase() !== "up") continue;
    if (String(row?.link).toLowerCase() !== "connected") continue;
    return { name, metric: Number.isFinite(Number(row?.metric)) ? Number(row.metric) : null };
  }
  return null;
}

function darwinInterface(routeText) {
  const match = /^interface:\s*(\S+)/m.exec(String(routeText ?? ""));
  if (!match || VIRTUAL_INTERFACE.test(match[1])) return null;
  return match[1];
}

function pickDarwin(routeText, ifconfigText) {
  const name = darwinInterface(routeText);
  if (!name) return null;
  return /status:\s*active/i.test(String(ifconfigText ?? "")) ? { name, metric: null } : null;
}

// /proc/net/route 的 Metric 字段在第 7 列；只取 Destination 为 0 的默认路由，按 metric 升序。
function linuxDefaultInterfaces(table) {
  return String(table ?? "").split("\n").slice(1)
    .map(line => line.trim().split(/\s+/))
    .filter(cols => cols.length > 7 && cols[1] === "00000000")
    .sort((a, b) => Number(a[6]) - Number(b[6]))
    .map(cols => ({ name: cols[0], metric: Number(cols[6]) || null }))
    .filter(item => item.name && !VIRTUAL_INTERFACE.test(item.name));
}

/**
 * 异步探测：不阻塞事件循环，运行时使用。
 * @returns {Promise<{ name: string, metric?: number|null } | null>}
 */
export async function detectEgressInterfaceAsync({
  platform = process.platform,
  exec = execFileAsync,
  read = readFileAsync,
} = {}) {
  try {
    if (platform === "win32") {
      const { stdout } = await exec("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROBE,
      ], { encoding: "utf8", timeout: 8000, windowsHide: true });
      const raw = String(stdout ?? "").trim();
      return pickWindows(raw ? JSON.parse(raw) : []);
    }
    if (platform === "darwin") {
      const { stdout: route } = await exec("route", ["-n", "get", "default"], { encoding: "utf8", timeout: 3000 });
      const name = darwinInterface(route);
      if (!name) return null;
      const { stdout: status } = await exec("ifconfig", [name], { encoding: "utf8", timeout: 3000 });
      return pickDarwin(route, status);
    }
    if (platform === "linux") {
      const table = await read("/proc/net/route", "utf8");
      for (const item of linuxDefaultInterfaces(table)) {
        try {
          if (String(await read(`/sys/class/net/${item.name}/operstate`, "utf8")).trim() === "up") return item;
        } catch {
          // 网卡在枚举后消失，继续看下一条。
        }
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * 运行时探测器：
 * - peek()：只读缓存，不触发任何命令（配置生成用这个，绝不阻塞交互路径）；
 * - warm()：异步刷新缓存，可重复调用（并发合并）；网络变化时 invalidate()。
 */
export function createEgressInterfaceResolver({
  ttlMs = 30_000,
  now = Date.now,
  detectAsync = detectEgressInterfaceAsync,
} = {}) {
  let cachedAt = -Infinity;
  let cached = null;
  let inflight = null;
  const fresh = () => now() - cachedAt < ttlMs;

  const peek = () => (fresh() ? cached : null);

  const warm = () => {
    if (fresh()) return Promise.resolve(cached);
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        cached = (await detectAsync()) ?? null;
      } catch {
        cached = null;
      }
      cachedAt = now();
      inflight = null;
      return cached;
    })();
    return inflight;
  };

  return {
    peek,
    warm,
    invalidate() {
      cachedAt = -Infinity;
      cached = null;
    },
  };
}
